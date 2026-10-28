// The owner-action upgrade path (how v0.4 gets installed), tested as the ONLY
// thing standing between "a class was declared" and "the gate's code changes"
// (OBS-08). No network: the class-hash read, the estimate, the submitter and
// the receipt reader are all injected; the transaction is really built and
// really signed by web/tx-signer.js - the same module the browser runs - so
// these tests exercise the exact bytes a tab would send.
//
// The controls that matter:
//   - the status endpoint reports the RECORDED pending class next to the
//     chain's CURRENT class, and says honestly when nothing is pending or the
//     node cannot be reached (loud failure, never a silent pass)
//   - the plan is built from the state file's pending_upgrade - never from the
//     request - and prices exactly one call: upgrade(new_class_hash) on the gate
//   - the plan refuses when nothing is recorded to install, and refuses when
//     the chain says the gate ALREADY runs that class
//   - the signed upgrade relays byte for byte through /api/broadcast, and its
//     record is tagged action:'upgrade' with proposalId null (it executes no
//     proposal; the tag is audit metadata, not authorization - the relay's
//     three controls are unchanged and already pinned in tx-broadcast.test.mjs)
//   - once the chain shows the new class, planning refuses again: the replay
//     control is the CHAIN itself, not a flag we remember

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStarkKey } from '@scure/starknet';
import { createConsoleServer } from '../web/server.mjs';
import { buildInvokeTx, chainIdFelt, signInvokeTx } from '../web/tx-signer.js';

const OWNER_PRIV = '0x1';
const ATTACKER_PRIV = '0x2';
const OWNER_PUB = getStarkKey(OWNER_PRIV);

const GATE = '0x2502';
const TOKEN = '0x01f5';
const SESSION = '0x100d';
const MERCHANT = '0x079e';
const STRANGER = '0x16cb';
const REGISTRY = '0x3484';

// Fixture class hashes: the gate currently runs OLD, and NEW is declared and
// waiting in the state file's pending_upgrade slot.
const OLD_CLASS = '0x3acf8f1f9ce4d98932796e09a38d880a41b23dcf8aa07bde15484ad1a56b8cb';
const NEW_CLASS = '0x15d47cb5926f5de856f3e2f497094ffa2d297aa5d910a3e634caa0929cd35ff';

const CHAIN = chainIdFelt('SN_SEPOLIA');
const TX_HASH = '0xabc123';
const ESTIMATE = {
  nonce: '0x7',
  resourceBounds: {
    l1_gas: { max_amount: '0x186a0', max_price_per_unit: '0x5f5e100' },
    l2_gas: { max_amount: '0x2dc6c0', max_price_per_unit: '0x1' },
    l1_data_gas: { max_amount: '0x186a0', max_price_per_unit: '0x2' },
  },
};

const PENDING = {
  version: 'v0.4 (owner-level guard: self OR registered controller)',
  class_hash: NEW_CLASS,
  declare_tx: '0x663510bc1bc05182c8f074b3990302a89220430a6bfe2a9a254f6747684070',
  declared_at: '2026-10-27',
  install_path: 'OWNER-signed invoke through the pasted-key path',
};

// What the tab does with the plan: build the body, sign it with the owner key.
function browserSignUpgrade(overrides = {}) {
  const built = buildInvokeTx({
    sender: overrides.sender ?? GATE,
    calls: overrides.calls ?? [{ to: GATE, entrypoint: 'upgrade', calldata: [NEW_CLASS] }],
    nonce: overrides.nonce ?? ESTIMATE.nonce,
    resourceBounds: overrides.resourceBounds ?? ESTIMATE.resourceBounds,
    chainId: overrides.chainId ?? CHAIN,
    tip: 0,
  });
  const { body } = signInvokeTx(built, built.body, overrides.priv ?? OWNER_PRIV);
  return body;
}

function policy() {
  return {
    sessionPublicKey: SESSION,
    validUntil: 2000000000,
    maxCalls: 10,
    callsUsed: 2,
    allowedEntrypointsLen: 1,
    allowedSelectors: [],
    token: TOKEN,
    maxPerCall: 100n,
    maxPerWindow: 100n,
    windowSeconds: 2592000,
    spentInWindow: 0n,
    windowStart: Math.floor(Date.now() / 1000) - 100,
    allowedRecipients: [MERCHANT],
  };
}

function makeState(dir, overrides = {}) {
  const state = {
    chain_id: 'SN_SEPOLIA',
    chain_id_hex: '0x534e5f5345504f4c4941',
    contracts: {
      gate_account: { address: GATE, version: 'v0.3' },
      evidence_registry: { address: REGISTRY },
    },
    selectors: {
      anchor: '0x03cc2a1f',
      get_anchor: '0x019d579b',
      get_anchor_count: '0x0313111e',
    },
    keys: {
      owner: { address: GATE, public_key: OWNER_PUB },
      agent_session: { session_public_key: SESSION },
      merchant: { address: MERCHANT },
      stranger: { address: STRANGER },
    },
    mandate: { merchant_allowlist: { allowed: [MERCHANT] } },
    layer_d: { anchors: [] },
    // Deliberately unreachable: nothing in these tests may touch the network.
    rpc_endpoints_verified: { cartridge: { url: 'http://127.0.0.1:1' } },
    layer_c_demo: [],
    pending_upgrade: PENDING,
    ...overrides,
  };
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

async function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-upgrade-'));
  const statePath = makeState(dir, overrides.state);
  const storePath = join(dir, 'proposals.json');
  const submissionsPath = join(dir, 'submissions.json');
  const sent = [];
  const estimated = [];
  const classReads = [];
  let currentClass = overrides.currentClass ?? OLD_CLASS;
  let classReadFails = false;

  const server = createConsoleServer({
    statePath,
    storePath,
    readMandate: async () => policy(),
    readOwnerKey: async () => OWNER_PUB,
    dryRunEstimate: async (calls) => {
      estimated.push(calls);
      return ESTIMATE;
    },
    readClassHash: async (gate) => {
      classReads.push(gate);
      if (classReadFails) throw new Error('node unreachable (test)');
      return currentClass;
    },
    sendTransaction: async (body) => {
      sent.push(body);
      return { jsonrpc: '2.0', id: 1, result: { transaction_hash: TX_HASH } };
    },
    readReceipt: async () => ({
      jsonrpc: '2.0', id: 1,
      result: { execution_status: 'SUCCEEDED', finality_status: 'ACCEPTED_ON_L2' },
    }),
    ...overrides.server,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const readSubmissions = () => JSON.parse(readFileSync(submissionsPath, 'utf8')).submissions;
  return {
    port, dir, submissionsPath, sent, estimated, classReads, readSubmissions,
    setClass: (h) => { currentClass = h; },
    failClassReads: () => { classReadFails = true; },
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

// ---------------------------------------------------------------- status

test('upgrade status shows the recorded pending class next to the chain\'s current class', async (t) => {
  const { port, classReads } = await setup(t);

  const out = await call(port, 'GET', '/api/owner/upgrade');
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.recordedVersion, 'v0.3');
  assert.equal(out.json.gate, GATE);
  assert.equal(out.json.currentClassHash, OLD_CLASS);
  assert.equal(out.json.pending.class_hash, NEW_CLASS);
  assert.equal(out.json.pending.declare_tx, PENDING.declare_tx);
  assert.equal(out.json.alreadyApplied, false);
  // The current class came FROM THE CHAIN, for this gate - not from the file.
  assert.deepEqual(classReads, [GATE]);
});

test('upgrade status with nothing pending says so honestly', async (t) => {
  const { port } = await setup(t, { state: { pending_upgrade: undefined } });

  const out = await call(port, 'GET', '/api/owner/upgrade');
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.pending, null);
  assert.equal(out.json.alreadyApplied, null);
  assert.equal(out.json.currentClassHash, OLD_CLASS);
});

test('upgrade status when the node cannot be reached fails loudly', async (t) => {
  const { port, failClassReads } = await setup(t);
  failClassReads();

  const out = await call(port, 'GET', '/api/owner/upgrade');
  assert.equal(out.status, 502, out.text);
  assert.match(out.json.error, /node/i);
});

// ---------------------------------------------------------------- plan

test('plan prices exactly one owner call: upgrade(pending class) on the gate', async (t) => {
  const { port, estimated } = await setup(t);

  const out = await call(port, 'POST', '/api/owner/plan', { action: 'upgrade' });
  assert.equal(out.status, 200, out.text);
  const plan = out.json;
  assert.equal(plan.kind, 'owner-action');
  assert.equal(plan.action, 'upgrade');
  assert.equal(plan.sender, GATE);
  assert.equal(plan.chainIdFelt, CHAIN);
  assert.equal(plan.nonce, ESTIMATE.nonce);
  assert.deepEqual(plan.resourceBounds, ESTIMATE.resourceBounds);
  assert.equal(plan.currentClassHash, OLD_CLASS);
  assert.equal(plan.newClassHash, NEW_CLASS);
  assert.equal(plan.calls.length, 1);
  assert.deepEqual(plan.calls[0], { to: GATE, entrypoint: 'upgrade', calldata: [NEW_CLASS] });
  assert.ok(Array.isArray(plan.sideEffects) && plan.sideEffects.length > 0,
    'the plan must state what an upgrade does, in plain language');
  // The estimate saw exactly the call that was priced.
  assert.deepEqual(estimated[0], plan.calls);
});

test('plan refuses an action that is not upgrade', async (t) => {
  const { port } = await setup(t);

  const out = await call(port, 'POST', '/api/owner/plan', { action: 'selfdestruct' });
  assert.equal(out.status, 400, out.text);
  assert.match(out.json.error, /selfdestruct/);

  const missing = await call(port, 'POST', '/api/owner/plan', {});
  assert.equal(missing.status, 400, missing.text);
});

test('plan refuses when nothing is recorded to install', async (t) => {
  const { port } = await setup(t, { state: { pending_upgrade: undefined } });

  const out = await call(port, 'POST', '/api/owner/plan', { action: 'upgrade' });
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /no pending upgrade/i);
});

test('plan refuses when the chain says the gate already runs the class', async (t) => {
  const { port } = await setup(t, { currentClass: NEW_CLASS });

  const out = await call(port, 'POST', '/api/owner/plan', { action: 'upgrade' });
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /already/i);
});

test('plan class-hash fields are normalised even when the node answers padded', async (t) => {
  // Nodes may return 0x0-prefixed or full-length hex; the plan must compare by
  // VALUE (the state file records the unpadded form).
  const padded = '0x015d47cb5926f5de856f3e2f497094ffa2d297aa5d910a3e634caa0929cd35ff';
  const { port } = await setup(t, { currentClass: padded });

  const out = await call(port, 'POST', '/api/owner/plan', { action: 'upgrade' });
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /already/i);
});

// ---------------------------------------------------------------- broadcast

test('the signed upgrade relays byte for byte and the record is tagged', async (t) => {
  const { port, sent, readSubmissions } = await setup(t);

  const body = browserSignUpgrade();
  const out = await call(port, 'POST', '/api/broadcast', {
    transaction: body,
    action: 'upgrade',
  });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.relayed, true);
  // Byte for byte: the node saw exactly what the tab signed.
  assert.deepEqual(sent[0], body);

  const subs = readSubmissions();
  assert.equal(subs.length, 1);
  assert.equal(subs[0].action, 'upgrade');
  assert.equal(subs[0].proposalId, null);
  assert.equal(subs[0].tx_hash, TX_HASH);
  assert.equal(subs[0].status, 'BROADCAST');

  // The FINAL status still comes only from a receipt, never from the relay.
  const receipt = await call(port, 'GET', `/api/tx/receipt?hash=${TX_HASH}`);
  assert.equal(receipt.status, 200, receipt.text);
  assert.equal(readSubmissions()[0].status, 'SUCCEEDED');
});

test('broadcast refuses an action tag it does not know', async (t) => {
  const { port, sent } = await setup(t);

  const out = await call(port, 'POST', '/api/broadcast', {
    transaction: browserSignUpgrade(),
    action: 'whatever',
  });
  assert.equal(out.status, 400, out.text);
  assert.match(out.json.error, /whatever/);
  assert.equal(sent.length, 0, 'nothing may be sent for an unknown tag');
});

test('broadcast still refuses a wrong-key signature on an upgrade', async (t) => {
  const { port, sent } = await setup(t);

  const out = await call(port, 'POST', '/api/broadcast', {
    transaction: browserSignUpgrade({ priv: ATTACKER_PRIV }),
    action: 'upgrade',
  });
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /signature does not verify/i);
  assert.equal(sent.length, 0);
});

test('after the chain moves, the upgrade cannot be planned twice', async (t) => {
  const { port, sent, readSubmissions, setClass } = await setup(t);

  // Install it: sign, relay, receipt.
  const out = await call(port, 'POST', '/api/broadcast', {
    transaction: browserSignUpgrade(),
    action: 'upgrade',
  });
  assert.equal(out.status, 200, out.text);
  const receipt = await call(port, 'GET', `/api/tx/receipt?hash=${TX_HASH}`);
  assert.equal(receipt.status, 200, receipt.text);
  assert.equal(readSubmissions()[0].status, 'SUCCEEDED');

  // The world changed: the gate now runs the new class. The replay control is
  // the chain itself - planning again must refuse, and status must say applied.
  setClass(NEW_CLASS);
  const again = await call(port, 'POST', '/api/owner/plan', { action: 'upgrade' });
  assert.equal(again.status, 409, again.text);
  assert.match(again.json.error, /already/i);

  const status = await call(port, 'GET', '/api/owner/upgrade');
  assert.equal(status.status, 200, status.text);
  assert.equal(status.json.alreadyApplied, true);
  assert.equal(sent.length, 1, 'exactly one transaction was ever sent');
});
