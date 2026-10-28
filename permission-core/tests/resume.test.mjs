// The console's résumé controls, tested as the ONLY thing between a claim about
// an agent's trust and that claim being acted on (OBS-08). No network: the owner
// key, the registry read and the transaction submitter are all injected.
//
// The checks that matter:
//   - the stage shown is recomputed from signatures, never read from a stored field
//   - an identity the chain owner did not sign refuses the whole screen
//   - one edited record refuses the whole screen
//   - only the owner key moves the ladder; a forged signature moves nobody
//   - a change signed against an older snapshot is refused once the records grow
//   - an illegal transition, a stale stage, a foreign agent, a skipped sequence
//     and a rotated owner key are each refused on their own
//   - anchoring writes the exact fingerprint once and refuses to waste a second
//     transaction on something already on chain

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStarkKey } from '@scure/starknet';
import { createConsoleServer } from '../web/server.mjs';
import { signDigest } from '../web/signer.js';
import { createEvidenceStore, signEvidence, signIdentity } from '../src/evidence.mjs';
import { ladderChangeDigest } from '../src/ladder.mjs';

const OWNER_PRIV = '0x1';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const ATTACKER_PRIV = '0x2';
const ATTACKER_PUB = getStarkKey(ATTACKER_PRIV);
const WITNESS_PRIV = '0x3';
const WITNESS_PUB = getStarkKey(WITNESS_PRIV);

const GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const REGISTRY = '0x03484789c7e0212a8ea8a398cb5b92ab9bacb01155db929e117efece9ec7e88c';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const NOW = 1_800_000_000_000;

function makeState(dir) {
  const state = {
    chain_id: 'SN_SEPOLIA',
    contracts: {
      gate_account: { address: GATE },
      evidence_registry: { address: REGISTRY },
    },
    selectors: {
      anchor: '0x03cc2a1f',
      get_anchor: '0x019d579b',
      get_anchor_count: '0x0313111e',
    },
    keys: { owner: { address: GATE, public_key: OWNER_PUB } },
    layer_d: { anchors: [] },
    // Deliberately unreachable: nothing in these tests may touch the network.
    rpc_endpoints_verified: { cartridge: { url: 'http://127.0.0.1:1' } },
  };
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

function evidenceFor(agentId, seq, { witness = WITNESS_PUB, key = WITNESS_PRIV } = {}) {
  return signEvidence({
    version: 1,
    agentId,
    seq,
    at: NOW - 100 * seq,
    domain: 'spend',
    action: 'spend:transfer',
    outcome: 'sandbox-allowed',
    facts: {
      action: 'spend:transfer',
      context: { amount: '5', recipient: MERCHANT },
      code: 'within-mandate',
      reason: 'inside every limit',
    },
    witness,
  }, key);
}

function makeAgent(dir, { records = 3, ownerPriv = OWNER_PRIV, ownerPub = OWNER_PUB } = {}) {
  const identity = signIdentity({
    owner: ownerPub,
    purpose: 'test agent',
    nonce: '0x1',
    createdAt: NOW - 1000,
  }, ownerPriv);
  const identityPath = join(dir, 'identity.json');
  const evidencePath = join(dir, 'evidence.json');
  const ladderPath = join(dir, 'ladder.json');
  writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  const store = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  for (let seq = 1; seq <= records; seq += 1) {
    store.append(evidenceFor(identity.agentId, seq));
  }
  return { identity, identityPath, evidencePath, ladderPath };
}

async function boot(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'resume-test-'));
  const statePath = makeState(dir);
  const agent = makeAgent(dir, opts.agent);
  const submitted = [];
  let owner = opts.owner ?? OWNER_PUB;
  let anchor = opts.anchor ?? { available: false, registry: REGISTRY, anchorer: GATE, error: 'injected: no chain in tests' };

  const server = createConsoleServer({
    statePath,
    storePath: join(dir, 'proposals.json'),
    identityPath: agent.identityPath,
    evidencePath: agent.evidencePath,
    ladderPath: agent.ladderPath,
    attestationPath: join(dir, 'attestations.json'),
    readMandate: async () => ({}),
    readOwnerKey: async () => owner,
    readAnchor: async () => anchor,
    submitCalls: async (calls) => {
      submitted.push(calls);
      return opts.submitResult ?? { status: 'SUCCEEDED', tx_hash: '0xfeed' };
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return {
    port,
    dir,
    statePath,
    agent,
    submitted,
    setOwner: (v) => { owner = v; },
    setAnchor: (v) => { anchor = v; },
  };
}

async function call(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

const get = (port, path) => call(port, 'GET', path);
const post = (port, path, body) => call(port, 'POST', path, body);

const previewPromotion = (port, overrides = {}) => post(port, '/api/ladder/preview', {
  from: 'new', to: 'probation', reason: 'three clean sandbox runs', ...overrides,
});

async function stageOf(port) {
  const out = await get(port, '/api/resume');
  assert.equal(out.json.ok, true, out.text);
  return out.json.stage;
}

// ---------------------------------------------------------------- the read

test('the résumé recomputes the stage from signatures, not from a stored field', async (t) => {
  const { port } = await boot(t);
  const out = await get(port, '/api/resume');
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.ok, true);
  // No ladder change has ever been signed, so the agent is where it started -
  // even though three clean records exist.
  assert.equal(out.json.stage, 'new');
  assert.equal(out.json.profile.autoSpendPerCall, '0');
  assert.equal(out.json.count, 3);
  assert.equal(out.json.summary.sandboxClean, 3);
  assert.equal(out.json.summary.realClean, 0);
  assert.deepEqual(out.json.suggestion, {
    to: 'probation', reason: '3 clean actions (sandbox counts for this first step)',
  });
  assert.deepEqual(out.json.transitions, ['probation', 'restricted']);
  assert.equal(out.json.changes.length, 0);
  assert.deepEqual(out.json.witnesses, [WITNESS_PUB]);
  assert.equal(out.json.recent.length, 3);
  assert.equal(out.json.anchor.available, false, 'a failed chain read is reported, not hidden');
});

test('an identity the chain owner did not sign refuses the whole screen', async (t) => {
  const { port } = await boot(t, {
    agent: { ownerPriv: ATTACKER_PRIV, ownerPub: ATTACKER_PUB },
  });

  const out = await get(port, '/api/resume');
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error, 'identity-unverified');
  assert.match(out.json.reason, /not signed by the owner key the chain reports/);

  // And it is not merely cosmetic: the signing path is closed too.
  const preview = await previewPromotion(port);
  assert.equal(preview.status, 409);
  assert.match(preview.json.error, /trust state cannot be read/);
});

test('one edited record refuses the whole résumé', async (t) => {
  const { port, agent } = await boot(t);
  assert.equal((await get(port, '/api/resume')).json.ok, true);

  const db = JSON.parse(readFileSync(agent.evidencePath, 'utf8'));
  db.records[1].facts.context.amount = '9999';
  writeFileSync(agent.evidencePath, JSON.stringify(db, null, 2));

  const out = await get(port, '/api/resume');
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error, 'evidence-unverified');
  assert.match(out.json.reason, /signature does not verify/);
});

test('records signed by two different witnesses are surfaced, not averaged away', async (t) => {
  const { port, agent } = await boot(t);
  const store = createEvidenceStore({ filePath: agent.evidencePath, now: () => NOW });
  store.append(evidenceFor(agent.identity.agentId, 4, {
    witness: ATTACKER_PUB, key: ATTACKER_PRIV,
  }));

  const out = await get(port, '/api/resume');
  assert.equal(out.json.ok, true);
  assert.deepEqual(out.json.witnesses.sort(), [ATTACKER_PUB, WITNESS_PUB].sort());
});

// ---------------------------------------------------------------- the write

test('only the owner key moves the ladder, and a forged signature moves nobody', async (t) => {
  const { port } = await boot(t);

  const preview = await previewPromotion(port);
  assert.equal(preview.status, 200, preview.text);
  const change = preview.json.change;
  assert.equal(change.evidenceCount, 3);
  assert.equal(change.owner, OWNER_PUB);
  assert.equal(preview.json.earned, true);
  assert.equal(preview.json.digest, ladderChangeDigest(change));
  assert.equal(preview.json.after.autoSpendPerCall, '5',
    'the preview shows the limits the door will actually enforce');

  // A signature from a key that is not the owner, over the correct digest.
  const forged = await post(port, '/api/ladder/apply', {
    change, signature: signDigest(preview.json.digest, ATTACKER_PRIV),
  });
  assert.equal(forged.status, 409);
  assert.match(forged.json.error, /does not verify against the owner key/);
  assert.equal(await stageOf(port), 'new', 'a forged signature must not move anyone');

  // A real owner signature, replayed over a DIFFERENT destination.
  const swapped = { ...change, to: 'trusted' };
  const replay = await post(port, '/api/ladder/apply', {
    change: swapped, signature: signDigest(preview.json.digest, OWNER_PRIV),
  });
  assert.equal(replay.status, 409, 'a signature for probation cannot promote to trusted');
  assert.equal(await stageOf(port), 'new');

  const ok = await post(port, '/api/ladder/apply', {
    change, signature: signDigest(preview.json.digest, OWNER_PRIV),
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.resume.stage, 'probation');
  assert.equal(ok.json.resume.profile.autoSpendPerCall, '5');
  assert.equal(ok.json.resume.changes.length, 1);
  assert.equal(ok.json.resume.changes[0].verified, true);
  assert.deepEqual(ok.json.resume.applied, [1]);

  // The same change cannot be applied twice: the sequence has moved on.
  const twice = await post(port, '/api/ladder/apply', {
    change, signature: signDigest(preview.json.digest, OWNER_PRIV),
  });
  assert.equal(twice.status, 409);
  assert.equal((await get(port, '/api/resume')).json.changes.length, 1,
    'the ladder file is append-only and grew by exactly one');
});

test('an illegal transition or a stale stage is refused before any signature', async (t) => {
  const { port } = await boot(t);

  const skip = await previewPromotion(port, { to: 'established' });
  assert.equal(skip.status, 409);
  assert.match(skip.json.error, /cannot move from 'new' to 'established'/);

  const stale = await previewPromotion(port, { from: 'probation', to: 'trusted' });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /the agent is 'new', not 'probation'/);

  const shortReason = await previewPromotion(port, { reason: 'ok' });
  assert.equal(shortReason.status, 400);
  assert.match(shortReason.json.error, /plain sentence/);

  assert.equal(await stageOf(port), 'new');
});

test('an agent with no records has nothing to promote on', async (t) => {
  const { port } = await boot(t, { agent: { records: 0 } });
  const out = await previewPromotion(port);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /at least one signed record/);
});

test('a change signed against an older snapshot is refused once the records grow', async (t) => {
  const { port, agent } = await boot(t);
  const preview = await previewPromotion(port);
  assert.equal(preview.json.change.evidenceCount, 3);

  // A fourth record lands between the preview and the signature being applied.
  const store = createEvidenceStore({ filePath: agent.evidencePath, now: () => NOW });
  store.append(evidenceFor(agent.identity.agentId, 4));

  const out = await post(port, '/api/ladder/apply', {
    change: preview.json.change,
    signature: signDigest(preview.json.digest, OWNER_PRIV),
  });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /the evidence changed after this change was signed/);
  assert.equal(await stageOf(port), 'new', 'a stale promotion must not be applied');
});

test('a rotated owner key invalidates a ladder signature', async (t) => {
  const ctx = await boot(t);
  const preview = await previewPromotion(ctx.port);

  ctx.setOwner(ATTACKER_PUB);
  const out = await post(ctx.port, '/api/ladder/apply', {
    change: preview.json.change,
    signature: signDigest(preview.json.digest, OWNER_PRIV),
  });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /different owner than the one the chain reports/);

  // The résumé now refuses outright: the identity no longer verifies either.
  const resume = await get(ctx.port, '/api/resume');
  assert.equal(resume.json.ok, false);
  assert.equal(resume.json.error, 'identity-unverified');
});

test('a change for a different agent, or a skipped sequence, is refused', async (t) => {
  const { port } = await boot(t);
  const preview = await previewPromotion(port);

  const foreign = { ...preview.json.change, agentId: `0x${'11'.repeat(32)}` };
  const wrongAgent = await post(port, '/api/ladder/apply', {
    change: foreign, signature: signDigest(ladderChangeDigest(foreign), OWNER_PRIV),
  });
  assert.equal(wrongAgent.status, 409);
  assert.match(wrongAgent.json.error, /different agent/);

  const bumped = { ...preview.json.change, seq: 7 };
  const wrongSeq = await post(port, '/api/ladder/apply', {
    change: bumped, signature: signDigest(ladderChangeDigest(bumped), OWNER_PRIV),
  });
  assert.equal(wrongSeq.status, 409);
  assert.match(wrongSeq.json.error, /the next one must be 1/);

  const unsigned = await post(port, '/api/ladder/apply', { change: preview.json.change });
  assert.equal(unsigned.status, 400);
  assert.match(unsigned.json.error, /needs the owner signature/);

  assert.equal(await stageOf(port), 'new');
});

// ---------------------------------------------------------------- the anchor

test('anchoring writes the exact fingerprint once and refuses to waste a transaction', async (t) => {
  const ctx = await boot(t);

  const first = await post(ctx.port, '/api/anchor', {});
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.status, 'SUCCEEDED');
  assert.equal(ctx.submitted.length, 1);

  const [call] = ctx.submitted[0];
  assert.equal(call.to, REGISTRY);
  assert.equal(call.entrypoint, 'anchor');
  const [agentId, root, count] = call.calldata;
  assert.equal(agentId, ctx.agent.identity.agentId);
  assert.equal(Number(count), 3);

  // The root that went on-chain is the root of the signed records - not a value
  // the caller supplied.
  const resume = await get(ctx.port, '/api/resume');
  assert.equal(BigInt(root), BigInt(resume.json.root));

  const state = JSON.parse(readFileSync(ctx.statePath, 'utf8'));
  assert.equal(state.layer_d.anchors.length, 1);
  assert.equal(state.layer_d.anchors[0].source, 'console');
  assert.equal(state.layer_d.anchors[0].tx_hash, '0xfeed');

  // Once the chain holds that exact fingerprint, a second anchor is refused.
  ctx.setAnchor({
    available: true, registry: REGISTRY, anchorer: GATE,
    root, count: 3, anchorCount: 1, error: null,
  });
  const again = await post(ctx.port, '/api/anchor', {});
  assert.equal(again.status, 409);
  assert.match(again.json.error, /already on chain/);
  assert.equal(ctx.submitted.length, 1, 'no second transaction was sent');
});

test('there is nothing to anchor before the agent has a record', async (t) => {
  const ctx = await boot(t, { agent: { records: 0 } });
  const out = await post(ctx.port, '/api/anchor', {});
  assert.equal(out.status, 409);
  assert.match(out.json.error, /no evidence to anchor/);
  assert.equal(ctx.submitted.length, 0);
});

test('a failed anchor transaction is reported, and nothing is recorded as anchored', async (t) => {
  const ctx = await boot(t, {
    submitResult: { status: 'REVERTED', tx_hash: '0xdead', revert_reason: 'EvidenceRegistry: bad count' },
  });
  const out = await post(ctx.port, '/api/anchor', {});
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.status, 'REVERTED');
  assert.equal(out.json.revert_reason, 'EvidenceRegistry: bad count');

  const state = JSON.parse(readFileSync(ctx.statePath, 'utf8'));
  assert.deepEqual(state.layer_d.anchors, [],
    'a reverted transaction must not be written into the deployment record');
});
