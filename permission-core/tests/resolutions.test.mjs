// resolutions.mjs tests: the pure conversion from a RESOLVED proposal to the exact
// on-chain calls. Nothing here touches the network - the point is that the wire-level
// output is pinned down before anything is signed or submitted, and that impossible or
// pointless amendments are refused at conversion time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolutionToCalls } from '../src/resolutions.mjs';

const GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const SESSION = '0x100d2c0e1428a218c21fbbdb88aa30570674e17a79003f39e62a08115806185';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const STRANGER = '0x16cb41ec11efcc9129d858ae07449f4f1a31d7d292269a5e7c40cd4d33db371';

// Shape mirrors mandate-reader.readLiveMandate output (BigInt caps, Number times).
function policy(over = {}) {
  return {
    sessionPublicKey: SESSION, validUntil: 2000000000, maxCalls: 10, callsUsed: 1,
    allowedSelectors: ['0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e'],
    token: TOKEN,
    maxPerCall: 10n, maxPerWindow: 100n, windowSeconds: 2592000,
    spentInWindow: 5n, windowStart: 1792864705, allowedRecipients: [MERCHANT],
    ...over,
  };
}

function ctx(over = {}) {
  return { gateAddress: GATE, sessionPublicKey: SESSION, currentPolicy: policy(), ...over };
}

const approvedOnce = (over = {}) => ({
  status: 'APPROVED_ONCE',
  request: { context: { recipient: MERCHANT, amount: 15, token: TOKEN, ...over } },
  resolution: { type: 'execute-once' },
});

const amended = (amendment) => ({
  status: 'AMENDED',
  request: { context: { recipient: MERCHANT, amount: 15, token: TOKEN } },
  resolution: { type: 'amend', amendment },
});

// ---------------------------------------------------------------- happy paths

test('r1: execute-once becomes the owner submitting the exact requested transfer', () => {
  const { calls, sideEffects } = resolutionToCalls(approvedOnce(), ctx());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(calls[0].entrypoint, 'transfer');
  // ERC-20 wire: [recipient, amount_low, amount_high]; 15 fits in low.
  assert.deepEqual(calls[0].calldata, [MERCHANT, '0xf', '0x0']);
  assert.ok(sideEffects.some((s) => /owner \(not the agent\)/.test(s)),
    'must say plainly that the OWNER makes this transfer');
});

test('r2: raise-per-call-cap preserves the untouched policy fields and warns about the window restart', () => {
  const { calls, sideEffects } = resolutionToCalls(
    amended({ kind: 'raise-per-call-cap', token: TOKEN, maxPerCall: '20' }), ctx());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to.toLowerCase(), GATE.toLowerCase());
  assert.equal(calls[0].entrypoint, 'set_spending_policy');
  // Wire: [session, token, mpc_low, mpc_high, mpw_low, mpw_high, window_seconds]
  // new cap 20; window cap 100 and window 2592000 (= 0x278d00) taken from the LIVE policy.
  assert.equal((2592000).toString(16), '278d00', 'test literal must be right');
  assert.deepEqual(calls[0].calldata,
    [SESSION, TOKEN, '0x14', '0x0', '0x64', '0x0', '0x278d00']);
  const joined = sideEffects.join(' | ');
  assert.match(joined, /10 -> 20/, 'must state the exact cap change');
  assert.match(joined, /RESTARTS the spending window/, 'must carry the v0.2 window-restart warning');
  assert.match(joined, /was 5/, 'the warning must quote the spent amount being reset');
});

test('r7: allow-recipient adds the recipient permanently and says so', () => {
  const { calls, sideEffects } = resolutionToCalls(
    amended({ kind: 'allow-recipient', token: TOKEN, recipient: STRANGER }), ctx());
  assert.equal(calls[0].to.toLowerCase(), GATE.toLowerCase());
  assert.equal(calls[0].entrypoint, 'allow_recipient');
  assert.deepEqual(calls[0].calldata, [SESSION, TOKEN, STRANGER]);
  assert.ok(sideEffects.some((s) => /permanently/.test(s) && /NOT a one-time exception/.test(s)),
    'must warn that allowlisting is permanent, not one-time');
});

test('r8: u256 values above 2^128 split correctly into low/high', () => {
  const huge = (2n ** 128n + 7n).toString();
  const { calls } = resolutionToCalls(approvedOnce({ amount: huge }), ctx({
    currentPolicy: policy({ maxPerCall: 2n ** 128n + 7n, maxPerWindow: 2n ** 129n }),
  }));
  assert.deepEqual(calls[0].calldata, [MERCHANT, '0x7', '0x1']);
});

// ---------------------------------------------------------------- refusals

test('r3: a cap change that does not raise the cap is refused', () => {
  for (const bad of ['10', '9', '0']) {
    assert.throws(
      () => resolutionToCalls(
        amended({ kind: 'raise-per-call-cap', token: TOKEN, maxPerCall: bad }), ctx()),
      /not above the current cap/,
      `maxPerCall=${bad} should be refused`);
  }
});

test('r4: a per-call cap above the window cap is refused (self-contradictory policy)', () => {
  assert.throws(
    () => resolutionToCalls(
      amended({ kind: 'raise-per-call-cap', token: TOKEN, maxPerCall: '101' }), ctx()),
    /exceed the window cap/);
});

test('r5: PENDING and DECLINED proposals produce no calls', () => {
  const pending = { ...approvedOnce(), status: 'PENDING', resolution: null };
  assert.throws(() => resolutionToCalls(pending, ctx()), /resolve it with the owner key first/);
  const declined = { ...approvedOnce(), status: 'DECLINED', resolution: { type: 'decline' } };
  assert.throws(() => resolutionToCalls(declined, ctx()), /the block stands/);
});

test('r6: unknown amendment kinds and token mismatches are refused', () => {
  assert.throws(
    () => resolutionToCalls(amended({ kind: 'mint-more-tokens' }), ctx()),
    /unknown amendment kind/);
  assert.throws(
    () => resolutionToCalls(
      amended({ kind: 'raise-per-call-cap', token: STRANGER, maxPerCall: '20' }), ctx()),
    /does not match the live policy token/);
});

test('r9: a missing context is a loud error, never a half-built transaction', () => {
  assert.throws(() => resolutionToCalls(approvedOnce(), { gateAddress: GATE }),
    /missing 'sessionPublicKey'|missing 'currentPolicy'/);
  const noAmount = {
    status: 'APPROVED_ONCE',
    request: { context: { recipient: MERCHANT, token: TOKEN } }, // amount missing
    resolution: { type: 'execute-once' },
  };
  assert.throws(() => resolutionToCalls(noAmount, ctx()), /missing 'amount'/);
});

// ---------------------------------------------------------------- window cap
// The dead corner (OBS-35): step 10 set the per-call cap EQUAL to the window
// cap (100 == 100), so "raise the per-call cap" has no valid value left -
// anything above 100 exceeds the window cap, anything at or below 100 is
// pointless. This kind is the way out: raise the WINDOW cap, keep the
// per-call cap, and the per-call raise becomes decidable again.

test('r10: raise-window-cap preserves the per-call cap and window seconds and warns about the restart', () => {
  const { calls, sideEffects } = resolutionToCalls(
    amended({ kind: 'raise-window-cap', token: TOKEN, maxPerWindow: '200' }), ctx());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to.toLowerCase(), GATE.toLowerCase());
  assert.equal(calls[0].entrypoint, 'set_spending_policy');
  // Wire: [session, token, mpc_low, mpc_high, mpw_low, mpw_high, window_seconds]
  // per-call cap stays 10 (0xa), window cap 100 -> 200 (0xc8), window 2592000 (0x278d00).
  assert.deepEqual(calls[0].calldata,
    [SESSION, TOKEN, '0xa', '0x0', '0xc8', '0x0', '0x278d00']);
  const joined = sideEffects.join(' | ');
  assert.match(joined, /window cap: 100 -> 200/, 'must state the exact window-cap change');
  assert.match(joined, /per-call cap stays at 10/, 'must say the per-call cap is untouched');
  assert.match(joined, /RESTARTS the spending window/, 'the same v0.2 side effect as any policy re-set');
  assert.match(joined, /was 5/, 'the warning must quote the spent amount being reset');
});

test('r11: a window-cap change that does not raise the window cap is refused', () => {
  for (const bad of ['100', '99', '0']) {
    assert.throws(
      () => resolutionToCalls(
        amended({ kind: 'raise-window-cap', token: TOKEN, maxPerWindow: bad }), ctx()),
      /not above the current window cap/,
      `maxPerWindow=${bad} should be refused`);
  }
});

test('r12: a new window cap below the per-call cap is refused, and so is a token mismatch', () => {
  // Unreachable while the live policy is coherent (perCall <= window), but a
  // self-contradictory live record must never be made WORSE by an amendment:
  // the new window cap may not sit below the per-call cap it preserves.
  assert.throws(
    () => resolutionToCalls(
      amended({ kind: 'raise-window-cap', token: TOKEN, maxPerWindow: '120' }),
      ctx({ currentPolicy: policy({ maxPerCall: 150n, maxPerWindow: 100n }) })),
    /below the per-call cap/);
  assert.throws(
    () => resolutionToCalls(
      amended({ kind: 'raise-window-cap', token: STRANGER, maxPerWindow: '200' }), ctx()),
    /does not match the live policy token/);
});

// ---------------------------------------------------------------- record mode
// The adoption problem (OBS-36): once a cap-raise transaction has LANDED, the
// live policy equals the amendment target, so re-deriving for SIGNING rightly
// refuses a pointless change - which left the console unable to adopt the very
// transaction that applied it when the in-flight record write died with a
// server restart. `verifyApplied` is the record-path-only escape: when the
// live policy already holds the target, the tx IS the amendment, and the
// expected wire is the live values (byte-identical to the pre-apply derivation
// for the fields the amendment preserved). plan/wire/submit never pass it.

test('r13: verifyApplied adopts an already-landed window-cap raise and expects exactly the live values', () => {
  const target = amended({ kind: 'raise-window-cap', token: TOKEN, maxPerWindow: '200' });
  const applied = ctx({ currentPolicy: policy({ maxPerWindow: 200n, spentInWindow: 0n }) });
  // Signing mode still refuses - the exact guard that killed the naive record.
  assert.throws(() => resolutionToCalls(target, applied), /not above the current window cap/);
  // Record mode: the expected call is the live policy itself (per-call 10
  // preserved, window now 200, seconds kept).
  const { calls } = resolutionToCalls(target, { ...applied, verifyApplied: true });
  assert.deepEqual(calls[0].calldata,
    [SESSION, TOKEN, '0xa', '0x0', '0xc8', '0x0', '0x278d00']);
  // A target the live policy does NOT hold stays refused even in record mode:
  // no transaction could have applied it.
  assert.throws(
    () => resolutionToCalls(
      amended({ kind: 'raise-window-cap', token: TOKEN, maxPerWindow: '150' }),
      { ...applied, verifyApplied: true }),
    /not above the current window cap/);
});

test('r14: verifyApplied covers the per-call kind the same way', () => {
  const target = amended({ kind: 'raise-per-call-cap', token: TOKEN, maxPerCall: '30' });
  const applied = ctx({ currentPolicy: policy({ maxPerCall: 30n, spentInWindow: 0n }) });
  assert.throws(() => resolutionToCalls(target, applied), /not above the current cap/);
  const { calls } = resolutionToCalls(target, { ...applied, verifyApplied: true });
  assert.deepEqual(calls[0].calldata,
    [SESSION, TOKEN, '0x1e', '0x0', '0x64', '0x0', '0x278d00']);
});
