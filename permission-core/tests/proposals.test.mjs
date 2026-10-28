// Proposal-flow tests.
//
// The security claim under test: ONLY the owner key can move a proposal out of
// PENDING - not the company, not the agent, not a hand-edited database. Each test
// isolates one attack on that claim (OBS-08: the control must be the only thing
// standing between the attacker and an approval).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stark from '@scure/starknet';

import { createEngine } from '../src/engine.mjs';
import { spendingGate } from '../src/gates/spending.mjs';
import {
  createProposalStore, signResolution, verifyOwnerSignature, resolutionDigest,
  chainOwnerPublicKey,
} from '../src/proposals.mjs';
import { signMandateAction } from '../web/typed-data.js';

const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const STRANGER = '0x16cb41ec11efcc9129d858ae07449f4f1a31d7d292269a5e7c40cd4d33db371';
const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const SEL_TRANSFER = '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e';
const GATE_ADDRESS = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const CHAIN = 'SN_SEPOLIA';

// Test-only keypairs (NOT the live ones): an owner and an attacker/agent.
const OWNER_PRIV = '0x1'; // deterministic junk keys are fine for units
const ATTACKER_PRIV = '0x2';
const OWNER_PUB_X = stark.getStarkKey(OWNER_PRIV);
const ATTACKER_PUB_X = stark.getStarkKey(ATTACKER_PRIV);

const NOW = 1793000000;

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'opencode', 'proposals-test-'));
  return join(dir, 'proposals.json');
}

function policy() {
  return {
    sessionPublicKey: '0x100d', validUntil: 2000000000, maxCalls: 10, callsUsed: 1,
    allowedSelectors: [SEL_TRANSFER], token: TOKEN,
    maxPerCall: 10n, maxPerWindow: 100n, windowSeconds: 2592000,
    spentInWindow: 5n, windowStart: 1792864705, allowedRecipients: [MERCHANT],
  };
}

function blockedRequest(amount = 15, recipient = MERCHANT) {
  return {
    user: 'user:test', agent: 'agent:test',
    action: 'spend:transfer', resource: `token:${TOKEN}`,
    context: { recipient, amount, token: TOKEN, now: NOW },
  };
}

// Engine + store wired together, exactly as the product would.
function setup() {
  const engine = createEngine();
  engine.registerGate(spendingGate);
  const filePath = tempStore();
  const store = createProposalStore({
    filePath,
    getOwnerPublicKey: async () => OWNER_PUB_X,
    getSignatureContext: async () => ({
      kind: 'resolution',
      accountAddress: GATE_ADDRESS,
      chainId: CHAIN,
    }),
  });
  return { engine, store, filePath };
}

function decideAndPropose(engine, store, request) {
  const d = engine.decide(request, { spend: policy() });
  assert.equal(d.verdict, 'DENY', 'fixture must produce a blocked request');
  return { decision: d, proposal: store.create(request, d) };
}

// ---------------------------------------------------------------- happy paths

test('p1: a blocked action becomes a PENDING proposal in the engine own words', () => {
  const { engine, store } = setup();
  const { decision, proposal } = decideAndPropose(engine, store, blockedRequest(15));
  assert.equal(proposal.status, 'PENDING');
  assert.equal(proposal.blockedBecause.code, 'over-per-call-cap');
  assert.equal(proposal.blockedBecause.reason, 'GateAccount: amount over per-call cap');
  assert.equal(store.list('PENDING').length, 1);
  assert.ok(decision);
});

test('p2: owner signature resolves execute-once', async () => {
  const { engine, store } = setup();
  const { proposal } = decideAndPropose(engine, store, blockedRequest(15));
  const resolution = { type: 'execute-once' };
  const sig = signResolution(store.digestFor(proposal.id, resolution), OWNER_PRIV);
  const resolved = await store.resolve(proposal.id, resolution, sig);
  assert.equal(resolved.status, 'APPROVED_ONCE');
  assert.equal(resolved.ownerPublicKeyAtResolution, OWNER_PUB_X);
});

test('p3: decline resolves and the block stands (nothing granted)', async () => {
  const { engine, store } = setup();
  const { proposal } = decideAndPropose(engine, store, blockedRequest(15, STRANGER));
  const resolution = { type: 'decline' };
  const sig = signResolution(store.digestFor(proposal.id, resolution), OWNER_PRIV);
  const resolved = await store.resolve(proposal.id, resolution, sig);
  assert.equal(resolved.status, 'DECLINED');
  // The engine still denies the same request afterwards.
  assert.equal(engine.decide(blockedRequest(15, STRANGER), { spend: policy() }).verdict, 'DENY');
});

test('p4: amend requires stating exactly what changes', async () => {
  const { engine, store } = setup();
  const { proposal } = decideAndPropose(engine, store, blockedRequest(15));
  const vague = { type: 'amend' }; // no amendment field
  const sig = signResolution(resolutionDigest(proposal, vague), OWNER_PRIV);
  await assert.rejects(store.resolve(proposal.id, vague, sig), /must say exactly what changes/);
  const precise = { type: 'amend', amendment: { kind: 'raise-per-call-cap', token: TOKEN, maxPerCall: '20' } };
  const sig2 = signResolution(store.digestFor(proposal.id, precise), OWNER_PRIV);
  const resolved = await store.resolve(proposal.id, precise, sig2);
  assert.equal(resolved.status, 'AMENDED');
});

// ---------------------------------------------------------------- the attacks

test('p5: THE theater test - a non-owner signature cannot approve', async () => {
  // The company/agent holds ATTACKER_PRIV and knows the whole flow. The ONLY thing
  // stopping a self-approval is that verification runs against the owner key.
  const { engine, store } = setup();
  const { proposal } = decideAndPropose(engine, store, blockedRequest(15));
  const resolution = { type: 'execute-once' };
  const forged = signResolution(store.digestFor(proposal.id, resolution), ATTACKER_PRIV);
  await assert.rejects(store.resolve(proposal.id, resolution, forged), /OWNER key/);
  assert.equal(store.get(proposal.id).status, 'PENDING', 'a rejected signature must change nothing');
  // Sanity: the forgery is a real signature over the right digest, wrong key.
  assert.ok(verifyOwnerSignature(store.digestFor(proposal.id, resolution), forged, ATTACKER_PUB_X),
    'the attacker signature should verify against the ATTACKER key - proving the test ' +
    'fails on key mismatch, not on a malformed signature');
});

test('p6: no signature at all is not a resolution', async () => {
  const { engine, store } = setup();
  const { proposal } = decideAndPropose(engine, store, blockedRequest(15));
  await assert.rejects(store.resolve(proposal.id, { type: 'execute-once' }, null),
    /without an owner signature/);
});

test('p7: tampering with the stored proposal invalidates the signature', async () => {
  // Sign approval for 15, then hand-edit the database to 50 (a malicious or buggy
  // app). The digest covers the request, so the old signature no longer verifies.
  const { engine, store, filePath } = setup();
  const { proposal } = decideAndPropose(engine, store, blockedRequest(15));
  const resolution = { type: 'execute-once' };
  const sig = signResolution(store.digestFor(proposal.id, resolution), OWNER_PRIV);

  const { readFileSync, writeFileSync } = await import('node:fs');
  const db = JSON.parse(readFileSync(filePath, 'utf8'));
  db.proposals[0].request.context.amount = 50;
  writeFileSync(filePath, JSON.stringify(db));

  await assert.rejects(store.resolve(proposal.id, resolution, sig), /OWNER key/);
});

test('p8: a signature for one resolution cannot be replayed as another', async () => {
  const { engine, store } = setup();
  const { proposal } = decideAndPropose(engine, store, blockedRequest(15));
  // Owner signs a DECLINE...
  const decline = { type: 'decline' };
  const sig = signResolution(store.digestFor(proposal.id, decline), OWNER_PRIV);
  // ...attacker tries to use it as an execute-once approval.
  await assert.rejects(store.resolve(proposal.id, { type: 'execute-once' }, sig), /OWNER key/);
});

test('p9: resolutions are final - no double-resolve', async () => {
  const { engine, store } = setup();
  const { proposal } = decideAndPropose(engine, store, blockedRequest(15));
  const resolution = { type: 'decline' };
  const sig = signResolution(store.digestFor(proposal.id, resolution), OWNER_PRIV);
  await store.resolve(proposal.id, resolution, sig);
  await assert.rejects(store.resolve(proposal.id, resolution, sig), /already DECLINED/);
});

test('p10: allowed actions and unknown resolution types are refused at the door', () => {
  const { engine, store } = setup();
  const allowed = engine.decide(blockedRequest(5), { spend: policy() });
  assert.equal(allowed.verdict, 'ALLOW');
  assert.throws(() => store.create(blockedRequest(5), allowed), /needs no proposal/);
  assert.throws(() => createProposalStore({ filePath: tempStore() }), /REQUIRES getOwnerPublicKey/);
});

// ---------------------------------------------------------------- typed-data approvals

function mandateEnvelope(digest, overrides = {}) {
  return signMandateAction({
    chainId: CHAIN,
    accountAddress: GATE_ADDRESS,
    kind: 'resolution',
    digest,
    note: 'Raise the per-call cap to 30 for this token.',
    privateKey: OWNER_PRIV,
    ...overrides,
  });
}

test('p11: a typed-data approval is bound to the digest, kind, chain, account and text', async () => {
  const { engine, store } = setup();
  const { proposal } = decideAndPropose(engine, store, blockedRequest(15));
  const resolution = {
    type: 'amend',
    amendment: { kind: 'raise-per-call-cap', token: TOKEN, maxPerCall: '30' },
  };
  const digest = store.digestFor(proposal.id, resolution);

  const wrongDomain = mandateEnvelope(digest);
  wrongDomain.typedData.domain.name = 'Evil Mandate';
  const editedNote = mandateEnvelope(digest);
  editedNote.typedData.message.note += ' (edited after signing)';
  const noTypedData = mandateEnvelope(digest);
  delete noTypedData.typedData;

  const attacks = [
    ['a different digest', mandateEnvelope('0x999')],
    ['a different action kind', mandateEnvelope(digest, { kind: 'ladder-change' })],
    ['a different chain', mandateEnvelope(digest, { chainId: 'SN_MAIN' })],
    ['a different signer account', mandateEnvelope(digest, { accountAddress: '0x1234' })],
    ['a different domain', wrongDomain],
    ['an edited note', editedNote],
    ['no typed data at all', noTypedData],
    ['an unknown scheme', { ...mandateEnvelope(digest), scheme: 'v9' }],
  ];
  for (const [label, signature] of attacks) {
    await assert.rejects(
      store.resolve(proposal.id, resolution, signature),
      /OWNER key/,
      `${label} must not resolve the proposal`,
    );
  }
  assert.equal(store.get(proposal.id).status, 'PENDING', 'no attack may move the proposal');

  const resolved = await store.resolve(proposal.id, resolution, mandateEnvelope(digest));
  assert.equal(resolved.status, 'AMENDED');
  assert.equal(resolved.signature.scheme, 'snip12-v1');
});

test('p12: a typed-data approval is refused when the server has no chain context', async () => {
  const bare = createProposalStore({
    filePath: tempStore(),
    getOwnerPublicKey: async () => OWNER_PUB_X,
  });
  const proposal = bare.create(blockedRequest(15), {
    verdict: 'DENY', code: 'over-per-call-cap',
    reason: 'GateAccount: amount over per-call cap', gate: 'spending',
  });
  const resolution = { type: 'decline' };
  const digest = bare.digestFor(proposal.id, resolution);
  await assert.rejects(
    bare.resolve(proposal.id, resolution, mandateEnvelope(digest)),
    /cannot verify typed-data signatures/,
  );
});

// ---------------------------------------------------------------- live chain binding

test('live: the chain owner key is the user\'s Ready X wallet (post-handover), and old keys are refused', async (t) => {
  // Phase 6 executed: the gate's owner rotated from the pasted testnet key to
  // the user's real Ready X wallet key. This test reads the owner FROM SEPOLIA
  // and pins it against the recorded handover fact — never a hardcoded memory.
  // The wallet's private key was exported once, used to sign the handover, and
  // deleted; it is NOT available here, so the positive wallet-signed path is
  // exercised in the browser at connect/step-10, not headless. What IS proven
  // here: the chain agrees with the record, and every key that is NOT the
  // current owner (the old pasted key, the agent session key) is refused.
  let livePub;
  try {
    livePub = await chainOwnerPublicKey();
  } catch (e) {
    t.skip(`could not read the owner key from Sepolia: ${e.message}`);
    return;
  }

  const { readFileSync } = await import('node:fs');
  const state = JSON.parse(readFileSync(
    new URL('../../gate-account/.sepolia/state.json', import.meta.url), 'utf8'));
  const expectedWalletPub = state.phase6_handover?.real_wallet_probe?.ownerPublicKey
    ?? state.real_wallet_probe?.ownerPublicKey;
  assert.ok(expectedWalletPub, 'state.json records no real_wallet_probe.ownerPublicKey');
  assert.equal(livePub.toLowerCase(), expectedWalletPub.toLowerCase(),
    'chain owner key != the recorded Ready X wallet key — did something move it?');

  const oldOwnerPriv = state.keys.owner.private_key; // HISTORICAL — must no longer work
  const agentPriv = state.keys.agent_session.session_private_key;

  const store = createProposalStore({
    filePath: tempStore(),
    getOwnerPublicKey: () => chainOwnerPublicKey(), // asks the chain every time
  });
  const { proposal } = { proposal: store.create(blockedRequest(15), {
    verdict: 'DENY', code: 'over-per-call-cap', gate: 'spend',
    reason: 'GateAccount: amount over per-call cap',
  }) };

  const resolution = { type: 'execute-once' };
  const digest = store.digestFor(proposal.id, resolution);

  // The agent's key must NOT be able to approve.
  const agentSig = signResolution(digest, agentPriv);
  await assert.rejects(store.resolve(proposal.id, resolution, agentSig), /OWNER key/);

  // The OLD pasted owner key must NOT be able to approve either (rotation is real).
  const oldOwnerSig = signResolution(digest, oldOwnerPriv);
  await assert.rejects(store.resolve(proposal.id, resolution, oldOwnerSig), /OWNER key/);

  console.log('    live: chain owner == Ready X wallet key; old owner + agent keys refused');
});
