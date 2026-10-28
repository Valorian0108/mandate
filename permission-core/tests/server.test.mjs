// The console's controls, tested as the ONLY thing standing between an action
// and its consequence (OBS-08). No network: the chain reads are injected.
//
// The checks that matter:
//   - a blocked request creates a proposal; an allowed one does not
//   - only a signature that verifies against the owner key resolves a proposal
//   - a signature for one resolution cannot be replayed as another
//   - a pending proposal cannot be submitted
//   - a rotated owner key invalidates an old approval before submission
//   - a mandate that already moved makes the old approval unsubmittable
//   - the same proposal cannot be submitted twice
//   - the audit re-verifies signatures against the CURRENT chain key

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStarkKey } from '@scure/starknet';
import { createConsoleServer } from '../web/server.mjs';
import { resolutionDigest, signResolution } from '../src/proposals.mjs';
import { signMandateAction } from '../web/typed-data.js';

const OWNER_PRIV = '0x1';
const ATTACKER_PRIV = '0x2';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const ATTACKER_PUB = getStarkKey(ATTACKER_PRIV);

const GATE = '0x2502';
const TOKEN = '0x01f5';
const SESSION = '0x100d';
const MERCHANT = '0x079e';
const STRANGER = '0x16cb';
const TRANSFER_SELECTOR =
  '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e';

function policy(overrides = {}) {
  return {
    sessionPublicKey: SESSION,
    validUntil: 2000000000,
    maxCalls: 10,
    callsUsed: 2,
    allowedEntrypointsLen: 1,
    allowedSelectors: [TRANSFER_SELECTOR],
    token: TOKEN,
    maxPerCall: 20n,
    maxPerWindow: 100n,
    windowSeconds: 2592000,
    spentInWindow: 15n,
    windowStart: Math.floor(Date.now() / 1000) - 100,
    allowedRecipients: [MERCHANT],
    ...overrides,
  };
}

function makeState(dir) {
  const state = {
    chain_id: 'SN_SEPOLIA',
    chain_id_hex: '0x534e5f5345504f4c4941',
    contracts: { gate_account: { address: GATE } },
    keys: {
      owner: { address: GATE, public_key: OWNER_PUB },
      agent_session: { session_public_key: SESSION },
      merchant: { address: MERCHANT },
      stranger: { address: STRANGER },
    },
    mandate: { merchant_allowlist: { allowed: [MERCHANT] } },
    // Deliberately unreachable: /api/mandate must survive a status RPC failure.
    rpc_endpoints_verified: { cartridge: { url: 'http://127.0.0.1:1' } },
    layer_c_demo: [],
  };
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

async function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'permission-console-'));
  const statePath = makeState(dir);
  const storePath = join(dir, 'proposals.json');
  const server = createConsoleServer({
    statePath,
    storePath,
    readMandate: async () => policy(),
    readOwnerKey: async () => OWNER_PUB,
    submitCalls: async () => ({ status: 'SUCCEEDED', tx_hash: '0xfeed' }),
    ...overrides,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port, dir, storePath };
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
  return { status: res.status, text, json, headers: res.headers };
}

async function ask(port, amount, recipient = MERCHANT) {
  const out = await call(port, 'POST', '/api/requests', { recipient, amount });
  assert.equal(out.status, 200, out.text);
  return out.json;
}

const amendTo = (cap) => ({
  type: 'amend',
  amendment: { kind: 'raise-per-call-cap', token: TOKEN, maxPerCall: String(cap) },
});

const amendWindowTo = (cap) => ({
  type: 'amend',
  amendment: { kind: 'raise-window-cap', token: TOKEN, maxPerWindow: String(cap) },
});

// ---------------------------------------------------------------- static

test('serves the page, the browser modules, and refuses path traversal', async (t) => {
  const { port } = await setup(t);

  const home = await call(port, 'GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Permission console/);
  assert.doesNotMatch(home.text, /__CSP_NONCE__/);
  assert.match(home.headers.get('content-security-policy'), /nonce-/);
  // connect-src must allow the wallet's rpc hosts (OBS-30): the wallet's
  // in-page code fetches from THIS page's origin, so a bare connect-src
  // 'self' kills both the connect-time key read and Ready X's signing
  // simulation. Pinned EXACTLY - bounded allowlist, never a bare https:,
  // so widening it is a deliberate, reviewed act.
  const csp = home.headers.get('content-security-policy');
  const connectSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src'));
  assert.equal(connectSrc,
    "connect-src 'self' https://rpc.starknet-sepolia.lava.build https://api.cartridge.gg");
  assert.equal(home.headers.get('x-frame-options'), 'DENY');

  const app = await call(port, 'GET', '/app.js');
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /javascript/);

  const signer = await call(port, 'GET', '/signer.js');
  assert.equal(signer.status, 200);

  const vendor = await call(port, 'GET', '/vendor/scure/starknet/index.js');
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers.get('content-type'), /javascript/);

  const traversal = await call(port, 'GET', '/..%2F..%2Fpackage.json');
  assert.ok(traversal.status === 403 || traversal.status === 404,
    `traversal should be refused, got ${traversal.status}`);

  const health = await call(port, 'GET', '/api/health');
  assert.deepEqual(health.json, { ok: true });
});

// ------------------------------------------------- the console's own chain read

// /api/chain/key exists because a browser tab cannot always reach the chain
// through the wallet's injected provider ("Failed to fetch" from the page's
// origin, observed live 2026-10-26): the console reads the key server-side,
// CORS-free, and names WHICH getter answered - the signature shape the
// browser expects depends on it. Chain reads are injected (OBS-08).

test('GET /api/chain/key falls back to get_owner and names the getter (Ready X)', async (t) => {
  const { port } = await setup(t, {
    readPublicKey: async () => { throw new Error('no such entrypoint'); },
    readControllerPublicKey: async () => ['0x4fb2'],
  });
  const out = await call(port, 'GET', '/api/chain/key?address=0x22239d00abc');
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true, key: '0x4fb2', getter: 'get_owner' });
});

test('GET /api/chain/key reports get_public_key when the direct probe answers', async (t) => {
  const { port } = await setup(t, {
    readPublicKey: async () => ['0xabc'],
    readControllerPublicKey: async () => { throw new Error('must not be called'); },
  });
  const out = await call(port, 'GET', '/api/chain/key?address=0x22239d00abc');
  assert.equal(out.status, 200);
  assert.equal(out.json.getter, 'get_public_key');
  assert.equal(out.json.key, '0xabc');
});

test('GET /api/chain/key refuses a non-felt address, a silent chain and an empty key', async (t) => {
  let mode = 'down';
  const { port } = await setup(t, {
    readPublicKey: async () => { throw new Error('down'); },
    readControllerPublicKey: async () => (mode === 'zero' ? ['0x0'] : (() => {
      throw new Error('down');
    })()),
  });
  const bad = await call(port, 'GET', '/api/chain/key?address=nope');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /hex felt/);
  const down = await call(port, 'GET', '/api/chain/key?address=0x22239d00abc');
  assert.equal(down.status, 502);
  assert.match(down.json.error, /chain read of 0x22239d00abc failed/);
  mode = 'zero';
  const zero = await call(port, 'GET', '/api/chain/key?address=0x22239d00abc');
  assert.equal(zero.status, 502);
  assert.match(zero.json.error, /no owner key/);
});

// ---------------------------------------------------------------- engine -> proposal

test('the engine creates a proposal only when the live mandate blocks', async (t) => {
  const { port } = await setup(t);

  const denied = await ask(port, '25');
  assert.equal(denied.decision.verdict, 'DENY');
  assert.equal(denied.decision.code, 'over-per-call-cap');
  assert.ok(denied.proposal);
  assert.equal(denied.proposal.status, 'PENDING');
  assert.match(denied.decision.reason, /per-call cap/);

  const allowed = await ask(port, '5');
  assert.equal(allowed.decision.verdict, 'ALLOW');
  assert.equal(allowed.proposal, null);

  const stranger = await ask(port, '5', STRANGER);
  assert.equal(stranger.decision.verdict, 'DENY');
  assert.equal(stranger.decision.code, 'recipient-not-allowed');

  const list = await call(port, 'GET', '/api/proposals');
  assert.equal(list.json.proposals.length, 2, 'only the two blocked asks became proposals');
});

// ---------------------------------------------------------------- preview

test('preview shows the exact call, side effects, and the digest that will be signed', async (t) => {
  const { port } = await setup(t);
  const { proposal } = await ask(port, '25');
  const resolution = amendTo(30);

  const preview = await call(port, 'POST', '/api/preview', {
    proposalId: proposal.id, resolution,
  });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json.digest, resolutionDigest(preview.json.proposal, resolution));
  assert.equal(preview.json.calls.length, 1);
  assert.equal(preview.json.calls[0].to, GATE);
  assert.equal(preview.json.calls[0].entrypoint, 'set_spending_policy');
  assert.deepEqual(preview.json.calls[0].calldata,
    [SESSION, TOKEN, '0x1e', '0x0', '0x64', '0x0', '0x278d00']);
  assert.ok(preview.json.sideEffects.some((s) => s.startsWith('WARNING')),
    'the window-restart warning must be shown before signing');

  const decline = await call(port, 'POST', '/api/preview', {
    proposalId: proposal.id, resolution: { type: 'decline' },
  });
  assert.equal(decline.status, 200);
  assert.deepEqual(decline.json.calls, []);
});

test('approve-once produces the owner transfer, not extra agent power', async (t) => {
  const { port } = await setup(t);
  const { proposal } = await ask(port, '25');
  const resolution = { type: 'execute-once' };

  const preview = await call(port, 'POST', '/api/preview', {
    proposalId: proposal.id, resolution,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.calls[0].to, TOKEN);
  assert.equal(preview.json.calls[0].entrypoint, 'transfer');
  assert.deepEqual(preview.json.calls[0].calldata, [MERCHANT, '0x19', '0x0']);
  assert.match(preview.json.sideEffects.join(' '), /owner \(not the agent\)/);
});

// ---------------------------------------------------------------- owner signature

test('only the owner key resolves a proposal, and a signature cannot be replayed', async (t) => {
  const { port } = await setup(t);
  const { proposal } = await ask(port, '25');
  const resolution = amendTo(30);

  const unsigned = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution,
  });
  assert.equal(unsigned.status, 400);
  assert.match(unsigned.json.error, /signature/i);

  const digest = resolutionDigest(proposal, resolution);
  const attackerSig = signResolution(digest, ATTACKER_PRIV);
  const forged = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: attackerSig,
  });
  assert.equal(forged.status, 400);
  assert.match(forged.json.error, /OWNER key|does not verify/i);

  let list = await call(port, 'GET', '/api/proposals');
  assert.equal(list.json.proposals[0].status, 'PENDING', 'failed attempts must not resolve');

  const ownerSig = signResolution(digest, OWNER_PRIV);
  const tampered = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id,
    resolution: amendTo(50),
    signature: ownerSig,
  });
  assert.equal(tampered.status, 400, 'a signature for 30 cannot approve 50');

  const ok = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: ownerSig,
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.proposal.status, 'AMENDED');
  assert.equal(ok.json.proposal.ownerPublicKeyAtResolution, OWNER_PUB);

  const again = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: ownerSig,
  });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /already AMENDED/);
});

// ---------------------------------------------------------------- submission

test('a typed-data approval resolves, and the audit re-verifies it', async (t) => {
  const { port } = await setup(t);
  const { proposal } = await ask(port, '25');
  const resolution = amendTo(30);
  const digest = resolutionDigest(proposal, resolution);
  const base = {
    chainId: 'SN_SEPOLIA',
    accountAddress: GATE,
    kind: 'resolution',
    digest,
    note: 'Raise the per-call cap to 30 for this token.',
    privateKey: OWNER_PRIV,
  };

  const wrongChain = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id,
    resolution,
    signature: signMandateAction({ ...base, chainId: 'SN_MAIN' }),
  });
  assert.equal(wrongChain.status, 400, 'a carrier for another chain must be refused');

  const ok = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id,
    resolution,
    signature: signMandateAction(base),
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.proposal.signature.scheme, 'snip12-v1');

  const audit = await call(port, 'GET', '/api/audit');
  assert.equal(audit.status, 200);
  assert.equal(audit.json.proposals[0].signatureValidNow, true,
    'the audit must re-verify the typed-data envelope against the current owner key');
});

test('submit refuses pending, a rotated owner key, and a second submission', async (t) => {
  let owner = OWNER_PUB;
  let submitted = 0;
  const { port } = await setup(t, {
    readOwnerKey: async () => owner,
    submitCalls: async () => {
      submitted += 1;
      return { status: 'SUCCEEDED', tx_hash: '0xfeed' };
    },
  });

  const { proposal } = await ask(port, '25');
  const pendingSubmit = await call(port, 'POST', '/api/submit', {
    proposalId: proposal.id,
  });
  assert.equal(pendingSubmit.status, 409);
  assert.equal(submitted, 0);

  const resolution = amendTo(30);
  const digest = resolutionDigest(proposal, resolution);
  const resolved = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: signResolution(digest, OWNER_PRIV),
  });
  assert.equal(resolved.status, 200);

  owner = ATTACKER_PUB;
  const rotated = await call(port, 'POST', '/api/submit', { proposalId: proposal.id });
  assert.equal(rotated.status, 409);
  assert.match(rotated.json.error, /owner key on chain has changed/i);
  assert.equal(submitted, 0, 'a rotated key must stop the transaction before it is sent');

  owner = OWNER_PUB;
  const first = await call(port, 'POST', '/api/submit', { proposalId: proposal.id });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.submission.status, 'SUCCEEDED');
  assert.equal(first.json.submission.calls[0].entrypoint, 'set_spending_policy');
  assert.equal(submitted, 1);

  const second = await call(port, 'POST', '/api/submit', { proposalId: proposal.id });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /already submitted/i);
  assert.equal(submitted, 1, 'the same approval must never execute twice');
});

test('submit refuses when the live mandate already moved past the approval', async (t) => {
  let current = policy();
  let submitted = 0;
  const { port } = await setup(t, {
    readMandate: async () => current,
    submitCalls: async () => {
      submitted += 1;
      return { status: 'SUCCEEDED', tx_hash: '0xbeef' };
    },
  });

  const { proposal } = await ask(port, '25');
  const resolution = amendTo(30);
  const digest = resolutionDigest(proposal, resolution);
  const resolved = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: signResolution(digest, OWNER_PRIV),
  });
  assert.equal(resolved.status, 200);

  current = policy({ maxPerCall: 40n });
  const out = await call(port, 'POST', '/api/submit', { proposalId: proposal.id });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /not above the current cap/i);
  assert.equal(submitted, 0, 'a stale approval must not be executed against a new mandate');
});

// The window-cap amendment (the OBS-35 dead-corner fix): resolve -> submit,
// the per-call cap preserved on the wire, the window cap raised.
test('raise-window-cap flows through resolve and submit end to end', async (t) => {
  let submitted = null;
  const { port } = await setup(t, {
    submitCalls: async (calls) => {
      submitted = calls;
      return { status: 'SUCCEEDED', tx_hash: '0xbeef' };
    },
  });

  const { proposal } = await ask(port, '150');
  const resolution = amendWindowTo(200);
  const digest = resolutionDigest(proposal, resolution);
  const resolved = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: signResolution(digest, OWNER_PRIV),
  });
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(resolved.json.proposal.status, 'AMENDED');

  const out = await call(port, 'POST', '/api/submit', { proposalId: proposal.id });
  assert.equal(out.status, 200, out.text);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].entrypoint, 'set_spending_policy');
  // per-call cap preserved (20 = 0x14), window cap 100 -> 200 (0xc8), window seconds kept.
  assert.deepEqual(submitted[0].calldata.slice(2), ['0x14', '0x0', '0xc8', '0x0', '0x278d00']);
});

test('an unknown amendment kind is still refused after the window kind was added', async (t) => {
  const { port } = await setup(t);
  const { proposal } = await ask(port, '150');
  const bogus = {
    type: 'amend',
    amendment: { kind: 'lower-window-cap', token: TOKEN, maxPerWindow: '50' },
  };
  const digest = resolutionDigest(proposal, bogus);
  const out = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution: bogus, signature: signResolution(digest, OWNER_PRIV),
  });
  assert.equal(out.status, 400);
  assert.match(out.json.error, /unknown amendment kind/);
});

// ---------------------------------------------------------------- audit

test('audit re-verifies every resolution against the current owner key', async (t) => {
  let owner = OWNER_PUB;
  const { port } = await setup(t, { readOwnerKey: async () => owner });

  const { proposal } = await ask(port, '25');
  const resolution = amendTo(30);
  const digest = resolutionDigest(proposal, resolution);
  await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: signResolution(digest, OWNER_PRIV),
  });

  let audit = await call(port, 'GET', '/api/audit');
  assert.equal(audit.status, 200);
  assert.equal(audit.json.proposals[0].signatureValidNow, true);
  assert.equal(audit.json.proposals[0].digest, digest);

  owner = ATTACKER_PUB;
  audit = await call(port, 'GET', '/api/audit');
  assert.equal(audit.json.proposals[0].signatureValidNow, false,
    'a key change must be visible, not hidden');
  assert.equal(audit.json.currentOwner, ATTACKER_PUB);
});

// ---------------------------------------------------------------- mandate + input

test('mandate endpoint exposes the live policy and the registered gates', async (t) => {
  const { port } = await setup(t);
  const out = await call(port, 'GET', '/api/mandate');
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.gate, GATE);
  assert.equal(out.json.mandate.maxPerCall, '20');
  assert.equal(out.json.ownerPublicKey, OWNER_PUB);
  assert.equal(out.json.ownerKeyMatchesRecord, true);
  assert.deepEqual(out.json.gates.map((g) => g.namespace), ['spend', 'files']);
  assert.ok(out.json.statusError, 'the unreachable status RPC is reported, not hidden');
});

test('rejects malformed requests and unknown routes', async (t) => {
  const { port } = await setup(t);

  const badAmount = await call(port, 'POST', '/api/requests', {
    recipient: MERCHANT, amount: '-5',
  });
  assert.equal(badAmount.status, 400);
  assert.match(badAmount.json.error, /positive whole number/i);

  const badAddress = await call(port, 'POST', '/api/requests', {
    recipient: 'merchant.example', amount: '5',
  });
  assert.equal(badAddress.status, 400);

  const unknown = await call(port, 'GET', '/api/nope');
  assert.equal(unknown.status, 404);

  const badJson = await fetch(`http://127.0.0.1:${port}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(badJson.status, 400);
});
