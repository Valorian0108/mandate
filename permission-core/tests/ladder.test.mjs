// Layer D ladder tests.
//
// The ladder is where a record turns into permission, so the tests focus on the
// two ways that could go wrong:
//   1. evidence that has not earned a step (too few records, sandbox-only for a
//      real step, recent violations) must not suggest one;
//   2. a promotion must be owner-signed AND bound to the exact evidence root.
//      A wrong key, a wrong root, or a broken transition leaves the agent where
//      it was.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStarkKey } from '@scure/starknet';

import { evidenceDigest, merkleRoot } from '../src/evidence.mjs';
import {
  createLadderStore, currentStage, ladderChangeDigest, PROFILES, signLadderChange,
  suggestNext, summarise, validateTransition, verifyLadderChange,
} from '../src/ladder.mjs';
import { signMandateAction } from '../web/typed-data.js';

const OWNER_PRIV = '0x1';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const ATTACKER_PRIV = '0x3';
const ATTACKER_PUB = getStarkKey(ATTACKER_PRIV);
const AGENT = '0xabc123';
const GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const CHAIN = 'SN_SEPOLIA';
const NOW = 1_800_000_000_000;

function records(outcomes) {
  return outcomes.map((outcome, i) => ({
    version: 1,
    agentId: AGENT,
    seq: i + 1,
    at: NOW - 1000 + i,
    domain: 'spend',
    action: 'spend:transfer',
    outcome,
    facts: { amount: String(i + 1), code: 'within-mandate' },
    witness: '0x1',
    signature: { r: '0x1', s: '0x1' },
  }));
}

const rootOf = (recs) => merkleRoot(recs.map(evidenceDigest));

function change(overrides = {}) {
  return signLadderChange({
    version: 1,
    kind: 'ladder-change',
    agentId: AGENT,
    seq: 1,
    from: 'new',
    to: 'probation',
    reason: '3 clean sandbox records',
    evidenceRoot: rootOf(records(['sandbox-allowed', 'sandbox-allowed', 'sandbox-allowed'])),
    evidenceCount: 3,
    at: NOW,
    owner: OWNER_PUB,
    ...overrides,
  }, overrides.signWith ?? OWNER_PRIV);
}

// ---------------------------------------------------------------- summaries

test('summarise separates clean, real, sandbox, asked, and strikes', () => {
  const summary = summarise(records([
    'executed', 'executed', 'approved', 'sandbox-allowed', 'asked',
    'blocked', 'declined', 'sandbox-asked', 'sandbox-blocked',
  ]));
  assert.deepEqual(summary, {
    total: 9, clean: 4, realClean: 3, sandboxClean: 1,
    asked: 2, strikes: 2, recentStrikes: 2,
  });
});

test('a new agent earns probation from three sandbox records, not two', () => {
  const three = summarise(records(['sandbox-allowed', 'sandbox-allowed', 'sandbox-allowed']));
  assert.deepEqual(suggestNext('new', three), {
    to: 'probation', reason: '3 clean actions (sandbox counts for this first step)',
  });
  const two = summarise(records(['sandbox-allowed', 'sandbox-allowed']));
  assert.equal(suggestNext('new', two), null);
});

test('sandbox records cannot earn a real step above probation', () => {
  const sandboxOnly = summarise(records(Array(30).fill('sandbox-allowed')));
  assert.equal(suggestNext('probation', sandboxOnly), null);
  const real = summarise(records(Array(10).fill('executed')));
  assert.deepEqual(suggestNext('probation', real), { to: 'trusted', reason: '10 clean real actions' });
});

test('three strikes suggest restriction; a recent strike blocks promotion', () => {
  const strikes = summarise(records(['blocked', 'blocked', 'blocked']));
  assert.equal(suggestNext('probation', strikes).to, 'restricted');

  const recent = summarise(records([
    ...Array(10).fill('executed'), 'blocked',
  ]));
  assert.equal(recent.recentStrikes, 1);
  assert.equal(suggestNext('probation', recent), null);
});

test('a restricted agent needs three clean REAL actions to be reinstated', () => {
  const sandbox = summarise(records(['sandbox-allowed', 'sandbox-allowed', 'sandbox-allowed']));
  assert.equal(suggestNext('restricted', sandbox), null);
  const real = summarise(records(['executed', 'executed', 'executed']));
  assert.equal(suggestNext('restricted', real).to, 'probation');
});

test('transitions cannot skip a stage', () => {
  assert.equal(validateTransition('new', 'probation').ok, true);
  assert.equal(validateTransition('new', 'trusted').ok, false);
  assert.equal(validateTransition('probation', 'established').ok, false);
  assert.equal(validateTransition('trusted', 'established').ok, true);
  assert.equal(validateTransition('established', 'restricted').ok, true);
  assert.equal(validateTransition('restricted', 'probation').ok, true);
  assert.equal(validateTransition('restricted', 'trusted').ok, false);
});

test('the permission profiles are concrete, not vibes', () => {
  assert.equal(PROFILES.new.autoSpendPerCall, 0n);
  assert.equal(PROFILES.probation.autoSpendPerCall, 5n);
  assert.equal(PROFILES.probation.autoSpendPerWindow, 20n);
  assert.equal(PROFILES.trusted.autoSpendPerCall, null); // live mandate
  assert.equal(PROFILES.established.canShare, true);
  assert.equal(PROFILES.restricted.autoSpendPerCall, 0n);
});

// ---------------------------------------------------------------- signed changes

test('an owner-signed change binds to the exact evidence root', () => {
  const recs = records(['sandbox-allowed', 'sandbox-allowed', 'sandbox-allowed']);
  const c = change({ evidenceRoot: rootOf(recs) });
  assert.equal(verifyLadderChange(c, OWNER_PUB), true);
  assert.equal(verifyLadderChange(c, ATTACKER_PUB), false);

  const tampered = { ...c, evidenceRoot: rootOf(recs.slice(0, 2)) };
  assert.equal(verifyLadderChange(tampered, OWNER_PUB), false);
});

test('a typed-data ladder change is bound to its kind, chain and account', () => {
  const c = change();
  const digest = ladderChangeDigest(c);
  const context = { kind: 'ladder-change', accountAddress: GATE, chainId: CHAIN };
  const envelope = signMandateAction({
    chainId: CHAIN,
    accountAddress: GATE,
    kind: 'ladder-change',
    digest,
    note: 'Move the agent from new to probation: 3 clean sandbox records.',
    privateKey: OWNER_PRIV,
  });
  const signed = { ...c, signature: envelope };

  assert.equal(verifyLadderChange(signed, OWNER_PUB, context), true);
  assert.equal(verifyLadderChange(signed, OWNER_PUB, { ...context, chainId: 'SN_MAIN' }), false);
  assert.equal(verifyLadderChange(signed, OWNER_PUB, { ...context, accountAddress: '0x1234' }), false);
  assert.equal(verifyLadderChange(signed, OWNER_PUB, { ...context, kind: 'resolution' }), false);

  const otherDigest = signMandateAction({
    chainId: CHAIN, accountAddress: GATE, kind: 'ladder-change',
    digest: ladderChangeDigest({ ...c, to: 'trusted' }),
    note: 'A different change.', privateKey: OWNER_PRIV,
  });
  assert.equal(verifyLadderChange({ ...c, signature: otherDigest }, OWNER_PUB, context), false);
});

test('the ladder change digest is deterministic and tamper-sensitive', () => {
  const c = change();
  assert.equal(ladderChangeDigest(c), ladderChangeDigest({ ...c }));
  assert.notEqual(ladderChangeDigest(c), ladderChangeDigest({ ...c, to: 'restricted' }));
});

test('currentStage applies a valid promotion and rejects a broken one', () => {
  const recs = records(['sandbox-allowed', 'sandbox-allowed', 'sandbox-allowed']);
  const good = change({ evidenceRoot: rootOf(recs) });
  assert.equal(currentStage({
    agentId: AGENT, changes: [good], ownerPublicKey: OWNER_PUB, records: recs,
  }).stage, 'probation');

  const wrongRoot = change({ evidenceRoot: rootOf(recs.slice(0, 2)), evidenceCount: 3 });
  const rejected = currentStage({
    agentId: AGENT, changes: [wrongRoot], ownerPublicKey: OWNER_PUB, records: recs,
  });
  assert.equal(rejected.stage, 'new');
  assert.match(rejected.rejected[0].reason, /root does not match/);

  const wrongKey = change({ signWith: ATTACKER_PRIV, owner: ATTACKER_PUB });
  assert.equal(currentStage({
    agentId: AGENT, changes: [wrongKey], ownerPublicKey: OWNER_PUB, records: recs,
  }).stage, 'new');

  const outOfOrder = change({ from: 'probation', to: 'trusted', evidenceCount: 3 });
  assert.equal(currentStage({
    agentId: AGENT, changes: [outOfOrder], ownerPublicKey: OWNER_PUB, records: recs,
  }).stage, 'new');
});

test('currentStage walks two valid steps in order', () => {
  const recs = records([
    ...Array(3).fill('sandbox-allowed'),
    ...Array(10).fill('executed'),
  ]);
  const first = change({
    seq: 1, evidenceCount: 3, evidenceRoot: rootOf(recs.slice(0, 3)),
  });
  const second = change({
    seq: 2, from: 'probation', to: 'trusted', evidenceCount: 13,
    evidenceRoot: rootOf(recs.slice(0, 13)), reason: '10 clean real actions',
  });
  const state = currentStage({
    agentId: AGENT, changes: [first, second], ownerPublicKey: OWNER_PUB, records: recs,
  });
  assert.equal(state.stage, 'trusted');
  assert.equal(state.applied.length, 2);
});

// ---------------------------------------------------------------- store

test('the ladder store enforces order, signatures, and transitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-test-'));
  const filePath = join(dir, 'ladder.json');
  const store = createLadderStore({ filePath, now: () => NOW });
  const recs = records(['sandbox-allowed', 'sandbox-allowed', 'sandbox-allowed']);
  const first = change({ evidenceRoot: rootOf(recs) });
  store.append(first);
  assert.equal(store.verifyAll().ok, true);

  assert.throws(() => store.append(change({ seq: 3 })), /must be 2/);
  assert.throws(() => store.append(change({
    seq: 2, from: 'trusted', to: 'established', evidenceRoot: rootOf(recs),
  })), /agent is 'probation'/);

  const wrongSignature = change({
    seq: 2, from: 'probation', to: 'trusted', signWith: ATTACKER_PRIV,
  });
  assert.throws(() => store.append(wrongSignature), /signature does not verify/);
});
