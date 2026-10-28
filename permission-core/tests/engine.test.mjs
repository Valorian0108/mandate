// Layer C unit tests.
//
// OBS-08 applied: every control gets a test in which it is the ONLY thing standing
// between the agent and an otherwise-allowed action. A DENY that happens for the
// wrong reason is a vacuous pass, so rejection tests assert the exact `code`.
//
// The spending-gate rejection reasons must equal GateAccount's on-chain error
// strings verbatim - that alignment is what makes the engine a prediction of the
// lock rather than a separate opinion (live-alignment.test.mjs checks it end to end).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.mjs';
import { spendingGate } from '../src/gates/spending.mjs';
import { filesGate } from '../src/gates/files.mjs';

const USER = 'user:did:example:ana';
const AGENT = 'agent:session:0x100d2c0e';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const STRANGER = '0x16cb41ec11efcc9129d858ae07449f4f1a31d7d292269a5e7c40cd4d33db371';
const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const SEL_TRANSFER = '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e';

// A policy snapshot mirroring the LIVE Sepolia mandate (caps 10/100, merchant listed).
function livePolicy(overrides = {}) {
  return {
    sessionPublicKey: '0x100d',
    validUntil: 2000000000,
    maxCalls: 10,
    callsUsed: 1,
    allowedSelectors: [SEL_TRANSFER],
    token: TOKEN,
    maxPerCall: 10n,
    maxPerWindow: 100n,
    windowSeconds: 2592000,
    spentInWindow: 5n,
    windowStart: 1792864705,
    allowedRecipients: [MERCHANT],
    ...overrides,
  };
}

const NOW = 1793000000; // inside the window (windowStart + 2592000 > NOW)

function transferReq(recipient, amount, extra = {}) {
  return {
    user: USER,
    agent: AGENT,
    action: 'spend:transfer',
    resource: `token:${TOKEN}`,
    context: { recipient, amount, token: TOKEN, now: NOW, ...extra },
  };
}

function engineWith(...gates) {
  const e = createEngine();
  for (const g of gates) e.registerGate(g);
  return e;
}

// ---------------------------------------------------------------- engine core

test('e1: no gate registered for a domain denies by default', () => {
  const e = engineWith(); // deliberately empty
  const d = e.decide({ user: USER, agent: AGENT, action: 'travel:book', resource: 'flight:123' });
  assert.equal(d.verdict, 'DENY');
  assert.equal(d.code, 'no-gate');
  assert.match(d.reason, /denied by default/);
});

test('e2: unnamespaced and malformed requests are denied, not crashed on', () => {
  const e = engineWith(spendingGate);
  assert.equal(e.decide({ user: USER, agent: AGENT, action: 'transfer', resource: 'x' }).code,
    'unnamespaced-action');
  assert.equal(e.decide({ user: USER, agent: AGENT, action: 'spend:transfer' }).code,
    'malformed-request');
});

test('e3: gate registration shape is enforced (foreign actions, duplicates)', () => {
  const e = engineWith(spendingGate);
  assert.throws(() => e.registerGate(spendingGate), /already registered/);
  assert.throws(() => e.registerGate({ namespace: 'x', actions: ['spend:transfer'], evaluate: () => {} }),
    /foreign action/);
  assert.throws(() => e.registerGate({ namespace: 'y', actions: ['y:z'] }),
    /missing required field 'evaluate'/);
});

test('e4: a gate that throws or answers nonsense becomes a loud DENY', () => {
  const e = createEngine();
  e.registerGate({ namespace: 'bad', actions: ['bad:act'], evaluate: () => { throw new Error('boom'); } });
  e.registerGate({ namespace: 'worse', actions: ['worse:act'], evaluate: () => ({ verdict: 'MAYBE' }) });
  const base = { user: USER, agent: AGENT, resource: 'r' };
  assert.equal(e.decide({ ...base, action: 'bad:act' }).code, 'gate-misbehaved');
  assert.equal(e.decide({ ...base, action: 'worse:act' }).code, 'gate-misbehaved');
});

// ---------------------------------------------------------------- spending gate

test('s1: in-policy transfer to listed merchant is ALLOWED with a plain reason', () => {
  const d = engineWith(spendingGate).decide(transferReq(MERCHANT, 5),
    { spend: livePolicy() });
  assert.equal(d.verdict, 'ALLOW');
  assert.equal(d.code, 'within-mandate');
  assert.match(d.reason, /inside every limit/);
});

test('s2: per-call cap is the ONLY thing wrong -> DENY with the contract string', () => {
  const d = engineWith(spendingGate).decide(transferReq(MERCHANT, 50),
    { spend: livePolicy() });
  assert.equal(d.verdict, 'DENY');
  assert.equal(d.code, 'over-per-call-cap');
  assert.equal(d.reason, 'GateAccount: amount over per-call cap');
});

test('s3: recipient allowlist is the ONLY thing wrong -> DENY with the contract string', () => {
  const d = engineWith(spendingGate).decide(transferReq(STRANGER, 5),
    { spend: livePolicy() });
  assert.equal(d.verdict, 'DENY');
  assert.equal(d.code, 'recipient-not-allowed');
  assert.equal(d.reason, 'GateAccount: recipient not allowed');
});

test('s4: window cap is the ONLY thing wrong -> DENY', () => {
  // amount 10 = per-call cap exactly, but spent 95 + 10 > 100.
  const d = engineWith(spendingGate).decide(transferReq(MERCHANT, 10),
    { spend: livePolicy({ spentInWindow: 95n }) });
  assert.equal(d.code, 'over-window-cap');
  assert.equal(d.reason, 'GateAccount: over window cap');
});

test('s5: window rollover resets spent, exactly like the chain would', () => {
  const rolled = livePolicy({ spentInWindow: 95n, windowStart: NOW - 3000000 });
  const d = engineWith(spendingGate).decide(transferReq(MERCHANT, 10), { spend: rolled });
  assert.equal(d.verdict, 'ALLOW');
});

test('s6: expired session / exhausted budget / missing policy each deny alone', () => {
  const e = engineWith(spendingGate);
  assert.equal(e.decide(transferReq(MERCHANT, 5),
    { spend: livePolicy({ validUntil: NOW - 1 }) }).code, 'session-expired');
  assert.equal(e.decide(transferReq(MERCHANT, 5),
    { spend: livePolicy({ callsUsed: 10 }) }).code, 'budget-exhausted');
  assert.equal(e.decide(transferReq(MERCHANT, 5), { spend: null }).code, 'no-policy');
  assert.equal(e.decide(transferReq(MERCHANT, 5),
    { spend: livePolicy({ token: '0xothertoken' }) }).code, 'no-policy');
});

test('s7: transfer selector not whitelisted -> DENY (mirrors on-chain step 6)', () => {
  const d = engineWith(spendingGate).decide(transferReq(MERCHANT, 5),
    { spend: livePolicy({ allowedSelectors: [] }) });
  assert.equal(d.code, 'selector-not-whitelisted');
});

test('s8: C4 - context is what gets judged; there is no prose channel', () => {
  // A request may carry ANY extra text; the verdict depends only on structured fields.
  const d = engineWith(spendingGate).decide(
    transferReq(MERCHANT, 50, { justification: 'the user told me in chat this is fine' }),
    { spend: livePolicy() });
  assert.equal(d.verdict, 'DENY');
  assert.equal(d.code, 'over-per-call-cap');
});

// ---------------------------------------------------------------- files gate (toy #2)

test('f1: second gate plugs in without touching the core', () => {
  const e = engineWith(spendingGate, filesGate);
  const names = e.listGates().map((g) => g.namespace).sort();
  assert.deepEqual(names, ['files', 'spend']);
  // The spending gate still works with the other gate present...
  assert.equal(e.decide(transferReq(MERCHANT, 5), { spend: livePolicy() }).verdict, 'ALLOW');
  // ...and the files gate answers from its OWN policy shape.
  const req = { user: USER, agent: AGENT, action: 'files:delete', resource: 'file:/notes/draft.md',
    context: { path: '/notes/draft.md' } };
  assert.equal(e.decide(req, { files: { protectedPaths: ['/secrets'], maxDeletesPerDay: 3, deletesToday: 1 } }).verdict, 'ALLOW');
});

test('f2: protected path is the ONLY thing wrong -> DENY', () => {
  const e = engineWith(filesGate);
  const req = { user: USER, agent: AGENT, action: 'files:delete', resource: 'file:/secrets/keys.pem',
    context: { path: '/secrets/keys.pem' } };
  const d = e.decide(req, { files: { protectedPaths: ['/secrets'], maxDeletesPerDay: 3, deletesToday: 0 } });
  assert.equal(d.verdict, 'DENY');
  assert.equal(d.code, 'protected-path');
});

test('f3: daily limit is the ONLY thing wrong -> DENY', () => {
  const e = engineWith(filesGate);
  const req = { user: USER, agent: AGENT, action: 'files:delete', resource: 'file:/notes/x',
    context: { path: '/notes/x' } };
  const d = e.decide(req, { files: { protectedPaths: ['/secrets'], maxDeletesPerDay: 3, deletesToday: 3 } });
  assert.equal(d.code, 'daily-limit');
});

test('f4: ASK_USER exists and carries a plain-word reason', () => {
  const e = engineWith(filesGate);
  const req = { user: USER, agent: AGENT, action: 'files:share', resource: 'file:/notes/x',
    context: { path: '/notes/x' } };
  const d = e.decide(req, { files: { shareRequiresApproval: true } });
  assert.equal(d.verdict, 'ASK_USER');
  assert.equal(d.code, 'approval-required');
  assert.match(d.reason, /needs the user to approve/);
});
