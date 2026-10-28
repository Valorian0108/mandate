// The stuck-spinner and false-mismatch fixes, pinned after both bit live
// (2026-10-28, OBS-35):
//
// 1. STUCK "Reading…": the owner's refresh spun forever because NONE of the
//    server's chain reads had a timeout - one silent node froze /api/mandate
//    and the button with it. A read must FAIL LOUDLY within a bounded time,
//    never hang. Pinned here against a black-hole server (accepts the
//    connection, never answers) for mandate-reader's call(), the server's
//    rpcCall(), and the /api/mandate endpoint's status read.
//
// 2. FALSE "RECORD MISMATCH": the lock card compared the chain's live owner
//    key against state.keys.owner.public_key - a slot that is deliberately
//    HISTORICAL (the pre-handover pasted key, kept forever as evidence). The
//    baseline is keys.owner_current (the phase-6 handover key), with the
//    historical slot only as a fallback for records that predate it. The lock
//    card must keep its teeth: a genuinely different live key still mismatches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { call } from '../src/mandate-reader.mjs';
import { rpcCall, createConsoleServer } from '../web/server.mjs';

// Accepts connections and never answers - the exact failure mode that hung
// the console: no refusal, no response, silence.
async function blackHole(t) {
  const server = createServer(() => { /* deliberate silence */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// Answers like a JSON-RPC node, to prove the timeout plumbing did not break
// the normal path.
async function answeringNode(t) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: ['0x1'] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

// ---------------------------------------------------------------- reader + rpcCall

test('mandate-reader call() fails loudly within its timeout against a silent node', async (t) => {
  const url = await blackHole(t);
  const t0 = Date.now();
  await assert.rejects(
    () => call('0x2502', '0x1234', [], { rpcUrl: url, timeoutMs: 250 }),
    /did not answer within/,
  );
  assert.ok(Date.now() - t0 < 5000, 'the read must fail in bounded time, not hang');
});

test('rpcCall returns a loud TIMEOUT error against a silent node', async (t) => {
  const url = await blackHole(t);
  const t0 = Date.now();
  const out = await rpcCall(url, 'starknet_blockNumber', [], { timeoutMs: 250 });
  assert.ok(Date.now() - t0 < 5000, 'the read must fail in bounded time, not hang');
  assert.equal(out.error.code, 'TIMEOUT');
  assert.match(out.error.message, /did not answer within/);
});

test('rpcCall still parses a node that answers (timeout plumbing broke nothing)', async (t) => {
  const url = await answeringNode(t);
  const out = await rpcCall(url, 'starknet_blockNumber', [], { timeoutMs: 5000 });
  assert.deepEqual(out.result, ['0x1']);
  assert.equal(out.error, undefined);
});

// ---------------------------------------------------------------- /api/mandate end to end

const LIVE = '0x4fb24b55f25e2018a28d1f62ad37d43a366d1282d875d438987a82cf951e7d2';
const HISTORICAL = '0x3166ad27f1bedee6af7520d71ee60e1bb3719ab2d26d52fc7fdfc5a3cb4fed0';
const ATTACKER = '0xdeadbeef';

function policyFixture() {
  return {
    sessionPublicKey: '0x100d',
    validUntil: 2000000000,
    maxCalls: 10,
    callsUsed: 0,
    allowedEntrypointsLen: 1,
    allowedSelectors: ['0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e'],
    token: '0x01f5',
    maxPerCall: 20n,
    maxPerWindow: 100n,
    windowSeconds: 2592000,
    spentInWindow: 0n,
    windowStart: Math.floor(Date.now() / 1000) - 100,
    allowedRecipients: ['0x079e'],
  };
}

async function setupServer(t, { url, ownerKey, withCurrent = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-timeout-'));
  const state = {
    chain_id: 'SN_SEPOLIA',
    contracts: { gate_account: { address: '0x2502' } },
    keys: {
      owner: { address: '0x2502', public_key: HISTORICAL },
      agent_session: { session_public_key: '0x100d' },
      merchant: { address: '0x079e' },
      stranger: { address: '0x16cb' },
    },
    mandate: { merchant_allowlist: { allowed: ['0x079e'] } },
    rpc_endpoints_verified: { cartridge: { url } },
    layer_c_demo: [],
  };
  if (withCurrent) state.keys.owner_current = { public_key: LIVE };
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const server = createConsoleServer({
    statePath,
    storePath: join(dir, 'proposals.json'),
    readMandate: async () => policyFixture(),
    readOwnerKey: async () => ownerKey,
    rpcTimeoutMs: 250,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

async function getMandate(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/mandate`);
  return { status: res.status, json: await res.json() };
}

test('/api/mandate answers with a loud statusError when the status RPC is silent - never hangs', async (t) => {
  const url = await blackHole(t);
  const port = await setupServer(t, { url, ownerKey: LIVE });
  const t0 = Date.now();
  const out = await getMandate(port);
  assert.ok(Date.now() - t0 < 5000, 'the endpoint must answer in bounded time');
  assert.equal(out.status, 200);
  assert.match(out.json.statusError, /did not answer within/,
    'a silent node must be reported loudly, not hidden and not hung');
  assert.equal(out.json.status, null);
});

// ---------------------------------------------------------------- owner-key baseline

test('the lock card baseline is keys.owner_current, not the HISTORICAL owner slot', async (t) => {
  const url = await blackHole(t);
  const port = await setupServer(t, { url, ownerKey: LIVE });
  const out = await getMandate(port);
  assert.equal(out.json.recordedOwnerPublicKey, LIVE,
    'the recorded baseline must come from owner_current (the handover key)');
  assert.equal(out.json.ownerKeyMatchesRecord, true,
    'the live key equals the handover record - no false RECORD MISMATCH');
});

test('records without owner_current fall back to keys.owner.public_key', async (t) => {
  const url = await blackHole(t);
  const port = await setupServer(t, { url, ownerKey: HISTORICAL, withCurrent: false });
  const out = await getMandate(port);
  assert.equal(out.json.recordedOwnerPublicKey, HISTORICAL);
  assert.equal(out.json.ownerKeyMatchesRecord, true);
});

test('the lock card keeps its teeth: a genuinely different live key still mismatches', async (t) => {
  const url = await blackHole(t);
  const port = await setupServer(t, { url, ownerKey: ATTACKER });
  const out = await getMandate(port);
  assert.equal(out.json.ownerKeyMatchesRecord, false,
    'a real key change must still lock the card - the fix narrows the baseline, not the check');
});
