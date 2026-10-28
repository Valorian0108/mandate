// Phase 5: the outside-execution relay's controls, tested as the ONLY thing
// standing between a wallet-signed authorization and the chain (OBS-08). No
// network: the controller reads, the nonce read, the relayer and the receipt
// reader are all injected; the typed data is really built and really signed by
// web/typed-data.js - the same module the browser runs - so these tests
// exercise the exact bytes a tab would send.
//
// The checks that matter:
//   - the happy path packs the wire FLAT (OBS-16) and records BROADCAST only -
//     the FINAL status and the nonce-consumed flag come from a receipt, never
//     from the relay
//   - a wallet that is not the controller THE CHAIN NAMES is refused
//   - a signature that does not verify against the controller's chain-read key
//     is refused
//   - calls edited (or signed for a stale mandate) are refused: the server
//     re-derives them from the LIVE mandate and compares field by field
//   - an expired window, a consumed nonce, a cross-chain message and a
//     specific-caller message are each refused on their own
//   - the node's refusals come back VERBATIM, and nothing is recorded as sent
//   - a finalized proposal cannot be relayed twice

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStarkKey } from '@scure/starknet';
import { createConsoleServer, resolveControllerPublicKey } from '../web/server.mjs';
import { selectorFromName } from '../web/tx-signer.js';
import {
  outsideExecutionTypedData, signTypedData, shortStringEncode,
} from '../web/typed-data.js';
import { resolutionDigest, signResolution } from '../src/proposals.mjs';
import { createEvidenceStore, signEvidence, signIdentity } from '../src/evidence.mjs';

const OWNER_PRIV = '0x1';
const ATTACKER_PRIV = '0x2';
const WALLET_PRIV = '0x4'; // the key the CONTROLLER account holds
const WRONG_WALLET_PRIV = '0x5'; // a different wallet, honestly refused
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const ATTACKER_PUB = getStarkKey(ATTACKER_PRIV);
const WALLET_PUB = getStarkKey(WALLET_PRIV);

const GATE = '0x2502';
const TOKEN = '0x01f5';
const SESSION = '0x100d';
const MERCHANT = '0x079e';
const STRANGER = '0x16cb';
const REGISTRY = '0x3484';
const CONTROLLER = '0x5c7b'; // the wallet account the gate names on chain
const DEPLOYER = '0x2901'; // gas-only relayer key (never an authority)

// Computed, never typed from memory (tx-signer.test.mjs pins this function
// against starknet.js). selectorFromName returns a BigInt; the state file is
// JSON, so it is recorded as hex.
const TRANSFER_SELECTOR = '0x' + BigInt(selectorFromName('transfer')).toString(16);
const OUTSIDE_SELECTOR = '0x' + BigInt(selectorFromName('execute_from_outside_v2')).toString(16);
const ANY_CALLER_FELT = '0x' + BigInt(shortStringEncode('ANY_CALLER')).toString(16);

const OUTSIDE_TX = '0x0a751de';
const n = (v) => '0x' + BigInt(v).toString(16);

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
      transfer: TRANSFER_SELECTOR,
      execute_from_outside_v2: OUTSIDE_SELECTOR,
      anchor: '0x03cc2a1f',
      get_anchor: '0x019d579b',
      get_anchor_count: '0x0313111e',
    },
    keys: {
      owner: { address: GATE, public_key: OWNER_PUB },
      agent_session: { session_public_key: SESSION },
      merchant: { address: MERCHANT },
      stranger: { address: STRANGER },
      deployer: { address: DEPLOYER, private_key: '0xd' },
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
  const dir = mkdtempSync(join(tmpdir(), 'outside-relay-'));
  const statePath = makeState(dir, overrides.state);
  const storePath = join(dir, 'proposals.json');
  const submissionsPath = join(dir, 'submissions.json');
  const relayed = [];
  const consumed = new Set(); // nonces the injected 'chain' reports as burned
  const transactions = new Map(); // the injected 'chain's copy of sent txs
  let owner = OWNER_PUB;
  let controller = CONTROLLER;
  let controllerKey = WALLET_PUB;
  let mandate = policy();

  const server = createConsoleServer({
    statePath,
    storePath,
    readMandate: async () => mandate,
    readOwnerKey: async () => owner,
    readController: async () => [controller],
    readControllerPublicKey: async () => [controllerKey],
    readOutsideNonce: async (gate, nonce) => [consumed.has(BigInt(nonce)) ? '0x0' : '0x1'],
    relayOutside: async (args) => {
      relayed.push(args);
      consumed.add(BigInt(args.wireCalldata[1])); // the chain burns the nonce
      return { transaction_hash: OUTSIDE_TX, relayer: DEPLOYER };
    },
    readReceipt: async () => ({
      jsonrpc: '2.0', id: 1,
      result: { execution_status: 'SUCCEEDED', finality_status: 'ACCEPTED_ON_L2' },
    }),
    // The wallet-submitted path (OBS-31) reads the transaction back from the
    // 'chain': whatever the test put in `transactions`, verbatim.
    readTransaction: async (h) => (transactions.has(h)
      ? { jsonrpc: '2.0', id: 1, result: transactions.get(h) }
      : { jsonrpc: '2.0', id: 1, error: { code: 25, message: 'Transaction hash not found' } }),
    ...overrides.server,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    port, dir, submissionsPath, relayed, consumed, transactions,
    setOwner: (pub) => { owner = pub; },
    setController: (addr) => { controller = addr; },
    setControllerKey: (pub) => { controllerKey = pub; },
    setMandate: (m) => { mandate = m; },
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

// An over-cap ask resolved with a real owner signature - APPROVED_ONCE, the
// exact state the console is in when the owner presses "authorize in wallet".
async function approvedOnce(port, amount = '25') {
  const askOut = await call(port, 'POST', '/api/requests', { recipient: MERCHANT, amount });
  assert.equal(askOut.status, 200, askOut.text);
  const proposal = askOut.json.proposal;
  assert.ok(proposal, 'the over-cap ask must create a proposal');
  const resolution = { type: 'execute-once' };
  const digest = resolutionDigest(proposal, resolution);
  const resolved = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: signResolution(digest, OWNER_PRIV),
  });
  assert.equal(resolved.status, 200, resolved.text);
  return { proposal: resolved.json.proposal, resolution, digest };
}

// Same, but AMENDED (a cap raise) - used for the stale-mandate control, whose
// recomputed calldata embeds live policy fields.
async function approvedAmended(port, cap = 30) {
  const askOut = await call(port, 'POST', '/api/requests', { recipient: MERCHANT, amount: '25' });
  const proposal = askOut.json.proposal;
  const resolution = {
    type: 'amend',
    amendment: { kind: 'raise-per-call-cap', token: TOKEN, maxPerCall: String(cap) },
  };
  const digest = resolutionDigest(proposal, resolution);
  const resolved = await call(port, 'POST', '/api/resolve', {
    proposalId: proposal.id, resolution, signature: signResolution(digest, OWNER_PRIV),
  });
  assert.equal(resolved.status, 200, resolved.text);
  return { proposal: resolved.json.proposal, resolution, digest };
}

async function plan(port, proposalId) {
  const out = await call(port, 'POST', '/api/outside/plan', { proposalId });
  assert.equal(out.status, 200, out.text);
  return out.json;
}

// What the browser does: build the SNIP-9 typed data from the plan's fields,
// sign it as the wallet, and hand the server the envelope.
function walletAuth(thePlan, opts = {}) {
  const typedData = outsideExecutionTypedData({
    chainId: opts.chainId ?? thePlan.chainId,
    caller: opts.caller ?? thePlan.caller,
    nonce: opts.nonce ?? thePlan.nonce,
    executeAfter: opts.executeAfter ?? thePlan.executeAfter,
    executeBefore: opts.executeBefore ?? thePlan.executeBefore,
    calls: opts.calls ?? thePlan.calls,
  });
  const { r, s } = signTypedData(
    typedData, opts.signer ?? CONTROLLER, opts.priv ?? WALLET_PRIV);
  const auth = { scheme: opts.scheme ?? 'wallet-snip12-src9', r, s, typedData };
  if (opts.signature) auth.signature = opts.signature;
  if (opts.signerAddress !== null) {
    auth.signerAddress = opts.signerAddress ?? CONTROLLER;
  }
  return auth;
}

async function submit(port, proposalId, authorization) {
  return call(port, 'POST', '/api/outside/submit', { proposalId, authorization });
}

// ------------------------------------------- the wallet-submitted path (OBS-31)
// Ready X's simulation replays the authorized calls FROM THE WALLET, so a
// controller-bound self-call can never pass a third-party relay in its popup
// ('Account: unauthorized'). The wallet therefore carries
// execute_from_outside_v2 as its OWN transaction: /api/outside/wire re-runs the
// relay's exact controls and hands the wire back unrelayed; the chain's copy
// of the wallet's transaction is one account-invoke call carrying that wire;
// /api/outside/record parses it back and writes only chain facts.
const WALLET_SUBMITTED_TX = '0x0a11ce7';
function walletTx(wireCalldata, sender = CONTROLLER) {
  return {
    type: 'INVOKE',
    sender_address: sender,
    calldata: [
      '0x1', GATE, OUTSIDE_SELECTOR, '0x' + wireCalldata.length.toString(16),
      ...wireCalldata,
    ],
  };
}
async function wire(port, proposalId, authorization) {
  return call(port, 'POST', '/api/outside/wire', { proposalId, authorization });
}
async function record(port, proposalId, txHash) {
  return call(port, 'POST', '/api/outside/record', { proposalId, txHash });
}

test('wallet-submitted: wire hands the call back unrelayed, record writes chain facts only', async (t) => {
  const { port, relayed, consumed, transactions, submissionsPath } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);

  const w = await wire(port, proposal.id, walletAuth(thePlan));
  assert.equal(w.status, 200, w.text);
  assert.equal(w.json.to, GATE);
  assert.equal(w.json.entrypoint, 'execute_from_outside_v2');
  assert.equal(w.json.controller, CONTROLLER);
  assert.deepEqual(relayed, []); // the server carried NOTHING

  // The wire bytes are the relay's exact layout (pinned above): caller, nonce,
  // after, before, calls_len, (to, selector, cd_len, cd...), sig_len, r, s.
  assert.equal(n(w.json.calldata[0]), ANY_CALLER_FELT);
  assert.equal(n(w.json.calldata[1]), n(thePlan.nonce));
  assert.equal(n(w.json.calldata[6]), n(TRANSFER_SELECTOR));

  // The chain executes the wallet's transaction: the nonce burns. Only THEN
  // may the console record - and it records what the chain says.
  consumed.add(BigInt(w.json.nonce));
  transactions.set(WALLET_SUBMITTED_TX, walletTx(w.json.calldata));
  const r = await record(port, proposal.id, WALLET_SUBMITTED_TX);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.recorded, true);
  assert.equal(r.json.final, true);
  assert.equal(r.json.submission.status, 'SUCCEEDED');
  assert.equal(r.json.submission.via, 'wallet-submitted');
  assert.equal(r.json.submission.nonce_consumed, true);
  assert.equal(r.json.submission.relayer, null); // nobody carried it for the owner
  assert.equal(n(r.json.submission.sender), n(CONTROLLER));
  assert.equal(n(r.json.submission.nonce), n(thePlan.nonce));
  assert.deepEqual(relayed, []); // still nothing relayed

  const db = JSON.parse(readFileSync(submissionsPath, 'utf8'));
  assert.equal(db.submissions.length, 1);
});

test('wallet-submitted: record refuses a tx that is not an outside execution on this gate', async (t) => {
  const { port, transactions } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const w = await wire(port, proposal.id, walletAuth(thePlan));
  assert.equal(w.status, 200, w.text);

  const wrongTarget = walletTx(w.json.calldata);
  wrongTarget.calldata[1] = MERCHANT; // some other contract entirely
  transactions.set('0x0bad1', wrongTarget);
  const out = await record(port, proposal.id, '0x0bad1');
  assert.equal(out.status, 409);
  assert.match(out.json.error, /does not call execute_from_outside_v2 on this gate/);

  const twoCalls = walletTx(w.json.calldata);
  twoCalls.calldata[0] = '0x2'; // not a single outside execution
  transactions.set('0x0bad2', twoCalls);
  const out2 = await record(port, proposal.id, '0x0bad2');
  assert.equal(out2.status, 409);
  assert.match(out2.json.error, /not exactly one/);

  const unknown = await record(port, proposal.id, '0x0dead');
  assert.equal(unknown.status, 409);
  assert.match(unknown.json.error, /the chain has no transaction/);
});

test('wallet-submitted: record refuses inner calls that are not the live mandate\'s', async (t) => {
  const { port, transactions } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const w = await wire(port, proposal.id, walletAuth(thePlan));
  const cd = [...w.json.calldata];
  cd[9] = '0x9999'; // the transferred amount (low felt) inside the flat wire
  transactions.set('0x0bad3', walletTx(cd));
  const out = await record(port, proposal.id, '0x0bad3');
  assert.equal(out.status, 409);
  assert.match(out.json.error, /inner call #1 is not the call the live mandate/);
});

test('wallet-submitted: a reverted transaction is recorded reverted, with the reason', async (t) => {
  const { port, transactions } = await setup(t, {
    server: {
      readReceipt: async () => ({
        jsonrpc: '2.0', id: 1,
        result: { execution_status: 'REVERTED', revert_reason: 'GateAccount: too early' },
      }),
    },
  });
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const w = await wire(port, proposal.id, walletAuth(thePlan));
  // A revert burns nothing: the nonce stays unused, and the record must NOT
  // claim consumption.
  transactions.set(WALLET_SUBMITTED_TX, walletTx(w.json.calldata));
  const r = await record(port, proposal.id, WALLET_SUBMITTED_TX);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.submission.status, 'REVERTED');
  assert.equal(r.json.submission.revert_reason, 'GateAccount: too early');
  assert.equal(r.json.submission.nonce_consumed, undefined);
});

test('wallet-submitted: recording the same transaction twice completes one record', async (t) => {
  const { port, consumed, transactions, submissionsPath } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const w = await wire(port, proposal.id, walletAuth(thePlan));
  consumed.add(BigInt(w.json.nonce));
  transactions.set(WALLET_SUBMITTED_TX, walletTx(w.json.calldata));
  const first = await record(port, proposal.id, WALLET_SUBMITTED_TX);
  const second = await record(port, proposal.id, WALLET_SUBMITTED_TX);
  assert.equal(first.status, 200, first.text);
  assert.equal(second.status, 200, second.text);
  const db = JSON.parse(readFileSync(submissionsPath, 'utf8'));
  const mine = db.submissions.filter((s) => n(s.tx_hash) === n(WALLET_SUBMITTED_TX));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'SUCCEEDED');
});

// The OBS-36 adoption path: the wallet carried a cap amendment, the chain
// applied it - and the console's in-flight record write died with a server
// restart. Recording afterwards re-derives against a LIVE policy that already
// equals the target, which the signing-mode guard refuses as pointless. The
// record path must still adopt the applied amendment from the chain's copy of
// the tx, while plan/wire/submit keep refusing to SIGN it again.

test('wallet-submitted: record adopts an already-applied cap raise from the chain', async (t) => {
  const { port, consumed, transactions, setMandate, submissionsPath } = await setup(t);
  const { proposal } = await approvedAmended(port, 30); // per-call cap 20 -> 30
  const thePlan = await plan(port, proposal.id);
  const w = await wire(port, proposal.id, walletAuth(thePlan));
  assert.equal(w.status, 200, w.text);

  // The wallet sent it and the chain applied it: the nonce burned and the
  // live policy now reads the target (window reset, as the contract warns).
  consumed.add(BigInt(w.json.nonce));
  setMandate(policy({ maxPerCall: 30n, spentInWindow: 0n }));
  transactions.set(WALLET_SUBMITTED_TX, walletTx(w.json.calldata));

  // A tx carrying anything but the applied change is still refused: the
  // record-mode expectation is exact, not forgiving.
  const tampered = [...w.json.calldata];
  tampered[14] = '0x278d01'; // window seconds off by one inside the inner call
  transactions.set('0x0bad4', walletTx(tampered));
  const bad = await record(port, proposal.id, '0x0bad4');
  assert.equal(bad.status, 409);
  assert.match(bad.json.error, /inner call #1 is not the call the live mandate/);

  // The real transaction is adopted, from the chain's copy only.
  const r = await record(port, proposal.id, WALLET_SUBMITTED_TX);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.recorded, true);
  assert.equal(r.json.submission.status, 'SUCCEEDED');
  assert.equal(r.json.submission.via, 'wallet-submitted');
  assert.equal(r.json.submission.nonce_consumed, true);
  const db = JSON.parse(readFileSync(submissionsPath, 'utf8'));
  assert.equal(db.submissions.length, 1);
});

test('wallet-submitted: plan still refuses to SIGN an already-applied amendment', async (t) => {
  const { port, setMandate } = await setup(t);
  const { proposal } = await approvedAmended(port, 30);
  setMandate(policy({ maxPerCall: 30n })); // the amendment already landed on chain
  const p = await call(port, 'POST', '/api/outside/plan', { proposalId: proposal.id });
  assert.equal(p.status, 409);
  assert.match(p.json.error, /not above the current cap/);
});

// ---------------------------------------------------------------- happy path

test('the wallet path relays an approved proposal end to end', async (t) => {
  const { port, relayed, submissionsPath } = await setup(t);
  const { proposal } = await approvedOnce(port);

  const thePlan = await plan(port, proposal.id);
  assert.equal(thePlan.kind, 'outside');
  assert.equal(thePlan.proposalId, proposal.id);
  assert.equal(thePlan.chainId, 'SN_SEPOLIA');
  assert.equal(thePlan.caller, 'ANY_CALLER');
  assert.equal(thePlan.controller, CONTROLLER);
  assert.equal(thePlan.controllerPublicKey, WALLET_PUB);
  assert.equal(thePlan.relayer, DEPLOYER);
  assert.equal(thePlan.calls.length, 1);
  assert.equal(thePlan.calls[0].selector, 'transfer');

  const auth = walletAuth(thePlan);
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.relayed, true);
  assert.equal(out.json.txHash, OUTSIDE_TX);

  // The wire is packed FLAT (OBS-16) - exactly the outside-execution layout:
  // caller, nonce, after, before, calls_len, (to, selector, cd_len, cd...),
  // sig_len, r, s. 25 = 0x19 (the approved amount, once).
  assert.deepEqual(relayed[0].wireCalldata.map(n), [
    ANY_CALLER_FELT, n(thePlan.nonce),
    n(thePlan.executeAfter), n(thePlan.executeBefore),
    '0x1', n(TOKEN), n(TRANSFER_SELECTOR), '0x3', n(MERCHANT), '0x19', '0x0',
    '0x2', n(auth.r), n(auth.s),
  ]);

  // Nothing FINAL is recorded by the relay itself: BROADCAST only.
  const db = JSON.parse(readFileSync(submissionsPath, 'utf8'));
  assert.equal(db.submissions.length, 1);
  assert.equal(db.submissions[0].status, 'BROADCAST');
  assert.equal(db.submissions[0].kind, 'outside');
  assert.equal(db.submissions[0].via, 'outside-relay');
  assert.equal(db.submissions[0].scheme, 'wallet-snip12-src9');
  assert.equal(n(db.submissions[0].controller), n(CONTROLLER));

  // The receipt finalizes - and the nonce burn is READ BACK, never assumed.
  const rec = await call(port, 'GET', `/api/tx/receipt?hash=${OUTSIDE_TX}`);
  assert.equal(rec.status, 200, rec.text);
  assert.equal(rec.json.final, true);
  assert.equal(rec.json.submission.status, 'SUCCEEDED');
  assert.equal(rec.json.submission.nonce_consumed, true);
});

test('the pasted-key carrier passes the exact same controls', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);

  // snip12-src9: no signerAddress in the envelope, but the digest is still
  // bound to the controller and still verified against its chain-read key.
  const auth = walletAuth(thePlan, { scheme: 'snip12-src9', signerAddress: null });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.relayed, true);
  assert.equal(relayed.length, 1);
});

// ---------------------------------------------------------------- signer identity

test('a wallet that is not the chain-named controller is refused', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);

  // A perfectly valid signature that merely CLAIMS a different address.
  const auth = walletAuth(thePlan, { signerAddress: STRANGER });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /controller on chain is/i);
  assert.equal(relayed.length, 0);
});

test('a signature from a wallet key the controller does not hold is refused', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);

  // Right address claimed, wrong key: the digest recomputed against the
  // CHAIN-READ controller does not verify against the controller's chain key.
  const auth = walletAuth(thePlan, { priv: WRONG_WALLET_PRIV });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /does not verify/i);
  assert.equal(relayed.length, 0);
});

// ------------------------------------------------------- controller key resolution

// The wire shape of a felt (what the real chainCall now guarantees): hex
// string. selectorFromName returns a BigInt, and JSON.stringify THROWS on
// BigInt - that seam silently killed this exact fallback on the live Ready X
// controller (2026-10-26), so the fakes below are JSON-STRICT: they fail
// loudly on anything the real wire could not carry.
const HEX = (name) => '0x' + selectorFromName(name).toString(16);

test('resolveControllerPublicKey falls back from get_public_key to get_owner (Ready X)', async () => {
  const calls = [];
  const fakeCall = async (addr, selector, calldata) => {
    JSON.stringify({ addr, selector, calldata });
    calls.push(selector);
    if (selector === HEX('get_public_key')) throw new Error('no such entrypoint');
    if (selector === HEX('get_owner_type')) return ['0x0'];
    if (selector === HEX('get_owner')) return [WALLET_PUB];
    throw new Error(`unexpected selector ${selector}`);
  };
  const [pub] = await resolveControllerPublicKey(
    fakeCall, CONTROLLER, HEX('get_public_key'), selectorFromName);
  assert.equal(pub, WALLET_PUB);
  assert.deepEqual(calls, [
    HEX('get_public_key'),
    HEX('get_owner_type'),
    HEX('get_owner'),
  ]);
});

test('resolveControllerPublicKey refuses a non-Starknet owner type loudly', async () => {
  const fakeCall = async (addr, selector, calldata) => {
    JSON.stringify({ addr, selector, calldata });
    if (selector === HEX('get_public_key')) throw new Error('nope');
    if (selector === HEX('get_owner_type')) return ['0x1'];
    throw new Error('should not reach get_owner');
  };
  await assert.rejects(
    resolveControllerPublicKey(fakeCall, CONTROLLER, HEX('get_public_key'), selectorFromName),
    /not Starknet \(0\)/,
  );
});

// ------------------------------------------------------- signature array on the wire

test('the wire carries the FULL concise owner+guardian signature array (4 felts)', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const { r, s } = signTypedData(
    outsideExecutionTypedData({
      chainId: thePlan.chainId, caller: thePlan.caller, nonce: thePlan.nonce,
      executeAfter: thePlan.executeAfter, executeBefore: thePlan.executeBefore,
      calls: thePlan.calls,
    }), CONTROLLER, WALLET_PRIV);
  const auth = walletAuth(thePlan, { signature: [r, s, '0x111', '0x222'] });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 200, out.text);
  assert.equal(relayed.length, 1);
  const wire = relayed[0].wireCalldata;
  // last segment: sig_len, then the 4 felts verbatim
  const sigLen = Number(BigInt(wire[wire.length - 5]));
  assert.equal(sigLen, 4);
  assert.deepEqual(wire.slice(-4), [r, s, '0x111', '0x222'].map((v) => '0x' + BigInt(v).toString(16)));
});

test('the wire carries the FULL standard signature array (count=1, 5 felts)', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const { r, s } = signTypedData(
    outsideExecutionTypedData({
      chainId: thePlan.chainId, caller: thePlan.caller, nonce: thePlan.nonce,
      executeAfter: thePlan.executeAfter, executeBefore: thePlan.executeBefore,
      calls: thePlan.calls,
    }), CONTROLLER, WALLET_PRIV);
  const sigArray = ['0x1', '0x0', WALLET_PUB, r, s];
  const auth = walletAuth(thePlan, { signature: sigArray });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 200, out.text);
  const wire = relayed[0].wireCalldata;
  const sigLen = Number(BigInt(wire[wire.length - 6]));
  assert.equal(sigLen, 5);
  assert.deepEqual(wire.slice(-5), sigArray.map((v) => '0x' + BigInt(v).toString(16)));
});

test('an authorization whose r/s do not match its own signature array is refused', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan, { signature: ['0x999', '0x888', '0x777', '0x666'] });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /do not match the owner component/i);
  assert.equal(relayed.length, 0);
});

test('a wallet authorization with no signerAddress is refused', async (t) => {
  const { port } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan, { signerAddress: null });
  auth.scheme = 'wallet-snip12-src9';
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 400, out.text);
  assert.match(out.json.error, /signerAddress/);
});

test('a gate with no controller registered on chain refuses the whole path', async (t) => {
  const { port, setController } = await setup(t);
  const { proposal } = await approvedOnce(port);
  setController('0x0');
  const out = await call(port, 'POST', '/api/outside/plan', { proposalId: proposal.id });
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /no wallet controller/i);
});

// ---------------------------------------------------------------- message fields

test('an amendment signed against an old policy is refused when the policy moved', async (t) => {
  const { port, setMandate, relayed } = await setup(t);
  const { proposal } = await approvedAmended(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan); // signed set_spending_policy calldata

  // The live mandate changed (window cap raised): the recomputed calldata no
  // longer matches what the wallet signed.
  setMandate(policy({ maxPerWindow: 200n }));
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /live mandate/i);
  assert.equal(relayed.length, 0);
});

test('signed calls edited after signing are refused', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);

  // The attacker signs their OWN inflated amount (999) - a valid signature
  // over calls that are not the approved ones.
  const auth = walletAuth(thePlan, {
    calls: [{ to: TOKEN, selector: 'transfer', calldata: [MERCHANT, '0x3e7', '0x0'] }],
  });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /not the call this approval produces/i);
  assert.equal(relayed.length, 0);
});

test('a typed-data message mutated after signing is refused', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan);

  // Honest signature, dishonest envelope: edit the calldata in the JSON after
  // signing. The calls check catches it; even if it didn't, the recomputed
  // digest would.
  auth.typedData.message.Calls[0].Calldata[1] = '0x3e7';
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.equal(relayed.length, 0);
});

test('an authorization for another chain is refused', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan, { chainId: 'SN_MAIN' });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /cross-chain/i);
  assert.equal(relayed.length, 0);
});

test('an authorization naming a specific caller is refused', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan, { caller: STRANGER });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /ANY_CALLER/);
  assert.equal(relayed.length, 0);
});

test('an expired execution window is refused', async (t) => {
  const { port, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const now = Math.floor(Date.now() / 1000);
  const auth = walletAuth(thePlan, { executeAfter: now - 120, executeBefore: now - 10 });
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /window is not open/i);
  assert.equal(relayed.length, 0);
});

test('a consumed nonce is refused - the authorization was already used', async (t) => {
  const { port, consumed, relayed } = await setup(t);
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan);
  consumed.add(BigInt(thePlan.nonce)); // the chain says: this nonce is burned
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /already consumed/i);
  assert.equal(relayed.length, 0);
});

test('a recorded selector that disagrees with the computed one is refused', async (t) => {
  const { port, relayed } = await setup(t, {
    state: { selectors: { transfer: '0xbadf00d' } },
  });
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan);
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 409, out.text);
  assert.match(out.json.error, /disagrees with the computed one/i);
  assert.equal(relayed.length, 0);
});

// ---------------------------------------------------------------- proposal guards

test('plan refuses a pending proposal, a stranger, and a missing id', async (t) => {
  const { port } = await setup(t);
  const askOut = await call(port, 'POST', '/api/requests', { recipient: MERCHANT, amount: '25' });
  const pending = askOut.json.proposal;

  const notResolved = await call(port, 'POST', '/api/outside/plan', { proposalId: pending.id });
  assert.equal(notResolved.status, 409);
  assert.match(notResolved.json.error, /PENDING/);

  const unknown = await call(port, 'POST', '/api/outside/plan', { proposalId: 'nope' });
  assert.equal(unknown.status, 404);

  const missing = await call(port, 'POST', '/api/outside/plan', {});
  assert.equal(missing.status, 400);
});

test('plan refuses an approval the rotated owner key no longer covers', async (t) => {
  const { port, setOwner } = await setup(t);
  const { proposal } = await approvedOnce(port);
  setOwner(ATTACKER_PUB); // the owner rotated their key after signing
  const out = await call(port, 'POST', '/api/outside/plan', { proposalId: proposal.id });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /owner key on chain has changed/i);
});

test('a proposal that already reached the chain cannot be relayed twice', async (t) => {
  const { port, submissionsPath } = await setup(t);
  const { proposal } = await approvedOnce(port);
  writeFileSync(submissionsPath, JSON.stringify({
    submissions: [{ proposalId: proposal.id, status: 'SUCCEEDED', tx_hash: '0xfeed' }],
  }, null, 2));
  assert.ok(existsSync(submissionsPath));

  const thePlan = await call(port, 'POST', '/api/outside/plan', { proposalId: proposal.id });
  assert.equal(thePlan.status, 409);
  assert.match(thePlan.json.error, /already went to the chain/);
});

// ---------------------------------------------------------------- node honesty

test('a node refusal comes back verbatim and records nothing', async (t) => {
  const { port, submissionsPath } = await setup(t, {
    server: {
      relayOutside: async () => {
        throw new Error('RPC error -32603: Invalid Message Signature');
      },
    },
  });
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan);

  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 502, out.text);
  assert.match(out.json.error, /RPC error -32603: Invalid Message Signature/);
  assert.ok(!existsSync(submissionsPath)
    || JSON.parse(readFileSync(submissionsPath, 'utf8')).submissions.length === 0,
    'nothing may be recorded as sent when the node refused');
});

test('a relayer answer with no transaction hash is reported verbatim', async (t) => {
  const { port, submissionsPath } = await setup(t, {
    server: { relayOutside: async () => ({}) },
  });
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan);

  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 502, out.text);
  assert.equal(out.json.relayed, false);
  assert.ok(!existsSync(submissionsPath)
    || JSON.parse(readFileSync(submissionsPath, 'utf8')).submissions.length === 0);
});

test('a REVERTED receipt is recorded as reverted, with the reason', async (t) => {
  const { port, submissionsPath } = await setup(t, {
    server: {
      readReceipt: async () => ({
        jsonrpc: '2.0', id: 1,
        result: {
          execution_status: 'REVERTED',
          finality_status: 'ACCEPTED_ON_L2',
          revert_reason: 'GateAccount: invalid signature',
        },
      }),
    },
  });
  const { proposal } = await approvedOnce(port);
  const thePlan = await plan(port, proposal.id);
  const auth = walletAuth(thePlan);
  const out = await submit(port, proposal.id, auth);
  assert.equal(out.status, 200, out.text);

  const rec = await call(port, 'GET', `/api/tx/receipt?hash=${OUTSIDE_TX}`);
  assert.equal(rec.status, 200, rec.text);
  assert.equal(rec.json.final, true);
  assert.equal(rec.json.submission.status, 'REVERTED');
  assert.equal(rec.json.submission.revert_reason, 'GateAccount: invalid signature');
  // The nonce-burn read-back only happens for SUCCEEDED - a revert burns nothing.
  assert.equal(rec.json.submission.nonce_consumed, undefined);
});

// ---------------------------------------------------------------- anchor purpose
// Phase 6: the résumé fingerprint rides the SAME outside relay (purpose:
// 'anchor'). The controls that matter here, each as the only thing standing
// between a wallet-signed anchor authorization and the chain:
//   - the happy path relays the flat wire, writes NO submission record (the
//     anchor's only record is /api/anchor/record, written from a receipt and a
//     registry read-back), and closes the loop through that record
//   - an already-anchored fingerprint and an empty record set refuse at PLAN
//   - a fingerprint that moved between signing and submitting refuses: the
//     calls are rebuilt from the LIVE trust state at submit time
//   - edited calls, a wrong signer, a consumed nonce and a bad signature refuse

const WITNESS_PRIV = '0x3';
const WITNESS_PUB = getStarkKey(WITNESS_PRIV);
// Computed, never typed from memory - the state file's recorded selector is
// cross-checked against this by control 2, so a fake here would be a fake test.
const ANCHOR_SELECTOR = '0x' + BigInt(selectorFromName('anchor')).toString(16);
const ANCHOR_NOW = 1_800_000_000_000;

function anchorEvidenceFor(agentId, seq) {
  return signEvidence({
    version: 1,
    agentId,
    seq,
    at: ANCHOR_NOW - 100 * seq,
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

// The outside-relay setup PLUS a verifiable trust state: a signed identity and
// a signed evidence file (the same shape the résumé screen reads), and a
// mutable chain-anchor so a test can let the fingerprint "land" mid-test.
async function setupAnchor(t, { records = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'outside-anchor-'));
  const statePath = makeState(dir, {
    selectors: {
      transfer: TRANSFER_SELECTOR,
      anchor: ANCHOR_SELECTOR,
      get_anchor: '0x019d579b',
      get_anchor_count: '0x0313111e',
    },
  });
  const identity = signIdentity({
    owner: OWNER_PUB, purpose: 'test agent', nonce: '0x1', createdAt: ANCHOR_NOW - 1000,
  }, OWNER_PRIV);
  const identityPath = join(dir, 'identity.json');
  const evidencePath = join(dir, 'evidence.json');
  const ladderPath = join(dir, 'ladder.json');
  writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  const evidence = createEvidenceStore({ filePath: evidencePath, now: () => ANCHOR_NOW });
  for (let seq = 1; seq <= records; seq += 1) {
    evidence.append(anchorEvidenceFor(identity.agentId, seq));
  }

  const chain = {
    anchor: {
      available: false, registry: REGISTRY, anchorer: GATE, error: 'injected: no chain',
    },
  };
  const relayed = [];
  const consumed = new Set();
  let controller = CONTROLLER;
  let controllerKey = WALLET_PUB;

  const server = createConsoleServer({
    statePath,
    storePath: join(dir, 'proposals.json'),
    identityPath,
    evidencePath,
    ladderPath,
    readMandate: async () => policy(),
    readOwnerKey: async () => OWNER_PUB,
    readAnchor: async () => chain.anchor,
    dryRunEstimate: async () => ({
      nonce: '0x2',
      resourceBounds: {
        l1_gas: { max_amount: '0x186a0', max_price_per_unit: '0x5f5e100' },
        l2_gas: { max_amount: '0x2dc6c0', max_price_per_unit: '0x1' },
        l1_data_gas: { max_amount: '0x186a0', max_price_per_unit: '0x2' },
      },
    }),
    readController: async () => [controller],
    readControllerPublicKey: async () => [controllerKey],
    readOutsideNonce: async (gate, nonce) => [consumed.has(BigInt(nonce)) ? '0x0' : '0x1'],
    relayOutside: async (args) => {
      relayed.push(args);
      consumed.add(BigInt(args.wireCalldata[1])); // the chain burns the nonce
      return { transaction_hash: OUTSIDE_TX, relayer: DEPLOYER };
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
  return {
    port, dir, identity, evidence, chain, relayed, consumed,
    submissionsPath: join(dir, 'submissions.json'),
    setController: (addr) => { controller = addr; },
    setControllerKey: (pub) => { controllerKey = pub; },
  };
}

async function anchorPlan(port) {
  const out = await call(port, 'POST', '/api/outside/plan', { purpose: 'anchor' });
  return out;
}

async function anchorSubmit(port, authorization) {
  return call(port, 'POST', '/api/outside/submit', { purpose: 'anchor', authorization });
}

test('the anchor purpose relays a wallet-signed fingerprint and records nothing until the receipt', async (t) => {
  const ctx = await setupAnchor(t);
  const planned = await anchorPlan(ctx.port);
  assert.equal(planned.status, 200, planned.text);
  const thePlan = planned.json;
  assert.equal(thePlan.kind, 'outside');
  assert.equal(thePlan.purpose, 'anchor');
  assert.equal(BigInt(thePlan.agentId), BigInt(ctx.identity.agentId));
  assert.equal(thePlan.count, 3);
  assert.match(thePlan.root, /^0x[0-9a-f]+$/);
  assert.equal(thePlan.controller, CONTROLLER);
  assert.equal(thePlan.relayer, DEPLOYER);
  assert.equal(thePlan.calls.length, 1);
  assert.equal(thePlan.calls[0].to, REGISTRY);
  assert.equal(thePlan.calls[0].selector, 'anchor');
  assert.deepEqual(thePlan.calls[0].calldata,
    [ctx.identity.agentId, thePlan.root, '3']);

  const auth = walletAuth(thePlan);
  const out = await anchorSubmit(ctx.port, auth);
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.relayed, true);
  assert.equal(out.json.txHash, OUTSIDE_TX);
  assert.equal(out.json.purpose, 'anchor');
  assert.equal(n(out.json.anchor.root), n(thePlan.root));

  // The wire is packed FLAT (OBS-16): caller, nonce, after, before, calls_len,
  // (to, selector, cd_len, agentId, root, count), sig_len, r, s.
  assert.deepEqual(ctx.relayed[0].wireCalldata.map(n), [
    ANY_CALLER_FELT, n(thePlan.nonce),
    n(thePlan.executeAfter), n(thePlan.executeBefore),
    '0x1', n(REGISTRY), n(ANCHOR_SELECTOR), '0x3',
    n(ctx.identity.agentId), n(thePlan.root), '0x3',
    '0x2', n(auth.r), n(auth.s),
  ]);

  // NO submission record: the anchor's only record is written by
  // /api/anchor/record, from a receipt and a registry read-back.
  assert.ok(!existsSync(ctx.submissionsPath)
    || JSON.parse(readFileSync(ctx.submissionsPath, 'utf8')).submissions.length === 0,
    'the anchor purpose must not write a proposal submission record');

  // The loop closes through the SAME record endpoint the pasted-key path uses:
  // the chain now holds the fingerprint, and the receipt is SUCCEEDED.
  ctx.chain.anchor = {
    available: true, registry: REGISTRY, anchorer: GATE,
    root: thePlan.root, count: thePlan.count, error: null,
  };
  const recorded = await call(ctx.port, 'POST', '/api/anchor/record', {
    tx_hash: OUTSIDE_TX,
    agentId: thePlan.agentId,
    root: thePlan.root,
    count: thePlan.count,
  });
  assert.equal(recorded.status, 200, recorded.text);
  assert.equal(recorded.json.recorded, true);
  assert.equal(n(recorded.json.anchor.root), n(thePlan.root));
});

test('the anchor purpose refuses to plan a fingerprint the chain already holds', async (t) => {
  const ctx = await setupAnchor(t);
  const first = await anchorPlan(ctx.port);
  assert.equal(first.status, 200, first.text);
  ctx.chain.anchor = {
    available: true, registry: REGISTRY, anchorer: GATE,
    root: first.json.root, count: first.json.count, error: null,
  };
  const again = await anchorPlan(ctx.port);
  assert.equal(again.status, 409);
  assert.match(again.json.error, /already on chain/);
  assert.match(again.json.error, /nothing new to anchor/);
});

test('the anchor purpose refuses to plan when there are no records', async (t) => {
  const ctx = await setupAnchor(t, { records: 0 });
  const out = await anchorPlan(ctx.port);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /no evidence to anchor/);
});

test('a fingerprint that moved after signing is refused: the calls are rebuilt from the LIVE trust state', async (t) => {
  const ctx = await setupAnchor(t);
  const planned = await anchorPlan(ctx.port);
  assert.equal(planned.status, 200, planned.text);
  const auth = walletAuth(planned.json); // a perfectly valid signature over the OLD fingerprint

  // A fourth record lands: the live root and count are no longer what was signed.
  ctx.evidence.append(anchorEvidenceFor(ctx.identity.agentId, 4));

  const out = await anchorSubmit(ctx.port, auth);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /not the call this anchor produces/);
  assert.equal(ctx.relayed.length, 0, 'nothing may reach the relayer');
});

test('anchor calls edited after signing are refused', async (t) => {
  const ctx = await setupAnchor(t);
  const planned = await anchorPlan(ctx.port);
  assert.equal(planned.status, 200, planned.text);
  const thePlan = planned.json;
  const edited = [{
    ...thePlan.calls[0],
    calldata: [thePlan.calls[0].calldata[0], thePlan.root, '4'], // a different count
  }];
  const auth = walletAuth(thePlan, { calls: edited });
  const out = await anchorSubmit(ctx.port, auth);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /not the call this anchor produces/);
  assert.equal(ctx.relayed.length, 0);
});

test('an anchor authorization from a wallet that is not the chain-named controller is refused', async (t) => {
  const ctx = await setupAnchor(t);
  const planned = await anchorPlan(ctx.port);
  assert.equal(planned.status, 200, planned.text);
  const auth = walletAuth(planned.json, { signerAddress: '0x999' });
  const out = await anchorSubmit(ctx.port, auth);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /cannot authorize this gate/);
  assert.equal(ctx.relayed.length, 0);
});

test('an anchor authorization with an already-burned nonce is refused', async (t) => {
  const ctx = await setupAnchor(t);
  const planned = await anchorPlan(ctx.port);
  assert.equal(planned.status, 200, planned.text);
  const auth = walletAuth(planned.json);
  ctx.consumed.add(BigInt(planned.json.nonce)); // the chain burned it elsewhere
  const out = await anchorSubmit(ctx.port, auth);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /already consumed on chain/);
  assert.equal(ctx.relayed.length, 0);
});

test('an anchor signature that does not verify against the controller chain-read key is refused', async (t) => {
  const ctx = await setupAnchor(t);
  const planned = await anchorPlan(ctx.port);
  assert.equal(planned.status, 200, planned.text);
  const auth = walletAuth(planned.json, { priv: WRONG_WALLET_PRIV });
  const out = await anchorSubmit(ctx.port, auth);
  assert.equal(out.status, 409);
  assert.match(out.json.error, /does not verify against the public key/);
  assert.equal(ctx.relayed.length, 0);
});
