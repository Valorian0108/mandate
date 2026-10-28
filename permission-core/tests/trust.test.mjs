// Layer D trust tests: the part that sits between the agent and the gate.
//
// Each test is an OBS-08 test: the thing under test is the ONLY barrier between
// a valid-looking action and a successful one. The cases are chosen to catch the
// ways a trust layer usually turns into theater:
//
//   - the identity is not signed by the key the CHAIN reports;
//   - evidence was signed by a different app, or edited after the fact;
//   - a promotion was signed by the wrong key, or binds a root that no longer
//     matches the records;
//   - a stage limit silently disappears (cold start, per-call, per-window,
//     deletes, sharing);
//   - the door claims `executed` without a receipt, or writes evidence when the
//     app's action threw.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStarkKey } from '@scure/starknet';

import {
  createEvidenceStore, evidenceDigest, merkleRoot, signIdentity,
} from '../src/evidence.mjs';
import {
  createLadderStore, signLadderChange,
} from '../src/ladder.mjs';
import { createTrust } from '../src/trust.mjs';
import { createClient } from '../src/sdk.mjs';

const OWNER_PRIV = '0x1';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const WITNESS_PRIV = '0x2';
const WITNESS_PUB = getStarkKey(WITNESS_PRIV);
const ATTACKER_PRIV = '0x3';
const ATTACKER_PUB = getStarkKey(ATTACKER_PRIV);

const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const STRANGER = '0x16cb41ec11efcc9129d858ae07449f4f1a31d7d292269a5e7c40cd4d33db371';

const NOW = 1_800_000_000_000;
const WINDOW_START = 1_792_900_709;
const WINDOW_SECONDS = 2_592_000;
const IN_WINDOW = WINDOW_START + 1000;

function fakeMandate(overrides = {}) {
  return {
    sessionPublicKey: WITNESS_PUB,
    validUntil: 2_000_000_000,
    maxCalls: 10,
    callsUsed: 0,
    allowedSelectors: ['0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e'],
    token: TOKEN,
    maxPerCall: 20,
    maxPerWindow: 100,
    windowSeconds: WINDOW_SECONDS,
    spentInWindow: 0,
    windowStart: WINDOW_START,
    allowedRecipients: [MERCHANT],
    ...overrides,
  };
}

const spend = (amount, ctx = {}) => ({
  user: 'user:t',
  agent: 'agent:t',
  action: 'spend:transfer',
  resource: `token:${TOKEN}`,
  context: { recipient: MERCHANT, amount, token: TOKEN, now: IN_WINDOW, ...ctx },
});

const remove = (path, ctx = {}) => ({
  user: 'user:t',
  agent: 'agent:t',
  action: 'files:delete',
  resource: `file:${path}`,
  context: { path, ...ctx },
});

const share = (path) => ({
  user: 'user:t',
  agent: 'agent:t',
  action: 'files:share',
  resource: `file:${path}`,
  context: { path },
});

function makeIdentity(overrides = {}) {
  return signIdentity({
    owner: OWNER_PUB,
    purpose: 'travel booking',
    nonce: '0x1',
    createdAt: NOW - 1000,
    ...overrides,
  }, overrides.signWith ?? OWNER_PRIV);
}

function setup({ identity = makeIdentity(), ownerPublicKey = OWNER_PUB } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trust-test-'));
  const evidencePath = join(dir, 'evidence.json');
  const ladderPath = join(dir, 'ladder.json');
  const trust = createTrust({
    identity,
    witnessPrivateKey: WITNESS_PRIV,
    evidencePath,
    ladderPath,
    readOwnerKey: async () => ownerPublicKey,
    now: () => NOW,
  });
  return { dir, identity, evidencePath, ladderPath, trust };
}

// Append an owner-signed ladder change bound to the records currently on disk.
// `rootOverride` exists so a test can sign a change that LOOKS valid but binds
// the wrong evidence root - the exact attack currentStage must reject.
function appendChange({
  identity, evidencePath, ladderPath, from, to,
  reason = 'the owner reviewed the evidence',
  evidenceCount, rootOverride,
}) {
  const evidence = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  const records = evidence.list(identity.agentId);
  const count = evidenceCount ?? records.length;
  const root = rootOverride ?? merkleRoot(records.slice(0, count).map(evidenceDigest));
  const ladder = createLadderStore({ filePath: ladderPath, now: () => NOW });
  const seq = ladder.list(identity.agentId).length + 1;
  const change = signLadderChange({
    version: 1,
    kind: 'ladder-change',
    agentId: identity.agentId,
    seq,
    from,
    to,
    reason,
    evidenceRoot: root,
    evidenceCount: count,
    at: NOW,
    owner: OWNER_PUB,
  }, OWNER_PRIV);
  ladder.append(change);
  return change;
}

function seedSandbox(trust, times = 3) {
  const decision = { verdict: 'ALLOW', code: 'within-mandate', reason: 'within the live mandate' };
  const records = [];
  for (let i = 0; i < times; i += 1) {
    records.push(trust.record(spend(5), decision, { sandbox: true }));
  }
  return records;
}

// ---------------------------------------------------------------- load

test('a fresh agent loads as new, with a zero root and no records', async () => {
  const { trust } = setup();
  const state = await trust.load();
  assert.equal(state.ok, true);
  assert.equal(state.stage, 'new');
  assert.equal(state.count, 0);
  assert.equal(state.root, '0x' + '0'.repeat(64));
  assert.deepEqual(state.records, []);
  assert.deepEqual(state.applied, []);
});

test('an identity signed by anyone but the chain owner is refused', async () => {
  const { trust } = setup({ ownerPublicKey: ATTACKER_PUB });
  const state = await trust.load();
  assert.equal(state.ok, false);
  assert.equal(state.error, 'identity-unverified');
  assert.match(state.reason, /not signed by the owner key the chain reports/);
});

test('an identity whose purpose was edited after signing is refused', async () => {
  const identity = { ...makeIdentity(), purpose: 'drain the account' };
  const { trust } = setup({ identity });
  const state = await trust.load();
  assert.equal(state.ok, false);
  assert.equal(state.error, 'identity-unverified');
});

// ---------------------------------------------------------------- cold start

test('a new agent is asked about every spend and file action, and only those', async () => {
  const { trust } = setup();
  const state = await trust.load();
  const mandate = fakeMandate();

  for (const request of [spend(5), remove('/tmp/a'), share('/tmp/a')]) {
    const blocked = trust.precheck(request, state, mandate);
    assert.equal(blocked.verdict, 'ASK_USER');
    assert.equal(blocked.code, 'cold-start');
    assert.equal(blocked.gate, 'trust');
  }
  assert.equal(trust.precheck({ ...spend(5), action: 'notes:write' }, state, mandate), null);
  assert.equal(trust.precheck({ ...spend(5), action: 'transfer' }, state, mandate), null);
});

// ---------------------------------------------------------------- evidence recording

test('recording is conservative: no receipt means no claim of execution', async () => {
  const { trust } = setup();
  const allow = { verdict: 'ALLOW', code: 'within-mandate', reason: 'within the live mandate' };
  const deny = { verdict: 'DENY', code: 'recipient-not-allowed', reason: 'recipient not allowed' };
  const ask = { verdict: 'ASK_USER', code: 'approval-required', reason: 'needs approval' };

  assert.equal(trust.record(spend(5), allow), null);
  assert.equal(trust.record(spend(5), allow, { receipt: { txHash: '0xabc' } }).outcome, 'executed');
  assert.equal(trust.record(spend(5), deny).outcome, 'blocked');
  assert.equal(trust.record(spend(5), ask).outcome, 'asked');
  assert.equal(trust.record(spend(5), allow, { sandbox: true }).outcome, 'sandbox-allowed');
  assert.equal(trust.record(spend(5), deny, { sandbox: true }).outcome, 'sandbox-blocked');
  assert.equal(trust.record(spend(5), ask, { sandbox: true }).outcome, 'sandbox-asked');

  const state = await trust.load();
  assert.equal(state.count, 6); // the no-receipt ALLOW wrote nothing
  assert.equal(state.summary.realClean, 1);
  assert.equal(state.summary.sandboxClean, 1);
});

// ---------------------------------------------------------------- promotion

test('three sandbox records are suggested as a first step; the owner signs it', async () => {
  const { identity, evidencePath, ladderPath, trust } = setup();
  seedSandbox(trust, 3);

  const before = await trust.load();
  assert.equal(before.stage, 'new');
  assert.equal(before.count, 3);
  assert.deepEqual(before.suggestion, {
    to: 'probation', reason: '3 clean actions (sandbox counts for this first step)',
  });

  appendChange({
    identity, evidencePath, ladderPath, from: 'new', to: 'probation',
    reason: 'three clean sandbox runs',
  });
  const after = await trust.load();
  assert.equal(after.stage, 'probation');
  assert.equal(after.applied.length, 1);
  assert.deepEqual(after.rejected, []);
});

test('a promotion signed by the wrong key leaves the agent where it was', async () => {
  const { identity, evidencePath, ladderPath, trust } = setup();
  seedSandbox(trust, 3);

  const evidence = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  const records = evidence.list(identity.agentId);
  const change = signLadderChange({
    version: 1,
    kind: 'ladder-change',
    agentId: identity.agentId,
    seq: 1,
    from: 'new',
    to: 'probation',
    reason: 'self-promotion attempt',
    evidenceRoot: merkleRoot(records.map(evidenceDigest)),
    evidenceCount: 3,
    at: NOW,
    owner: ATTACKER_PUB,
  }, ATTACKER_PRIV);
  createLadderStore({ filePath: ladderPath, now: () => NOW }).append(change);

  const state = await trust.load();
  assert.equal(state.stage, 'new');
  assert.match(state.rejected[0].reason, /signature does not verify/);
});

test('a promotion bound to the wrong evidence root is rejected, loudly', async () => {
  const { identity, evidencePath, ladderPath, trust } = setup();
  seedSandbox(trust, 3);

  const evidence = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  const records = evidence.list(identity.agentId);
  appendChange({
    identity, evidencePath, ladderPath, from: 'new', to: 'probation',
    evidenceCount: 2,
    rootOverride: merkleRoot(records.slice(0, 3).map(evidenceDigest)),
  });

  const state = await trust.load();
  assert.equal(state.stage, 'new');
  assert.match(state.rejected[0].reason, /evidence root does not match the records/);
});

test('editing a record after the promotion invalidates the promotion', async () => {
  const { identity, evidencePath, ladderPath, trust } = setup();
  seedSandbox(trust, 3);
  appendChange({
    identity, evidencePath, ladderPath, from: 'new', to: 'probation',
    reason: 'three clean sandbox runs',
  });
  assert.equal((await trust.load()).stage, 'probation');

  const db = JSON.parse(readFileSync(evidencePath, 'utf8'));
  db.records[0].facts.context.amount = 5000;
  writeFileSync(evidencePath, JSON.stringify(db, null, 2));

  const state = await trust.load();
  assert.equal(state.ok, false);
  assert.equal(state.error, 'evidence-unverified');
  assert.match(state.reason, /signature does not verify/);
});

test('evidence signed by a different app witness is refused', async () => {
  const { identity, evidencePath, trust } = setup();
  const store = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  const { signEvidence } = await import('../src/evidence.mjs');
  store.append(signEvidence({
    version: 1,
    agentId: identity.agentId,
    seq: 1,
    at: NOW - 10,
    domain: 'spend',
    action: 'spend:transfer',
    outcome: 'sandbox-allowed',
    facts: { amount: '5' },
    witness: ATTACKER_PUB,
  }, ATTACKER_PRIV));

  const state = await trust.load();
  assert.equal(state.ok, false);
  assert.equal(state.error, 'evidence-witness-mismatch');
  assert.match(state.reason, /signed by .* not this app's witness/);
});

// ---------------------------------------------------------------- stage caps

test('probation narrows spending, deletes, and sharing', async () => {
  const { identity, evidencePath, ladderPath, trust } = setup();
  seedSandbox(trust, 3);
  appendChange({
    identity, evidencePath, ladderPath, from: 'new', to: 'probation',
    reason: 'three clean sandbox runs',
  });
  const state = await trust.load();
  const mandate = fakeMandate();

  assert.equal(state.profile.autoSpendPerCall, 5n);
  assert.equal(trust.precheck(spend(5), state, mandate), null);
  assert.equal(trust.precheck(spend(6), state, mandate).code, 'ladder-cap');
  assert.match(trust.precheck(spend(6), state, mandate).reason, /at most 5 per call/);

  assert.equal(trust.precheck(spend(2, { now: IN_WINDOW }), state,
    fakeMandate({ spentInWindow: 17 })), null);
  assert.equal(trust.precheck(spend(2, { now: IN_WINDOW }), state,
    fakeMandate({ spentInWindow: 19 })).code, 'ladder-window');

  // A new window resets the window tally, exactly like the chain does.
  assert.equal(trust.precheck(spend(2, { now: WINDOW_START + WINDOW_SECONDS }), state,
    fakeMandate({ spentInWindow: 19 })), null);

  assert.equal(trust.precheck(remove('/tmp/a'), state, mandate), null); // the files gate owns the count
  assert.equal(trust.precheck(share('/tmp/a'), state, mandate).code, 'ladder-share');

  const overlay = trust.overlayPolicies({
    files: { protectedPaths: [], maxDeletesPerDay: 10, deletesToday: 0, shareRequiresApproval: false },
  }, state);
  assert.equal(overlay.files.maxDeletesPerDay, 1);
  assert.equal(overlay.files.shareRequiresApproval, true);
});

test('trusted uses the live mandate and allows three deletes, no sharing', async () => {
  const { identity, evidencePath, ladderPath, trust } = setup();
  seedSandbox(trust, 3);
  const decision = { verdict: 'ALLOW', code: 'within-mandate', reason: 'ok' };
  for (let i = 0; i < 10; i += 1) trust.record(spend(5), decision, { receipt: { n: i } });
  appendChange({
    identity, evidencePath, ladderPath, from: 'new', to: 'probation',
    reason: 'three clean sandbox runs', evidenceCount: 3,
  });
  appendChange({
    identity, evidencePath, ladderPath, from: 'probation', to: 'trusted',
    reason: 'ten clean real actions', evidenceCount: 13,
  });
  const state = await trust.load();
  assert.equal(state.stage, 'trusted');
  assert.equal(state.profile.autoSpendPerCall, null);

  assert.equal(trust.precheck(spend(20), state, fakeMandate()), null);
  assert.equal(trust.precheck(share('/tmp/a'), state, fakeMandate()).code, 'ladder-share');
  const overlay = trust.overlayPolicies({
    files: { maxDeletesPerDay: 10, shareRequiresApproval: false },
  }, state);
  assert.equal(overlay.files.maxDeletesPerDay, 3);
});

test('established allows sharing and ten deletes; restricted asks about everything', async () => {
  const { identity, evidencePath, ladderPath, trust } = setup();
  seedSandbox(trust, 3);
  const decision = { verdict: 'ALLOW', code: 'within-mandate', reason: 'ok' };
  for (let i = 0; i < 25; i += 1) trust.record(spend(5), decision, { receipt: { n: i } });
  appendChange({ identity, evidencePath, ladderPath, from: 'new', to: 'probation', reason: 'first step', evidenceCount: 3 });
  appendChange({ identity, evidencePath, ladderPath, from: 'probation', to: 'trusted', reason: 'ten real actions', evidenceCount: 13 });
  appendChange({ identity, evidencePath, ladderPath, from: 'trusted', to: 'established', reason: 'twenty-five real actions', evidenceCount: 28 });

  const state = await trust.load();
  assert.equal(state.stage, 'established');
  assert.equal(trust.precheck(share('/tmp/a'), state, fakeMandate()), null);
  const overlay = trust.overlayPolicies({
    files: { maxDeletesPerDay: 50, shareRequiresApproval: false },
  }, state);
  assert.equal(overlay.files.maxDeletesPerDay, 10);
  assert.equal(overlay.files.shareRequiresApproval, false);

  // Three violations move the suggestion to restricted; the owner signs it.
  for (let i = 0; i < 3; i += 1) {
    trust.record(spend(5), { verdict: 'DENY', code: 'recipient-not-allowed', reason: 'no' });
  }
  const before = await trust.load();
  assert.equal(before.suggestion.to, 'restricted');
  appendChange({ identity, evidencePath, ladderPath, from: 'established', to: 'restricted', reason: 'three violations' });
  const restricted = await trust.load();
  assert.equal(restricted.stage, 'restricted');
  assert.equal(trust.precheck(spend(5), restricted, fakeMandate()).code, 'restricted');
  assert.equal(trust.precheck(remove('/tmp/a'), restricted, fakeMandate()).code, 'restricted');
});

// ---------------------------------------------------------------- door integration

function doorSetup({ stage = 'new', deletesToday = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trust-door-'));
  const identity = makeIdentity();
  const evidencePath = join(dir, 'evidence.json');
  const ladderPath = join(dir, 'ladder.json');
  const storePath = join(dir, 'proposals.json');

  const trust = createTrust({
    identity, witnessPrivateKey: WITNESS_PRIV, evidencePath, ladderPath,
    readOwnerKey: async () => OWNER_PUB, now: () => NOW,
  });
  if (stage !== 'new') {
    seedSandbox(trust, 3);
    appendChange({
      identity, evidencePath, ladderPath, from: 'new', to: 'probation',
      reason: 'three clean sandbox runs',
    });
  }

  let reads = 0;
  const client = createClient({
    storePath,
    evidencePath,
    ladderPath,
    identity,
    witnessPrivateKey: WITNESS_PRIV,
    now: () => NOW,
    readMandate: async () => { reads += 1; return fakeMandate(); },
    readOwnerKey: async () => OWNER_PUB,
    policies: {
      files: { protectedPaths: ['/secrets'], maxDeletesPerDay: 10, deletesToday, shareRequiresApproval: false },
    },
  });
  return { client, identity, evidencePath, ladderPath, storePath, trust, reads: () => reads };
}

test('the door refuses to start with half of Layer D', () => {
  assert.throws(() => createClient({
    identity: makeIdentity(), readMandate: async () => fakeMandate(),
    readOwnerKey: async () => OWNER_PUB, storePath: join(tmpdir(), 'x.json'),
  }), /identity needs the app witness private key/);
  assert.throws(() => createClient({
    witnessPrivateKey: WITNESS_PRIV, readMandate: async () => fakeMandate(),
    readOwnerKey: async () => OWNER_PUB, storePath: join(tmpdir(), 'x.json'),
  }), /witness key needs an identity/);
});

test('cold start turns a would-be ALLOW into a proposal and an asked record', async () => {
  const { client, trust } = doorSetup();
  const result = await client.execute(spend(5));
  assert.equal(result.allowed, false);
  assert.equal(result.decision.verdict, 'ASK_USER');
  assert.equal(result.decision.code, 'cold-start');
  assert.ok(result.proposal);
  assert.equal(result.proposal.status, 'PENDING');
  assert.equal(result.evidence.outcome, 'asked');

  const state = await trust.load();
  assert.equal(state.count, 1);
});

test('sandbox bypasses cold start, records the simulation, and moves nothing', async () => {
  const { client, trust } = doorSetup();
  const result = await client.execute(spend(5), { sandbox: true });
  assert.equal(result.allowed, true);
  assert.equal(result.receipt, null);
  assert.equal(result.proposal, null);
  assert.equal(result.evidence.outcome, 'sandbox-allowed');

  const state = await trust.load();
  assert.equal(state.count, 1);
  assert.equal(state.summary.sandboxClean, 1);
  assert.equal(state.summary.realClean, 0);
});

test('a real ALLOW records executed only when commit returns a receipt', async () => {
  const { client, trust } = doorSetup({ stage: 'probation' });

  const noCommit = await client.execute(spend(5));
  assert.equal(noCommit.allowed, true);
  assert.equal(noCommit.evidence, null);

  const withCommit = await client.execute(spend(5), {
    commit: async () => ({ txHash: '0xfeed' }),
  });
  assert.equal(withCommit.allowed, true);
  assert.equal(withCommit.evidence.outcome, 'executed');
  assert.equal(withCommit.evidence.facts.receipt.txHash, '0xfeed');

  await assert.rejects(client.execute(spend(5), {
    commit: async () => { throw new Error('the transfer failed'); },
  }), /the transfer failed/);

  const state = await trust.load();
  assert.equal(state.count, 4); // 3 seeded sandbox + 1 executed; no record for no-commit or throw
  assert.equal(state.summary.realClean, 1);
});

test('a gate DENY after probation becomes a proposal and a blocked record', async () => {
  const { client, trust } = doorSetup({ stage: 'probation' });
  const result = await client.execute(spend(5, { recipient: STRANGER }));
  assert.equal(result.allowed, false);
  assert.equal(result.decision.verdict, 'DENY');
  assert.equal(result.decision.code, 'recipient-not-allowed');
  assert.ok(result.proposal);
  assert.equal(result.evidence.outcome, 'blocked');
  assert.equal((await trust.load()).summary.strikes, 1);
});

test('the probation per-call cap asks before the spending gate can quote the chain', async () => {
  const { client } = doorSetup({ stage: 'probation' });
  const result = await client.execute(spend(6));
  assert.equal(result.decision.verdict, 'ASK_USER');
  assert.equal(result.decision.code, 'ladder-cap');
  assert.match(result.decision.reason, /this agent's probation stage allows at most 5/);
});

test('probation deletes are capped by the overlay, not by the raw policy', async () => {
  // The company policy allows 10 deletes and says one was used. Without the
  // ladder overlay that is 1/10 - an ALLOW. With it, the probation cap is 1,
  // so 1/1 is used up. The overlay is the only thing standing in the way.
  const { client } = doorSetup({ stage: 'probation', deletesToday: 1 });
  const result = await client.execute(remove('/tmp/b'));
  assert.equal(result.allowed, false);
  assert.equal(result.decision.verdict, 'DENY');
  assert.equal(result.decision.code, 'daily-limit');
  assert.match(result.decision.reason, /daily delete limit \(1\)/);
});

test('probation sharing asks for approval even when the company policy allows it', async () => {
  const { client } = doorSetup({ stage: 'probation' });
  const result = await client.execute(share('/tmp/a'));
  assert.equal(result.decision.verdict, 'ASK_USER');
  assert.equal(result.decision.code, 'ladder-share');
});

test('a malformed amount is denied by the gate, not thrown by the trust precheck', async () => {
  const { client, trust } = doorSetup({ stage: 'probation' });
  const state = await trust.load();
  assert.equal(trust.precheck(spend('five'), state, fakeMandate()), null);

  const result = await client.decide(spend('five'));
  assert.equal(result.verdict, 'DENY');
  assert.equal(result.code, 'incomplete-context');
  assert.match(result.reason, /whole token unit count/);
});
