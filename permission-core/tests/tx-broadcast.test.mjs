// The relay's controls, tested as the ONLY thing standing between a transaction
// and the chain (OBS-08). No network: the estimate, the submitter and the
// receipt reader are all injected; the transactions are really built and really
// signed by web/tx-signer.js - the same module the browser runs - so these tests
// exercise the exact bytes a tab would send.
//
// The checks that matter:
//   - the happy path relays the signed body BYTE FOR BYTE (the server adds,
//     reorders and re-encodes nothing)
//   - a transaction from any other sender is refused even when perfectly signed
//   - a transaction signed by any other key is refused
//   - calldata edited after signing is refused (the recomputed hash differs)
//   - a transaction signed for another chain is refused
//   - a garbage body (declare, v1, no signature, missing bounds) is refused
//   - a state file that disagrees with itself about the chain id is refused
//   - the node's refusals come back VERBATIM, and nothing is recorded as sent
//   - the same proposal cannot be relayed twice once the receipt is final
//   - a submission's FINAL status comes only from a receipt, never from the relay
//   - an anchor record needs a SUCCEEDED receipt AND the chain holding exactly
//     the claimed fingerprint, and the same anchor is never recorded twice

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStarkKey } from '@scure/starknet';
import { createConsoleServer } from '../web/server.mjs';
import { buildInvokeTx, chainIdFelt, signInvokeTx } from '../web/tx-signer.js';
import { resolutionDigest, signResolution } from '../src/proposals.mjs';
import { createEvidenceStore, signEvidence, signIdentity } from '../src/evidence.mjs';

const OWNER_PRIV = '0x1';
const ATTACKER_PRIV = '0x2';
const WITNESS_PRIV = '0x3';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const ATTACKER_PUB = getStarkKey(ATTACKER_PRIV);
const WITNESS_PUB = getStarkKey(WITNESS_PRIV);

const GATE = '0x2502';
const TOKEN = '0x01f5';
const SESSION = '0x100d';
const MERCHANT = '0x079e';
const STRANGER = '0x16cb';
const REGISTRY = '0x3484';
const TRANSFER_SELECTOR =
  '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e';

// The chain id felt is computed by the same function the server uses, so this
// file never pins it from memory (tx-signer.test.mjs pins it against starknet.js).
const CHAIN = chainIdFelt('SN_SEPOLIA');
const MAINNET = chainIdFelt('SN_MAIN');

const TX_HASH = '0xabc123';
const ESTIMATE = {
  nonce: '0x2',
  resourceBounds: {
    l1_gas: { max_amount: '0x186a0', max_price_per_unit: '0x5f5e100' },
    l2_gas: { max_amount: '0x2dc6c0', max_price_per_unit: '0x1' },
    l1_data_gas: { max_amount: '0x186a0', max_price_per_unit: '0x2' },
  },
};
const CALLS = [{ to: TOKEN, entrypoint: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] }];

// What the tab does: build the body from the plan, then sign it. Returns the
// finished RPC body exactly as the browser would POST it to /api/broadcast.
function browserSign(overrides = {}) {
  const built = buildInvokeTx({
    sender: overrides.sender ?? GATE,
    calls: overrides.calls ?? CALLS,
    nonce: overrides.nonce ?? ESTIMATE.nonce,
    resourceBounds: overrides.resourceBounds ?? ESTIMATE.resourceBounds,
    chainId: overrides.chainId ?? CHAIN,
    tip: 0,
  });
  const { body } = signInvokeTx(built, built.body, overrides.priv ?? OWNER_PRIV);
  return body;
}

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

function makeState(dir, overrides = {}) {
  const state = {
    chain_id: 'SN_SEPOLIA',
    chain_id_hex: '0x534e5f5345504f4c4941',
    contracts: {
      gate_account: { address: GATE },
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
    ...overrides,
  };
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

async function setup(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tx-relay-'));
  const statePath = makeState(dir, overrides.state);
  const storePath = join(dir, 'proposals.json');
  const submissionsPath = join(dir, 'submissions.json');
  const sent = [];
  const estimated = [];
  let owner = OWNER_PUB;

  const server = createConsoleServer({
    statePath,
    storePath,
    readMandate: async () => policy(),
    readOwnerKey: async () => owner,
    dryRunEstimate: async (calls) => {
      estimated.push(calls);
      return ESTIMATE;
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
  return {
    port, dir, statePath, storePath, submissionsPath, sent, estimated,
    setOwner: (pub) => { owner = pub; },
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

const amendTo = (cap) => ({
  type: 'amend',
  amendment: { kind: 'raise-per-call-cap', token: TOKEN, maxPerCall: String(cap) },
});

// Create a blocked ask and resolve it with a real owner signature - the exact
// state the console is in when the owner presses "send to chain".
async function approvedProposal(port) {
  const askOut = await call(port, 'POST', '/api/requests', { recipient: MERCHANT, amount: '25' });
  assert.equal(askOut.status, 200, askOut.text);
  const proposal = askOut.json.proposal;
  assert.ok(proposal, 'the over-cap ask must create a proposal');
  const resolution = amendTo(30);
  const digest = resolutionDigest(proposal, resolution);
  const resolved = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: signResolution(digest, OWNER_PRIV),
  });
  assert.equal(resolved.status, 200, resolved.text);
  return { proposal: resolved.json.proposal, resolution, digest };
}

// ---------------------------------------------------------------- plan

test('plan prices the live proposal for the browser to sign', async (t) => {
  const { port, estimated } = await setup(t);
  const { proposal, digest } = await approvedProposal(port);

  const plan = await call(port, 'POST', '/api/tx/plan', { proposalId: proposal.id });
  assert.equal(plan.status, 200, plan.text);
  assert.equal(plan.json.kind, 'proposal');
  assert.equal(plan.json.proposalId, proposal.id);
  assert.equal(plan.json.digest, digest);
  assert.equal(plan.json.sender, GATE);
  assert.equal(plan.json.chainId, 'SN_SEPOLIA');
  assert.equal(BigInt(plan.json.chainIdFelt), BigInt(CHAIN));
  assert.equal(plan.json.nonce, ESTIMATE.nonce);
  assert.deepEqual(plan.json.resourceBounds, ESTIMATE.resourceBounds);
  assert.equal(plan.json.calls.length, 1);
  assert.equal(plan.json.calls[0].to, GATE);
  assert.equal(plan.json.calls[0].entrypoint, 'set_spending_policy');
  // The estimate was run over EXACTLY the calls the plan hands the browser.
  assert.deepEqual(estimated, [plan.json.calls]);
});

test('plan refuses a pending proposal, a stranger, and a missing id', async (t) => {
  const { port } = await setup(t);
  const askOut = await call(port, 'POST', '/api/requests', { recipient: MERCHANT, amount: '25' });
  const pending = askOut.json.proposal;

  const notResolved = await call(port, 'POST', '/api/tx/plan', { proposalId: pending.id });
  assert.equal(notResolved.status, 409);
  assert.match(notResolved.json.error, /PENDING/);

  const unknown = await call(port, 'POST', '/api/tx/plan', { proposalId: 'nope' });
  assert.equal(unknown.status, 404);

  const missing = await call(port, 'POST', '/api/tx/plan', {});
  assert.equal(missing.status, 400);
});

test('plan refuses an approval the rotated owner key no longer covers', async (t) => {
  const { port, setOwner } = await setup(t);
  const { proposal } = await approvedProposal(port);

  setOwner(ATTACKER_PUB); // the owner rotated their key after signing
  const plan = await call(port, 'POST', '/api/tx/plan', { proposalId: proposal.id });
  assert.equal(plan.status, 409);
  assert.match(plan.json.error, /owner key on chain has changed/i);
});

test('plan refuses a proposal that already reached the chain', async (t) => {
  const { port, dir, submissionsPath } = await setup(t);
  const { proposal } = await approvedProposal(port);
  writeFileSync(submissionsPath, JSON.stringify({
    submissions: [{ proposalId: proposal.id, status: 'SUCCEEDED', tx_hash: '0xfeed' }],
  }, null, 2));
  assert.ok(existsSync(join(dir, 'submissions.json')));

  const plan = await call(port, 'POST', '/api/tx/plan', { proposalId: proposal.id });
  assert.equal(plan.status, 409);
  assert.match(plan.json.error, /already went to the chain/);
});

test('the relay refuses to work from a state file that disagrees with itself', async (t) => {
  const { port, statePath } = await setup(t);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.chain_id_hex = MAINNET; // label says Sepolia, hex says mainnet
  writeFileSync(statePath, JSON.stringify(state, null, 2));

  const out = await call(port, 'POST', '/api/broadcast', { transaction: browserSign() });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /disagrees with itself about the chain id/);
});

// ---------------------------------------------------------------- broadcast

test('the happy path relays the browser-signed body byte for byte', async (t) => {
  const { port, sent } = await setup(t);
  const { proposal } = await approvedProposal(port);
  const plan = await call(port, 'POST', '/api/tx/plan', { proposalId: proposal.id });
  assert.equal(plan.status, 200, plan.text);

  // Sign the plan exactly like the tab does, then hand the finished body over.
  const body = browserSign({
    calls: plan.json.calls,
    nonce: plan.json.nonce,
    resourceBounds: plan.json.resourceBounds,
    sender: plan.json.sender,
    chainId: plan.json.chainIdFelt,
  });
  const out = await call(port, 'POST', '/api/broadcast', {
    transaction: body, proposalId: proposal.id,
  });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.relayed, true);
  assert.equal(out.json.result.transaction_hash, TX_HASH);

  // Byte for byte: the server added, reordered and re-encoded nothing.
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], body);

  // Recorded as BROADCAST - not as a success the chain never confirmed.
  assert.equal(out.json.submission.status, 'BROADCAST');
  assert.equal(out.json.submission.via, 'relay');
  assert.equal(out.json.submission.proposalId, proposal.id);
  assert.equal(out.json.submission.tx_hash, TX_HASH);
});

test('a perfectly signed transaction from another sender is refused', async (t) => {
  const { port, sent } = await setup(t);
  // The owner key really signs this one - it is simply not OUR account. The
  // sender check is the only thing between it and the chain.
  const body = browserSign({ sender: MERCHANT });
  const out = await call(port, 'POST', '/api/broadcast', { transaction: body });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /not the GateAccount/);
  assert.equal(sent.length, 0, 'nothing may reach the node');
});

test('a transaction signed by any other key is refused', async (t) => {
  const { port, sent } = await setup(t);
  const body = browserSign({ priv: ATTACKER_PRIV });
  const out = await call(port, 'POST', '/api/broadcast', { transaction: body });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /does not verify against the owner key/);
  assert.equal(sent.length, 0);
});

test('calldata edited after signing is refused', async (t) => {
  const { port, sent } = await setup(t);
  const body = browserSign();
  // One flipped argument: 0x5 becomes 0x6. Everything else, including the
  // signature, is untouched - the recomputed hash is what catches it.
  const idx = body.calldata.indexOf('0x5');
  assert.ok(idx >= 0, 'the amount must be in the compiled calldata');
  body.calldata[idx] = '0x6';
  const out = await call(port, 'POST', '/api/broadcast', { transaction: body });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /does not verify/);
  assert.equal(sent.length, 0);
});

test('a transaction signed for another chain is refused', async (t) => {
  const { port, sent } = await setup(t);
  // Same key, same calls, same everything - but the hash the owner signed was
  // built with the MAINNET chain id. On this Sepolia relay it must not fly.
  const body = browserSign({ chainId: MAINNET });
  const out = await call(port, 'POST', '/api/broadcast', { transaction: body });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /does not verify/);
  assert.equal(sent.length, 0);
});

test('garbage bodies are refused before any crypto runs', async (t) => {
  const { port, sent } = await setup(t);
  const good = browserSign();

  const cases = [
    [{}, /transaction is required/],
    [{ transaction: '0x1' }, /transaction is required/],
    [{ transaction: { ...good, signature: [] } }, /carries no signature/],
    [{ transaction: { ...good, type: 'DECLARE' } }, /only INVOKE/],
    [{ transaction: { ...good, version: '0x1' } }, /version 0x3/],
    [{ transaction: { ...good, resource_bounds: { l1_gas: good.resource_bounds.l1_gas, l2_gas: good.resource_bounds.l2_gas } } }, /l1_data_gas/],
    [{ transaction: { ...good, calldata: [] } }, /calldata is required/],
  ];
  for (const [payload, pattern] of cases) {
    const out = await call(port, 'POST', '/api/broadcast', payload);
    assert.equal(out.status, 400, JSON.stringify(payload.transaction ?? payload));
    assert.match(out.json.error, pattern);
  }
  assert.equal(sent.length, 0);
});

test('the node refusal comes back verbatim and nothing is recorded as sent', async (t) => {
  const nodeError = { code: 29, message: 'Insufficient account balance', data: { x: 1 } };
  const { port, submissionsPath } = await setup(t, {
    server: {
      sendTransaction: async () => ({ jsonrpc: '2.0', id: 1, error: nodeError }),
    },
  });
  const out = await call(port, 'POST', '/api/broadcast', { transaction: browserSign() });
  assert.equal(out.status, 502);
  assert.equal(out.json.relayed, false);
  assert.deepEqual(out.json.error, nodeError, 'the node answer must be verbatim');
  assert.match(out.json.message, /Insufficient account balance/);
  assert.ok(!existsSync(submissionsPath), 'a refused transaction is not a submission');
});

test('a node answer with neither hash nor error is reported, not invented', async (t) => {
  const weird = { jsonrpc: '2.0', id: 1, result: {} };
  const { port } = await setup(t, {
    server: { sendTransaction: async () => weird },
  });
  const out = await call(port, 'POST', '/api/broadcast', { transaction: browserSign() });
  assert.equal(out.status, 502);
  assert.deepEqual(out.json.answer, weird, 'verbatim, so nothing is hidden');
});

test('broadcast refuses an unknown proposal and a proposal already on chain', async (t) => {
  const { port, sent, submissionsPath } = await setup(t);
  const { proposal } = await approvedProposal(port);
  const body = browserSign();

  const unknown = await call(port, 'POST', '/api/broadcast', {
    transaction: body, proposalId: 'nope',
  });
  assert.equal(unknown.status, 404);

  // Once the receipt has confirmed a first broadcast, the replay guard fires.
  const first = await call(port, 'POST', '/api/broadcast', {
    transaction: body, proposalId: proposal.id,
  });
  assert.equal(first.status, 200, first.text);
  const receipt = await call(port, 'GET', `/api/tx/receipt?hash=${TX_HASH}`);
  assert.equal(receipt.json.final, true);

  const second = await call(port, 'POST', '/api/broadcast', {
    transaction: browserSign({ nonce: '0x3' }), proposalId: proposal.id,
  });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /refusing to relay it twice/);
  assert.equal(sent.length, 1, 'the second transaction never reached the node');
  assert.ok(existsSync(submissionsPath));

  // And now the plan endpoint refuses too: the proposal is final.
  const plan = await call(port, 'POST', '/api/tx/plan', { proposalId: proposal.id });
  assert.equal(plan.status, 409);
});

// ---------------------------------------------------------------- receipt

test('receipt reports the chain verbatim, and only a receipt makes it final', async (t) => {
  const { port, submissionsPath } = await setup(t, {
    server: {
      readReceipt: async () => ({
        jsonrpc: '2.0', id: 1,
        error: { code: 29, message: 'Transaction hash not found' },
      }),
    },
  });
  const first = await call(port, 'POST', '/api/broadcast', { transaction: browserSign() });
  assert.equal(first.status, 200, first.text);

  // Pending: the node's "not found" is reported as-is, not dressed as final.
  const pending = await call(port, 'GET', `/api/tx/receipt?hash=${TX_HASH}`);
  assert.equal(pending.status, 200);
  assert.equal(pending.json.final, false);
  assert.equal(pending.json.receipt, null);
  assert.equal(pending.json.error.code, 29);
  assert.equal(pending.json.error.message, 'Transaction hash not found');
  let db = JSON.parse(readFileSync(submissionsPath, 'utf8'));
  assert.equal(db.submissions[0].status, 'BROADCAST', 'still not final');

  const bad = await call(port, 'GET', '/api/tx/receipt?hash=notahash');
  assert.equal(bad.status, 400);
});

test('a reverted receipt updates the submission with the chain reason', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-revert-'));
  const submissionsPath = join(dir, 'submissions.json');
  const sent = [];
  const server = createConsoleServer({
    statePath: makeState(dir),
    storePath: join(dir, 'proposals.json'),
    readMandate: async () => policy(),
    readOwnerKey: async () => OWNER_PUB,
    dryRunEstimate: async () => ESTIMATE,
    sendTransaction: async (body) => {
      sent.push(body);
      return { jsonrpc: '2.0', id: 1, result: { transaction_hash: TX_HASH } };
    },
    readReceipt: async () => ({
      jsonrpc: '2.0', id: 1,
      result: {
        execution_status: 'REVERTED',
        finality_status: 'ACCEPTED_ON_L2',
        revert_reason: 'Error in the called contract (0x2502): entrypoint not found',
      },
    }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const first = await call(port, 'POST', '/api/broadcast', { transaction: browserSign() });
  assert.equal(first.status, 200, first.text);
  let db = JSON.parse(readFileSync(submissionsPath, 'utf8'));
  assert.equal(db.submissions[0].status, 'BROADCAST', 'finality is not ours to declare');

  const receipt = await call(port, 'GET', `/api/tx/receipt?hash=${TX_HASH}`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.json.final, true);
  assert.equal(receipt.json.receipt.execution_status, 'REVERTED');

  // The FINAL status and the chain's own reason, written from the receipt.
  db = JSON.parse(readFileSync(submissionsPath, 'utf8'));
  assert.equal(db.submissions[0].status, 'REVERTED');
  assert.match(db.submissions[0].revert_reason, /entrypoint not found/);
});

// ---------------------------------------------------------------- anchor relay

const NOW = 1_800_000_000_000;

function evidenceFor(agentId, seq) {
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
    witness: WITNESS_PUB,
  }, WITNESS_PRIV);
}

async function anchorSetup(t, { records = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tx-anchor-'));
  const statePath = makeState(dir);
  const identity = signIdentity({
    owner: OWNER_PUB, purpose: 'test agent', nonce: '0x1', createdAt: NOW - 1000,
  }, OWNER_PRIV);
  const identityPath = join(dir, 'identity.json');
  const evidencePath = join(dir, 'evidence.json');
  const ladderPath = join(dir, 'ladder.json');
  writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  const store = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  for (let seq = 1; seq <= records; seq += 1) store.append(evidenceFor(identity.agentId, seq));

  // What the chain "says" - mutable, so a test can let an anchor land mid-test
  // instead of spinning up a second, different agent.
  const chain = {
    anchor: {
      available: false, registry: REGISTRY, anchorer: GATE, error: 'injected: no chain',
    },
  };
  const sent = [];
  const server = createConsoleServer({
    statePath,
    storePath: join(dir, 'proposals.json'),
    identityPath,
    evidencePath,
    ladderPath,
    readMandate: async () => policy(),
    readOwnerKey: async () => OWNER_PUB,
    readAnchor: async () => chain.anchor,
    dryRunEstimate: async () => ESTIMATE,
    sendTransaction: async (body) => {
      sent.push(body);
      return { jsonrpc: '2.0', id: 1, result: { transaction_hash: TX_HASH } };
    },
    readReceipt: async () => ({
      jsonrpc: '2.0', id: 1,
      result: { execution_status: 'SUCCEEDED', finality_status: 'ACCEPTED_ON_L2' },
    }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port, dir, statePath, sent, identity, chain };
}

test('anchor plan prices the fingerprint the signed records produce', async (t) => {
  const { port, identity } = await anchorSetup(t);
  const plan = await call(port, 'POST', '/api/anchor/plan');
  assert.equal(plan.status, 200, plan.text);
  assert.equal(plan.json.kind, 'anchor');
  assert.equal(BigInt(plan.json.agentId), BigInt(identity.agentId));
  assert.equal(plan.json.count, 3);
  assert.match(plan.json.root, /^0x[0-9a-f]+$/);
  assert.equal(plan.json.calls.length, 1);
  assert.equal(plan.json.calls[0].to, REGISTRY);
  assert.equal(plan.json.calls[0].entrypoint, 'anchor');
  assert.deepEqual(plan.json.calls[0].calldata,
    [identity.agentId, plan.json.root, '3']);
  assert.equal(plan.json.sender, GATE);
  assert.equal(plan.json.nonce, ESTIMATE.nonce);
});

test('anchor plan refuses when the chain already holds this exact fingerprint', async (t) => {
  const { port, chain } = await anchorSetup(t);
  const plan = await call(port, 'POST', '/api/anchor/plan');
  assert.equal(plan.status, 200, plan.text);

  // The anchor "lands": the chain now holds exactly this fingerprint.
  chain.anchor = {
    available: true, registry: REGISTRY, anchorer: GATE,
    root: plan.json.root, count: plan.json.count, error: null,
  };
  const again = await call(port, 'POST', '/api/anchor/plan');
  assert.equal(again.status, 409);
  assert.match(again.json.error, /already on chain/);
  assert.match(again.json.error, /nothing new to anchor/);
});

test('anchor record needs a SUCCEEDED receipt AND the chain holding the fingerprint', async (t) => {
  const { port, statePath, sent, identity, chain } = await anchorSetup(t);
  const plan = await call(port, 'POST', '/api/anchor/plan');
  assert.equal(plan.status, 200, plan.text);

  // The browser signs the anchor plan and the relay carries it.
  const body = browserSign({
    calls: plan.json.calls, nonce: plan.json.nonce,
    resourceBounds: plan.json.resourceBounds, sender: plan.json.sender,
    chainId: plan.json.chainIdFelt,
  });
  const broadcast = await call(port, 'POST', '/api/broadcast', { transaction: body });
  assert.equal(broadcast.status, 200, broadcast.text);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], body);

  // The chain is readable and holds something - just not what will be claimed.
  chain.anchor = {
    available: true, registry: REGISTRY, anchorer: GATE,
    root: '0x0', count: 0, error: null,
  };
  // A claim the chain does NOT hold is refused, even with a SUCCEEDED receipt.
  const lying = await call(port, 'POST', '/api/anchor/record', {
    tx_hash: TX_HASH, agentId: identity.agentId, root: '0xdead', count: 99,
  });
  assert.equal(lying.status, 409);
  assert.match(lying.json.error, /refusing to record a fingerprint the chain does not have/);
  let state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.layer_d.anchors.length, 0);
});

test('the honest anchor record is written once, and only once', async (t) => {
  // Here the injected chain read-back holds exactly what was anchored.
  const dir = mkdtempSync(join(tmpdir(), 'tx-anchor-ok-'));
  const statePath = makeState(dir);
  const identity = signIdentity({
    owner: OWNER_PUB, purpose: 'test agent', nonce: '0x1', createdAt: NOW - 1000,
  }, OWNER_PRIV);
  const identityPath = join(dir, 'identity.json');
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  const store = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  for (let seq = 1; seq <= 2; seq += 1) store.append(evidenceFor(identity.agentId, seq));

  let heldRoot = null; // what the chain "holds" after the anchor lands
  const server = createConsoleServer({
    statePath,
    storePath: join(dir, 'proposals.json'),
    identityPath,
    evidencePath,
    ladderPath: join(dir, 'ladder.json'),
    readMandate: async () => policy(),
    readOwnerKey: async () => OWNER_PUB,
    readAnchor: async () => (heldRoot === null
      ? { available: true, registry: REGISTRY, anchorer: GATE, root: '0x0', count: 0, error: null }
      : { available: true, registry: REGISTRY, anchorer: GATE, root: heldRoot, count: 2, error: null }),
    dryRunEstimate: async () => ESTIMATE,
    sendTransaction: async () => ({ jsonrpc: '2.0', id: 1, result: { transaction_hash: TX_HASH } }),
    readReceipt: async () => ({
      jsonrpc: '2.0', id: 1,
      result: { execution_status: 'SUCCEEDED', finality_status: 'ACCEPTED_ON_L2' },
    }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const plan = await call(port, 'POST', '/api/anchor/plan');
  assert.equal(plan.status, 200, plan.text);
  heldRoot = plan.json.root; // the anchor transaction "lands" on the chain

  const recorded = await call(port, 'POST', '/api/anchor/record', {
    tx_hash: TX_HASH, agentId: identity.agentId, root: plan.json.root, count: plan.json.count,
  });
  assert.equal(recorded.status, 200, recorded.text);
  assert.equal(recorded.json.recorded, true);

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.layer_d.anchors.length, 1);
  const entry = state.layer_d.anchors[0];
  assert.equal(entry.tx_hash, TX_HASH);
  assert.equal(entry.source, 'console-relay');
  assert.equal(BigInt(entry.root), BigInt(plan.json.root));
  assert.equal(entry.count, 2);

  const again = await call(port, 'POST', '/api/anchor/record', {
    tx_hash: TX_HASH, agentId: identity.agentId, root: plan.json.root, count: plan.json.count,
  });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /refusing to record the same anchor twice/);
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(after.layer_d.anchors.length, 1, 'the file must not grow twice');
});

test('anchor record refuses a transaction the chain has not confirmed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-anchor-pending-'));
  const statePath = makeState(dir);
  const identity = signIdentity({
    owner: OWNER_PUB, purpose: 'test agent', nonce: '0x1', createdAt: NOW - 1000,
  }, OWNER_PRIV);
  const identityPath = join(dir, 'identity.json');
  const evidencePath = join(dir, 'evidence.json');
  writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  const store = createEvidenceStore({ filePath: evidencePath, now: () => NOW });
  store.append(evidenceFor(identity.agentId, 1));

  const server = createConsoleServer({
    statePath,
    storePath: join(dir, 'proposals.json'),
    identityPath,
    evidencePath,
    ladderPath: join(dir, 'ladder.json'),
    readMandate: async () => policy(),
    readOwnerKey: async () => OWNER_PUB,
    readAnchor: async () => ({
      available: true, registry: REGISTRY, anchorer: GATE, root: '0x0', count: 0, error: null,
    }),
    dryRunEstimate: async () => ESTIMATE,
    sendTransaction: async () => ({ jsonrpc: '2.0', id: 1, result: { transaction_hash: TX_HASH } }),
    readReceipt: async () => ({
      jsonrpc: '2.0', id: 1,
      error: { code: 29, message: 'Transaction hash not found' },
    }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const out = await call(port, 'POST', '/api/anchor/record', {
    tx_hash: TX_HASH, agentId: identity.agentId, root: '0x1', count: 1,
  });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /no receipt for/);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.layer_d.anchors.length, 0, 'nothing recorded without a receipt');
});
