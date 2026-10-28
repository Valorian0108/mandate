// The gate registration format, checked.
//
// Three families of tests, because a format nobody exercises is a format nobody has:
//
//  1. PAPERWORK: valid documents pass; every rule of the format rejects a broken
//     document with a specific, readable error (a stranger must learn WHY).
//  2. PAPERWORK vs CODE: the engine refuses to register a gate whose document
//     contradicts the gate object, and a refused gate leaves its namespace
//     deny-by-default (never half-registered).
//  3. PAPERWORK vs BEHAVIOUR: run each shipped gate through a corpus that hits
//     every path it has, and assert the codes it ACTUALLY returns are exactly
//     the codes its document declares - no more, no less. Same for required
//     context fields. A document that over- or under-promises fails here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../src/engine.mjs';
import { spendingGate } from '../src/gates/spending.mjs';
import { filesGate } from '../src/gates/files.mjs';
import {
  validateGateDocument, validateGateRegistration, GATE_DOCUMENT_VERSION,
} from '../src/gate-schema.mjs';

const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const SEL_TRANSFER = '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e';

function goodDoc(overrides = {}) {
  return {
    version: GATE_DOCUMENT_VERSION,
    namespace: 'toys',
    description: 'A toy gate used only by the schema tests.',
    actions: ['toys:play'],
    contextFields: { 'toys:play': [{ name: 'toy', type: 'string', required: true }] },
    policyFields: ['maxToys'],
    codes: ['too-many-toys', 'within-mandate'],
    approvals: { canAskUser: false, resolutions: ['decline'] },
    advisoryOnly: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------- 1. paperwork

test('both shipped gate documents are valid paperwork', () => {
  for (const gate of [spendingGate, filesGate]) {
    const v = validateGateDocument(gate.document);
    assert.deepEqual(v.errors, [], `${gate.namespace} document errors: ${v.errors.join('; ')}`);
    assert.equal(v.ok, true);
  }
});

test('a minimal well-formed document passes', () => {
  assert.equal(validateGateDocument(goodDoc()).ok, true);
});

test('every rule of the format rejects with a readable error', () => {
  const cases = [
    ['not an object', 'must be an object', 'toys'],
    ['wrong version', 'version must be', { version: 2 }],
    ['bad namespace', 'namespace must be a lowercase word', { namespace: 'Toys' }],
    ['thin description', 'plain sentence', { description: 'hi' }],
    ['no actions', 'actions must be a non-empty array', { actions: [] }],
    ['foreign action', "must look like 'toys:verb'", { actions: ['spend:transfer'] }],
    ['action without colon', "must look like 'toys:verb'", { actions: ['play'] }],
    ['contextFields not object', 'contextFields must be an object', { contextFields: [] }],
    ['contextFields for undeclared action', 'undeclared action', { contextFields: { 'toys:hide': [] } }],
    ['action missing contextFields entry', 'has no contextFields entry', { contextFields: {} }],
    ['bad context type', 'type must be one of', {
      contextFields: { 'toys:play': [{ name: 'toy', type: 'object', required: true }] } }],
    ['missing required flag', 'must say required', {
      contextFields: { 'toys:play': [{ name: 'toy', type: 'string' }] } }],
    ['no policyFields', 'policyFields must be a non-empty array', { policyFields: [] }],
    ['no codes', 'codes must be a non-empty array', { codes: [] }],
    ['uppercase code', 'kebab-case', { codes: ['TooMany'] }],
    ['no approvals', 'approvals must be an object', { approvals: null }],
    ['canAskUser not bool', 'canAskUser must be true or false', { approvals: { canAskUser: 'no', resolutions: ['decline'] } }],
    ['bad resolution kind', 'subset of', { approvals: { canAskUser: false, resolutions: ['veto'] } }],
    ['amend without amendmentKinds', 'must list its amendmentKinds', {
      approvals: { canAskUser: false, resolutions: ['amend'] } }],
    ['advisoryOnly missing', 'advisoryOnly must be true or false', { advisoryOnly: undefined }],
    ['enforced gate without onchain', 'must describe its onchain lock', {
      advisoryOnly: false, onchain: undefined }],
    ['onchain without mirroredErrors', 'mirroredErrors must list', {
      advisoryOnly: false, onchain: { contract: 'X', entrypoints: ['e'] } }],
    ['advisory gate claiming a lock', 'contradiction', {
      advisoryOnly: true, onchain: { contract: 'X', entrypoints: ['e'], mirroredErrors: ['m'] } }],
    ['unknown top-level field', "unknown field 'colour'", { colour: 'blue' }],
    ['unknown approvals field', "unknown field 'vibes'", {
      approvals: { canAskUser: false, resolutions: ['decline'], vibes: 'good' } }],
  ];
  for (const [name, expect, override] of cases) {
    const doc = name === 'not an object' ? 'toys' : goodDoc(override);
    const v = validateGateDocument(doc);
    assert.equal(v.ok, false, `${name}: should have been rejected`);
    assert.ok(v.errors.some((e) => e.includes(expect)),
      `${name}: expected an error containing '${expect}', got: ${v.errors.join(' | ')}`);
  }
});

// ---------------------------------------------------------------- 2. paperwork vs code

test('the engine refuses a gate whose document contradicts its code', () => {
  const contradictions = [
    ['namespace', { ...spendingGate.document, namespace: 'spend2' }],
    ['actions', { ...spendingGate.document, actions: ['spend:transfer', 'spend:refund'] }],
    ['policyFields', { ...spendingGate.document, policyFields: ['token'] }],
    ['advisoryOnly', { ...spendingGate.document, advisoryOnly: true, onchain: undefined }],
    ['broken paperwork', { ...spendingGate.document, version: 99 }],
  ];
  for (const [name, document] of contradictions) {
    const engine = createEngine();
    assert.throws(
      () => engine.registerGate({ ...spendingGate, document }),
      /registration document is invalid/,
      `${name}: registration should have been refused`,
    );
    // And the refusal must be total: the namespace stays deny-by-default.
    const d = engine.decide(
      { user: 'u', agent: 'a', action: 'spend:transfer', resource: `token:${TOKEN}`,
        context: { recipient: MERCHANT, amount: 1, token: TOKEN } },
      { spend: null },
    );
    assert.equal(d.verdict, 'DENY');
    assert.equal(d.code, 'no-gate', `${name}: a refused gate must not half-register`);
  }
});

test('a legacy gate with no document still registers (back-compat)', () => {
  const engine = createEngine();
  engine.registerGate({
    namespace: 'legacy',
    actions: ['legacy:ping'],
    evaluate: () => ({ verdict: 'ALLOW', code: 'ok', reason: 'legacy gate, no paperwork' }),
  });
  const d = engine.decide({ user: 'u', agent: 'a', action: 'legacy:ping', resource: 'r:x', context: {} }, {});
  assert.equal(d.verdict, 'ALLOW');
});

test('validateGateRegistration agrees with the shipped gates', () => {
  for (const gate of [spendingGate, filesGate]) {
    const v = validateGateRegistration(gate);
    assert.deepEqual(v.errors, [], `${gate.namespace}: ${v.errors.join('; ')}`);
  }
});

// ---------------------------------------------------------------- 3. paperwork vs behaviour

// A policy that lets a legal transfer through; individual cases break one rule.
function livePolicy(overrides = {}) {
  return {
    sessionPublicKey: '0x100d2c0e1428a218c21fbbdb88aa30570674e17a79003f39e62a08115806185',
    validUntil: 2000000000,
    maxCalls: 10,
    callsUsed: 0,
    allowedSelectors: [SEL_TRANSFER],
    token: TOKEN,
    maxPerCall: 20n,
    maxPerWindow: 100n,
    windowSeconds: 2592000,
    spentInWindow: 0n,
    windowStart: 1792900709,
    allowedRecipients: [MERCHANT],
    ...overrides,
  };
}

const spendRequest = (ctx = {}) => ({
  user: 'user:x', agent: 'agent:y', action: 'spend:transfer', resource: `token:${TOKEN}`,
  context: { recipient: MERCHANT, amount: 5, token: TOKEN, now: 1792900800, ...ctx },
});

test('the spending document declares exactly the codes the gate can return', () => {
  const cases = [
    ['incomplete-context', spendRequest({ recipient: undefined })],
    ['non-positive-amount', spendRequest({ amount: 0 })],
    ['no-policy', spendRequest(), null],
    ['no-session', spendRequest(), livePolicy({ sessionPublicKey: undefined })],
    ['session-expired', spendRequest(), livePolicy({ validUntil: 1 })],
    ['budget-exhausted', spendRequest(), livePolicy({ callsUsed: 10 })],
    ['selector-not-whitelisted', spendRequest(), livePolicy({ allowedSelectors: [] })],
    ['recipient-not-allowed', spendRequest({ recipient: '0x16cb' })],
    ['over-per-call-cap', spendRequest({ amount: 21 })],
    ['over-window-cap', spendRequest({ amount: 20 }), livePolicy({ spentInWindow: 90n })],
    ['within-mandate', spendRequest()],
  ];
  const seen = new Set();
  for (const [code, request, policy] of cases) {
    const r = spendingGate.evaluate(request, policy === null ? null : (policy ?? livePolicy()));
    assert.equal(r.code, code, `expected path '${code}' but gate said '${r.code}'`);
    seen.add(r.code);
  }
  assert.deepEqual([...seen].sort(), [...spendingGate.document.codes].sort(),
    'document codes must equal the codes the gate actually returns - no more, no less');
});

test('the files document declares exactly the codes the gate can return', () => {
  const policy = { protectedPaths: ['/etc'], maxDeletesPerDay: 2, deletesToday: 0, shareRequiresApproval: true };
  const del = (ctx) => ({ user: 'u', agent: 'a', action: 'files:delete', resource: 'file:x', context: ctx });
  const cases = [
    ['no-policy', del({ path: '/tmp/x' }), null],
    ['incomplete-context', del({}), policy],
    ['protected-path', del({ path: '/etc/passwd' }), policy],
    ['daily-limit', del({ path: '/tmp/x' }), { ...policy, deletesToday: 2 }],
    ['within-mandate', del({ path: '/tmp/x' }), policy],
    ['approval-required', { user: 'u', agent: 'a', action: 'files:share', resource: 'file:x', context: {} }, policy],
    ['within-mandate', { user: 'u', agent: 'a', action: 'files:share', resource: 'file:x', context: {} }, { ...policy, shareRequiresApproval: false }],
  ];
  const seen = new Set();
  for (const [code, request, pol] of cases) {
    const r = filesGate.evaluate(request, pol);
    assert.equal(r.code, code, `expected path '${code}' but gate said '${r.code}'`);
    seen.add(r.code);
  }
  assert.deepEqual([...seen].sort(), [...filesGate.document.codes].sort());
});

test('required context fields in the documents match what the gates actually demand', () => {
  // Removing any required field must produce incomplete-context; with all of
  // them present it must never appear.
  for (const [gate, policy, makeRequest] of [
    [spendingGate, livePolicy(), (action, ctx) => spendRequest(ctx)],
    [filesGate, { protectedPaths: [], maxDeletesPerDay: 1, deletesToday: 0, shareRequiresApproval: false },
      (action, ctx) => ({ user: 'u', agent: 'a', action, resource: 'file:x', context: ctx })],
  ]) {
    for (const [action, fields] of Object.entries(gate.document.contextFields)) {
      const required = fields.filter((f) => f.required).map((f) => f.name);
      const full = Object.fromEntries(fields.map((f) => [f.name, f.type === 'uint' ? 1 : f.type === 'address' ? MERCHANT : '/tmp/x']));
      if (action === 'spend:transfer') { full.token = TOKEN; full.now = 1792900800; }
      for (const name of required) {
        const broken = { ...full, [name]: undefined };
        const r = gate.evaluate(makeRequest(action, broken), policy);
        assert.equal(r.code, 'incomplete-context',
          `${gate.namespace}:${action} without '${name}' should be incomplete-context, got ${r.code}`);
      }
      const r = gate.evaluate(makeRequest(action, { ...full }), policy);
      assert.notEqual(r.code, 'incomplete-context',
        `${gate.namespace}:${action} with every required field must not complain about context`);
    }
  }
});

test('the documents tell the truth about ASK_USER', () => {
  // canAskUser:false means no input can produce ASK_USER. Probe the spend gate
  // with the same corpus plus nonsense and hold it to its claim.
  const probes = [
    spendRequest(), spendRequest({ amount: 999999 }), spendRequest({ recipient: '0x0' }),
    spendRequest({ token: '0xdead' }),
  ];
  for (const p of probes) {
    for (const policy of [livePolicy(), null]) {
      const r = spendingGate.evaluate(p, policy);
      if (!spendingGate.document.approvals.canAskUser) assert.notEqual(r.verdict, 'ASK_USER');
    }
  }
  // And the files gate, which claims it, must actually be able to.
  const r = filesGate.evaluate(
    { user: 'u', agent: 'a', action: 'files:share', resource: 'file:x', context: {} },
    { protectedPaths: [], maxDeletesPerDay: 1, deletesToday: 0, shareRequiresApproval: true },
  );
  assert.equal(r.verdict, 'ASK_USER');
  assert.equal(filesGate.document.approvals.canAskUser, true);
});
