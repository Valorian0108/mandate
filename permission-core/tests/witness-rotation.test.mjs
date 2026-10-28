// Track 3 integration: witness-key ROTATION, end to end.
//
// attestations.test.mjs pins the primitives (digest, store, chain walk, the four
// proof properties). This file pins the INTEGRATION around them:
//
//   - the trust layer's behavior once an attestation chain exists (src/trust.mjs);
//   - the console's résumé, /api/witness/preview and /api/witness/attest;
//   - the wallet typed-data path - including the latent bug found while building
//     Track 3: createLadderStore/currentStage verified signatures WITHOUT the
//     typed-data context, so a WALLET-signed ladder change was refused by the
//     store even though the endpoint had just verified it. The last test is the
//     regression pin for that fix.
//
// Every refusal below is an OBS-08 check: it is the only thing between a
// plausible forgery (a rotated-out key signing new facts, an attacker minting an
// attestation, an orphaning "rotation") and that forgery being accepted as an
// agent's real track record.
//
// No network: the harness injects readOwnerKey/readAnchor/submitCalls and points
// the RPC at an unreachable port.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStarkKey } from '@scure/starknet';
import { createConsoleServer } from '../web/server.mjs';
import { signDigest } from '../web/signer.js';
import { mandateActionTypedData, signTypedData } from '../web/typed-data.js';
import {
  createEvidenceStore, signEvidence, signIdentity, verifyDigest,
} from '../src/evidence.mjs';
import { createLadderStore, currentStage, ladderChangeDigest } from '../src/ladder.mjs';
import {
  createAttestationStore, signWitnessAttestation, witnessAttestationDigest,
} from '../src/attestations.mjs';
import { createTrust } from '../src/trust.mjs';

const OWNER_PRIV = '0x1';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const ATTACKER_PRIV = '0x2';
const ATTACKER_PUB = getStarkKey(ATTACKER_PRIV);
const W1_PRIV = '0x3';
const W1_PUB = getStarkKey(W1_PRIV);
const W2_PRIV = '0x4';
const W2_PUB = getStarkKey(W2_PRIV);

const GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const REGISTRY = '0x03484789c7e0212a8ea8a398cb5b92ab9bacb01155db929e117efece9ec7e88c';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
// Deliberately in the PAST (resume.test.mjs uses a future NOW): the server
// builds attestations against the real clock and refuses future-dated ones, so
// the records must already exist "before now" for these flows to be realistic.
const NOW = 1_700_000_000_000;

const nf = (v) => '0x' + BigInt(v).toString(16);
const same = (a, b) => assert.equal(nf(a), nf(b));

const ALLOW = { verdict: 'ALLOW', code: 'within-mandate', reason: 'within the live mandate' };
const spend = (amount) => ({
  user: 'user:t',
  agent: 'agent:t',
  action: 'spend:transfer',
  resource: `token:${TOKEN}`,
  context: { recipient: MERCHANT, amount, token: TOKEN },
});

// ---------------------------------------------------------------- harness

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

function evidenceFor(agentId, seq, { at = NOW - 100 * seq, witness = W1_PUB, key = W1_PRIV } = {}) {
  return signEvidence({
    version: 1,
    agentId,
    seq,
    at,
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

function makeAgent(dir, { records = 3 } = {}) {
  const identity = signIdentity({
    owner: OWNER_PUB,
    purpose: 'test agent',
    nonce: '0x1',
    createdAt: NOW - 1000,
  }, OWNER_PRIV);
  const identityPath = join(dir, 'identity.json');
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  const store = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  for (let seq = 1; seq <= records; seq += 1) {
    store.append(evidenceFor(identity.agentId, seq));
  }
  return { identity, identityPath, evidencePath, ladderPath: join(dir, 'ladder.json') };
}

// A record that appears "now", signed by whatever key the scenario needs.
function appendRecord(evidencePath, agentId, seq, { at = Date.now(), witness = W2_PUB, key = W2_PRIV } = {}) {
  const store = createEvidenceStore({ filePath: evidencePath });
  store.append(evidenceFor(agentId, seq, { at, witness, key }));
}

// An owner-signed attestation written straight to the file - the headless twin
// of the browser flow, used to set up chain states (including forged links).
function appendAttestation(attestationPath, fields, priv = OWNER_PRIV) {
  const store = createAttestationStore({ filePath: attestationPath, now: () => Date.now() });
  const att = signWitnessAttestation({
    version: 1,
    kind: 'witness-attestation',
    owner: getStarkKey(priv),
    ...fields,
  }, priv);
  store.append(att);
  return att;
}

async function boot(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'witness-rot-'));
  const statePath = makeState(dir);
  const agent = makeAgent(dir, opts.agent);
  const attestationPath = join(dir, 'attestations.json');
  let owner = opts.owner ?? OWNER_PUB;

  const server = createConsoleServer({
    statePath,
    storePath: join(dir, 'proposals.json'),
    identityPath: agent.identityPath,
    evidencePath: agent.evidencePath,
    ladderPath: agent.ladderPath,
    attestationPath,
    readMandate: async () => ({}),
    readOwnerKey: async () => owner,
    readAnchor: async () => ({
      available: false, registry: REGISTRY, anchorer: GATE,
      error: 'injected: no chain in tests',
    }),
    submitCalls: async () => ({ status: 'SUCCEEDED', tx_hash: '0xfeed' }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return { port, dir, agent, attestationPath, setOwner: (v) => { owner = v; } };
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
const previewAttest = (port, body) => post(port, '/api/witness/preview', body);

// The headless owner signature: raw {r,s} over the canonical digest ("digest-v1").
function rawSignature(attestation, priv = OWNER_PRIV) {
  return signDigest(witnessAttestationDigest(attestation), priv);
}

async function applyAttest(port, attestation, signature = rawSignature(attestation)) {
  return post(port, '/api/witness/attest', { attestation, signature });
}

// Vouch for the key the records already carry - the natural first attestation.
// Asserted happy-path so a later refusal cannot be a harness artifact.
async function vouchFirst(port, reason = 'the key this app has been signing with') {
  const pv = await previewAttest(port, { reason });
  assert.equal(pv.status, 200, pv.text);
  const out = await applyAttest(port, pv.json.attestation);
  assert.equal(out.status, 200, out.text);
  return out.json;
}

// A wallet-shaped (SNIP-12 typed-data) owner signature - what the browser
// produces post-handover, when the owner key lives in Ready X, not in a file.
function typedEnvelope(digest, {
  kind, chainId = 'SN_SEPOLIA', account = GATE, priv = OWNER_PRIV, note = 'owner action',
} = {}) {
  const typedData = mandateActionTypedData({ chainId, kind, digest, note });
  const { r, s } = signTypedData(typedData, account, priv);
  return { scheme: 'snip12-v1', r, s, typedData };
}

const LADDER_CONTEXT = { kind: 'ladder-change', accountAddress: GATE, chainId: 'SN_SEPOLIA' };
const ATTEST_CONTEXT = { kind: 'witness-attestation', accountAddress: GATE, chainId: 'SN_SEPOLIA' };

// ---------------------------------------------------------------- trust layer

function trustSetup({ attestationPath = null, witnessPrivateKey = W1_PRIV, ownerPublicKey = OWNER_PUB } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wr-trust-'));
  const identity = signIdentity({
    owner: OWNER_PUB, purpose: 'test agent', nonce: '0x1', createdAt: NOW - 1000,
  }, OWNER_PRIV);
  const evidencePath = join(dir, 'evidence.json');
  const trust = createTrust({
    identity,
    witnessPrivateKey,
    evidencePath,
    ladderPath: join(dir, 'ladder.json'),
    attestationPath,
    readOwnerKey: async () => ownerPublicKey,
    now: () => NOW,
  });
  return { dir, identity, evidencePath, trust };
}

test('trust: an attested witness signs on, and old records keep verifying through the rotation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-trust-'));
  const attestPath = join(dir, 'attestations.json');
  const identity = signIdentity({
    owner: OWNER_PUB, purpose: 'test agent', nonce: '0x1', createdAt: NOW - 1000,
  }, OWNER_PRIV);
  const evidencePath = join(dir, 'evidence.json');
  // The clock is a parameter: an honest rotation timeline needs the new key's
  // records to be made AFTER the handover, and the trust layer signs with
  // whatever "now" it is given.
  const mkTrust = (witnessPrivateKey, now = () => NOW) => createTrust({
    identity,
    witnessPrivateKey,
    evidencePath,
    ladderPath: join(dir, 'ladder.json'),
    attestationPath: attestPath,
    readOwnerKey: async () => OWNER_PUB,
    now,
  });

  // Two records under W1, then the owner vouches for W1.
  const store = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  store.append(evidenceFor(identity.agentId, 1, { at: NOW - 20_000 }));
  store.append(evidenceFor(identity.agentId, 2, { at: NOW - 10_000 }));
  appendAttestation(attestPath, {
    agentId: identity.agentId, seq: 1, witness: W1_PUB, supersedes: null,
    validFrom: NOW - 30_000, at: NOW - 30_000, reason: 'the key this app launched with',
  });

  const trust1 = mkTrust(W1_PRIV);
  let state = await trust1.load();
  assert.equal(state.ok, true, state.reason);
  assert.equal(state.witnessHistory.length, 1);
  same(state.witnessHistory[0].witness, W1_PUB);
  assert.equal(trust1.record(spend(5), ALLOW, { sandbox: true }).outcome, 'sandbox-allowed');

  // The owner rotates to W2. The handover takes effect AFTER the last W1-era
  // record: a rotation explains history, it never rewrites it. (Backdating this
  // validFrom behind record 3 would put two keys "in effect" at the same
  // moment - exactly the contradiction the coverage check must flag, and what
  // the mismatch tests below pin.)
  appendAttestation(attestPath, {
    agentId: identity.agentId, seq: 2, witness: W2_PUB, supersedes: W1_PUB,
    validFrom: NOW + 5_000, at: NOW + 5_000, reason: 'rotated after a leak',
  });
  state = await trust1.load();
  assert.equal(state.ok, true, state.reason);
  assert.equal(state.witnessHistory.length, 2);
  assert.equal(state.count, 3);

  // The NEW key signs new records - on a clock past the handover, since a
  // record is covered by the attestation in effect WHEN IT WAS MADE - and the
  // whole history stays verified.
  const trust2 = mkTrust(W2_PRIV, () => NOW + 10_000);
  const rec = trust2.record(spend(5), ALLOW, { sandbox: true });
  assert.equal(rec.outcome, 'sandbox-allowed');
  same(rec.witness, W2_PUB);
  state = await trust2.load();
  assert.equal(state.ok, true, state.reason);
  assert.equal(state.count, 4);
  assert.equal(state.witnessHistory.length, 2);
  same(state.witnessHistory[1].witness, W2_PUB);
});

test('trust: a rotated-out witness key cannot sign new records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-trust-'));
  const attestPath = join(dir, 'attestations.json');
  const { identity, evidencePath, trust } = trustSetup({ attestationPath: attestPath });
  appendAttestation(attestPath, {
    agentId: identity.agentId, seq: 1, witness: W1_PUB, supersedes: null,
    validFrom: NOW - 30_000, at: NOW - 30_000, reason: 'the key this app launched with',
  });
  appendAttestation(attestPath, {
    agentId: identity.agentId, seq: 2, witness: W2_PUB, supersedes: W1_PUB,
    validFrom: NOW - 5_000, at: NOW - 5_000, reason: 'rotated after a leak',
  });

  // This trust instance still holds the OLD key. Any record it signed now would
  // be (correctly) refused at load, so record() fails at the source instead of
  // silently poisoning the evidence file.
  assert.throws(
    () => trust.record(spend(5), ALLOW, { sandbox: true }),
    /rotated out/,
  );
  // Nothing was written by the refused call.
  assert.equal(createEvidenceStore({ filePath: evidencePath }).list(identity.agentId).length, 0);
});

test('trust: a foreign record is named and refused when a chain exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wr-trust-'));
  const attestPath = join(dir, 'attestations.json');
  const { identity, evidencePath, trust } = trustSetup({ attestationPath: attestPath });
  appendAttestation(attestPath, {
    agentId: identity.agentId, seq: 1, witness: W1_PUB, supersedes: null,
    validFrom: NOW - 30_000, at: NOW - 30_000, reason: 'the key this app launched with',
  });
  const store = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  store.append(evidenceFor(identity.agentId, 1, { at: NOW - 20_000 }));
  // A key nobody vouched for signs itself into the history.
  store.append(evidenceFor(identity.agentId, 2, {
    at: NOW - 10_000, witness: ATTACKER_PUB, key: ATTACKER_PRIV,
  }));

  const state = await trust.load();
  assert.equal(state.ok, false);
  assert.equal(state.error, 'evidence-witness-mismatch');
  assert.match(state.reason, /was signed by/);
});

test('trust: with no attestation file, the legacy single-witness behavior is unchanged', async () => {
  const { identity, evidencePath, trust } = trustSetup(); // attestationPath: null
  trust.record(spend(5), ALLOW, { sandbox: true });
  trust.record(spend(5), ALLOW, { sandbox: true });

  let state = await trust.load();
  assert.equal(state.ok, true, state.reason);
  assert.equal(state.count, 2);
  // The legacy synthesized entry, pinned: seq 0 means "no attestation chain".
  assert.equal(state.witnessHistory.length, 1);
  assert.equal(state.witnessHistory[0].seq, 0);
  same(state.witnessHistory[0].witness, W1_PUB);

  // A foreign record is still refused exactly as before Track 3.
  const store = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  store.append(evidenceFor(identity.agentId, 3, { witness: ATTACKER_PUB, key: ATTACKER_PRIV }));
  state = await trust.load();
  assert.equal(state.ok, false);
  assert.equal(state.error, 'evidence-witness-mismatch');
  assert.match(state.reason, /not this app's witness/);
});

// ---------------------------------------------------------------- console reads

test('résumé without attestations reports an empty witness history - the legacy view is untouched', async (t) => {
  const { port } = await boot(t);
  const out = await get(port, '/api/resume');
  assert.equal(out.json.ok, true, out.text);
  assert.deepEqual(out.json.witnessHistory, []);
  assert.deepEqual(out.json.witnesses, [W1_PUB]);
  assert.equal(out.json.count, 3);
});

test('preview builds the whole attestation server-side; the first vouch backdates to the earliest record', async (t) => {
  const { port, agent } = await boot(t);
  const out = await previewAttest(port, { reason: 'the key this app has been signing with' });
  assert.equal(out.status, 200, out.text);
  const att = out.json.attestation;
  assert.equal(att.version, 1);
  assert.equal(att.kind, 'witness-attestation');
  same(att.agentId, agent.identity.agentId);
  assert.equal(att.seq, 1);
  same(att.witness, W1_PUB);              // prefilled from the records, not from the form
  assert.equal(att.supersedes, null);     // the genesis link supersedes nothing
  assert.equal(att.validFrom, NOW - 300); // earliest record: NOW - 100*3
  same(att.owner, OWNER_PUB);             // read from the chain, never from the request
  assert.equal(out.json.current, null);
  assert.equal(out.json.digest, witnessAttestationDigest(att));
});

test('an owner-signed vouch applies, and the résumé shows the attested history', async (t) => {
  const { port, attestationPath } = await boot(t);
  const applied = await vouchFirst(port);
  assert.equal(applied.applied, 1);
  assert.equal(applied.resume.ok, true, JSON.stringify(applied.resume.reason));
  assert.equal(applied.resume.witnessHistory.length, 1);
  same(applied.resume.witnessHistory[0].witness, W1_PUB);

  // The file on disk holds exactly one link, raw-signed ("digest-v1" = no scheme).
  const db = JSON.parse(readFileSync(attestationPath, 'utf8'));
  assert.equal(db.attestations.length, 1);
  assert.equal(db.attestations[0].signature.scheme, undefined);
});

test('an honest rotation: vouch the new key, and its records keep the résumé green', async (t) => {
  const { port, agent } = await boot(t);
  await vouchFirst(port);

  const pv = await previewAttest(port, { witness: W2_PUB, reason: 'rotated after a leak' });
  assert.equal(pv.status, 200, pv.text);
  const att = pv.json.attestation;
  assert.equal(att.seq, 2);
  same(att.supersedes, W1_PUB); // linked to the key it replaces
  assert.ok(att.validFrom > NOW, 'a rotation takes effect from now, not backdated');
  same(pv.json.current.witness, W1_PUB);

  const out = await applyAttest(port, att);
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.applied, 2);

  // The app now signs with the new key; the résumé must stay verified.
  appendRecord(agent.evidencePath, agent.identity.agentId, 4);
  const res = await get(port, '/api/resume');
  assert.equal(res.json.ok, true, res.text);
  assert.equal(res.json.count, 4);
  assert.equal(res.json.witnesses.length, 2);      // two keys signed records...
  assert.equal(res.json.witnessHistory.length, 2); // ...and the chain explains it
});

test('a wallet typed-data signature applies end to end; a mismatched kind is refused', async (t) => {
  const { port } = await boot(t);
  const pv = await previewAttest(port, { reason: 'vouched from the browser wallet' });
  assert.equal(pv.status, 200, pv.text);
  const att = pv.json.attestation;
  const digest = pv.json.digest;

  // Typed-data schemes verify ONLY with their context (src/proposals.mjs) -
  // pin all three halves, because the whole wallet path rests on this.
  const envelope = typedEnvelope(digest, { kind: 'witness-attestation' });
  assert.equal(verifyDigest(digest, envelope, OWNER_PUB), false, 'no context, no verification');
  assert.equal(verifyDigest(digest, envelope, OWNER_PUB, ATTEST_CONTEXT), true);
  assert.equal(verifyDigest(digest, envelope, OWNER_PUB, LADDER_CONTEXT), false, 'wrong kind');

  const out = await applyAttest(port, att, envelope);
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.applied, 1);
  assert.equal(out.json.resume.witnessHistory.length, 1);

  // The same envelope shape under the WRONG kind never reaches the file.
  const pv2 = await previewAttest(port, { witness: W2_PUB, reason: 'rotated after a leak' });
  assert.equal(pv2.status, 200, pv2.text);
  const wrongKind = typedEnvelope(pv2.json.digest, { kind: 'ladder-change' });
  const refused = await applyAttest(port, pv2.json.attestation, wrongKind);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /does not verify/);
});

// ---------------------------------------------------------------- console refusals

test('a record signed by an unvouched key refuses the whole résumé, by name', async (t) => {
  const { port, agent } = await boot(t);
  await vouchFirst(port);
  // The chain names W1, but a W2 record appears with no rotation vouched.
  appendRecord(agent.evidencePath, agent.identity.agentId, 4);

  const res = await get(port, '/api/resume');
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error, 'evidence-witness-mismatch');
  assert.match(res.json.reason, /was signed by/);

  // And no ladder move can be previewed on a disputed history.
  const lad = await post(port, '/api/ladder/preview', {
    from: 'new', to: 'probation', reason: 'three clean sandbox runs',
  });
  assert.equal(lad.status, 409);
  assert.match(lad.json.error, /cannot be read/);
});

test('the refusal is repairable: an explicit validFrom re-covers the records', async (t) => {
  const { port, agent } = await boot(t);
  await vouchFirst(port);
  const recAt = Date.now();
  appendRecord(agent.evidencePath, agent.identity.agentId, 4, { at: recAt });
  const before = await get(port, '/api/resume');
  assert.equal(before.json.ok, false, 'the uncovered record must refuse the résumé first');

  // The repair: vouch W2 from the moment it actually started signing. Preview
  // must work IN the refused state - that is what the endpoint's tolerated
  // witness-mismatch view is for. Any other refusal stays a hard stop.
  const pv = await previewAttest(port, {
    witness: W2_PUB,
    reason: 'the app rotated its key; vouching for the new one',
    validFrom: recAt,
  });
  assert.equal(pv.status, 200, pv.text);
  assert.equal(pv.json.attestation.validFrom, recAt);
  assert.equal(pv.json.attestation.seq, 2);
  same(pv.json.attestation.supersedes, W1_PUB);

  const out = await applyAttest(port, pv.json.attestation);
  assert.equal(out.status, 200, out.text);

  const res = await get(port, '/api/resume');
  assert.equal(res.json.ok, true, res.text);
  assert.equal(res.json.witnessHistory.length, 2);
  assert.equal(res.json.count, 4);
});

test('a broken attestation chain refuses the résumé AND the witness endpoints', async (t) => {
  const { port, attestationPath, agent } = await boot(t);
  appendAttestation(attestationPath, {
    agentId: agent.identity.agentId, seq: 1, witness: W1_PUB, supersedes: null,
    validFrom: NOW - 300, at: NOW - 300, reason: 'the key this app launched with',
  });
  // Self-consistent but attacker-signed: the STORE accepts it (it verifies
  // against its own stated owner); the chain walk against the CHAIN owner does
  // not, and the walk stops there.
  appendAttestation(attestationPath, {
    agentId: agent.identity.agentId, seq: 2, witness: ATTACKER_PUB, supersedes: W1_PUB,
    validFrom: NOW - 200, at: NOW - 200, reason: 'seize the history',
  }, ATTACKER_PRIV);

  const res = await get(port, '/api/resume');
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error, 'witness-chain-unverified');
  assert.match(res.json.reason, /broken at seq 2/);

  const pv = await previewAttest(port, { reason: 'anything at all' });
  assert.equal(pv.status, 409);
  assert.match(pv.json.error, /cannot be read/);

  // Even a perfectly owner-signed next link cannot be recorded onto a broken
  // chain: while a predecessor is unverified, the next seq is unknowable.
  const honest = signWitnessAttestation({
    version: 1, kind: 'witness-attestation', agentId: agent.identity.agentId,
    seq: 3, witness: W2_PUB, supersedes: ATTACKER_PUB, validFrom: NOW - 100,
    at: NOW - 100, reason: 'an honest link onto a dishonest chain', owner: OWNER_PUB,
  }, OWNER_PRIV);
  const app = await applyAttest(port, honest, honest.signature);
  assert.equal(app.status, 409);
  assert.match(app.json.error, /cannot be read/);
});

test('forged owners, wrong keys, foreign agents, stale seqs and edits are each refused', async (t) => {
  const { port, agent } = await boot(t);
  const agentId = agent.identity.agentId;
  const base = {
    version: 1, kind: 'witness-attestation', agentId, seq: 1,
    witness: W1_PUB, supersedes: null, validFrom: NOW - 300, at: NOW - 300,
    reason: 'the key this app has been signing with',
  };

  // An attacker mints a self-consistent attestation naming THEMSELVES the owner.
  const forged = signWitnessAttestation(
    { ...base, witness: ATTACKER_PUB, owner: ATTACKER_PUB, reason: 'seize the history' },
    ATTACKER_PRIV,
  );
  let out = await applyAttest(port, forged, forged.signature);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /different owner/);

  // An attacker signs while CLAIMING the real owner key.
  const claimed = { ...base, owner: OWNER_PUB };
  out = await applyAttest(port, claimed, rawSignature(claimed, ATTACKER_PRIV));
  assert.equal(out.status, 409);
  assert.match(out.json.error, /does not verify/);

  // An owner-signed attestation for a DIFFERENT agent cannot enter through this
  // console: it belongs to another agent's history.
  const foreign = signWitnessAttestation({ ...base, agentId: '0xdeadbeef', owner: OWNER_PUB }, OWNER_PRIV);
  out = await applyAttest(port, foreign, foreign.signature);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /different agent/);

  // An attestation edited after signing fails the recomputed digest.
  const pv = await previewAttest(port, { reason: 'the key this app has been signing with' });
  assert.equal(pv.status, 200, pv.text);
  const signature = rawSignature(pv.json.attestation);
  out = await applyAttest(port, { ...pv.json.attestation, reason: 'edited after signing' }, signature);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /does not verify/);

  // A stale seq is refused even when everything else verifies.
  await vouchFirst(port);
  const stale = signWitnessAttestation({ ...base, witness: W2_PUB, owner: OWNER_PUB }, OWNER_PRIV);
  out = await applyAttest(port, stale, stale.signature);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /must be 2/);
});

test('an attestation that would orphan signed records is refused at preview AND at apply', async (t) => {
  const { port, agent } = await boot(t);

  // Preview: vouching W2 (a key that signed nothing) with the default backdated
  // validFrom would leave every W1 record uncovered - refused before signing.
  const pv = await previewAttest(port, {
    witness: W2_PUB, reason: 'a key that never signed anything',
  });
  assert.equal(pv.status, 409);
  assert.match(pv.json.error, /uncovered/);

  // Apply: a VALID preview goes stale when a W2 record appears before signing.
  // The coverage guard re-runs at apply, because the records can grow in between.
  const pv2 = await previewAttest(port, { reason: 'the key this app has been signing with' });
  assert.equal(pv2.status, 200, pv2.text);
  appendRecord(agent.evidencePath, agent.identity.agentId, 4);
  const out = await applyAttest(port, pv2.json.attestation);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /would leave signed records uncovered/);
});

test('rotating to the key already attested is refused, however it is spelled', async (t) => {
  const { port } = await boot(t);
  await vouchFirst(port);

  const again = await previewAttest(port, { witness: W1_PUB, reason: 'vouch the same key again' });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /nothing to rotate/);

  // Zero-padded to 64 hex digits: the same key, the same refusal.
  const padded = '0x' + BigInt(W1_PUB).toString(16).padStart(64, '0');
  const again2 = await previewAttest(port, { witness: padded, reason: 'vouch the same key again' });
  assert.equal(again2.status, 409);
  assert.match(again2.json.error, /nothing to rotate/);
});

test('preview refuses a thin reason, a malformed key, future dating and backward time', async (t) => {
  const { port, agent } = await boot(t);

  let out = await previewAttest(port, { reason: 'x' });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /plain sentence/);

  out = await previewAttest(port, { witness: 'nothex', reason: 'a perfectly good reason' });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /hex public key/);

  out = await previewAttest(port, {
    witness: W1_PUB, reason: 'a perfectly good reason', validFrom: Date.now() + 100_000,
  });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /future/);

  // Time must move forward along the chain.
  await vouchFirst(port);
  out = await previewAttest(port, {
    witness: W2_PUB, reason: 'backdated behind the current attestation', validFrom: NOW - 400,
  });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /time must move forward/);

  // Once more than one key has signed records, the server will not GUESS which
  // key the attestation vouches for - it must be named.
  appendRecord(agent.evidencePath, agent.identity.agentId, 4);
  out = await previewAttest(port, { reason: 'a perfectly good reason' });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /name the witness key/);
});

// ---------------------------------------------------------------- the context fix

test('a wallet-signed ladder change is accepted end to end - the context fix, pinned', async (t) => {
  const { port, agent, dir } = await boot(t);
  const pv = await post(port, '/api/ladder/preview', {
    from: 'new', to: 'probation', reason: 'three clean sandbox runs',
  });
  assert.equal(pv.status, 200, pv.text);
  const change = pv.json.change;
  const envelope = typedEnvelope(ladderChangeDigest(change), {
    kind: 'ladder-change', note: 'move the agent up',
  });
  const signed = { ...change, signature: envelope };

  // Unit half - the pre-fix failure: a store WITHOUT the typed-data context
  // refuses the very envelope the endpoint had just verified. WITH it, the same
  // envelope appends. Pinned so the fix can never be silently reverted.
  const probePath = join(dir, 'probe-ladder.json');
  const noCtx = createLadderStore({ filePath: probePath });
  assert.throws(() => noCtx.append(signed), /does not verify/);
  const withCtx = createLadderStore({ filePath: probePath, context: LADDER_CONTEXT });
  withCtx.append(signed);

  // currentStage must see it too, or the promotion would apply but never count.
  const records = createEvidenceStore({ filePath: agent.evidencePath }).list(agent.identity.agentId);
  const blind = currentStage({
    agentId: agent.identity.agentId, changes: [signed], ownerPublicKey: OWNER_PUB, records,
  });
  assert.equal(blind.stage, 'new');
  assert.match(blind.rejected[0].reason, /signature does not verify/);
  const seeing = currentStage({
    agentId: agent.identity.agentId, changes: [signed], ownerPublicKey: OWNER_PUB, records,
    context: LADDER_CONTEXT,
  });
  assert.equal(seeing.stage, 'probation');

  // Endpoint half - the live apply path, context-aware store included.
  const out = await post(port, '/api/ladder/apply', { change, signature: envelope });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.applied, 1);
  assert.equal(out.json.resume.stage, 'probation');
});
