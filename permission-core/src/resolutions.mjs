// Turns a RESOLVED proposal into on-chain call instructions.
//
// This module is pure: it never signs and never submits. It answers "if the owner
// signed resolution R for proposal P, what exactly goes on-chain?" - as wire-level
// calls { to, entrypoint, calldata: [felt strings] } that the owner submitter
// (gate-account/tools/owner-tx.mjs) executes with the owner key.
//
// Keeping conversion separate from submission means the demo/SDK can SHOW the user
// the exact transactions their approval produces before anything is signed.
//
// v0.2 contract semantics this must respect (src/lib.cairo):
//   set_spending_policy(session, token, max_per_call: u256, max_per_window: u256, window: u64)
//     -> RESTARTS the window: spent_in_window := 0, window_start := block timestamp.
//        That is a real side effect of raising a cap, so every amendment carries a
//        `sideEffects` note the UI must show BEFORE the user signs.
//   allow_recipient(session, token, recipient)
//   ERC-20 transfer wire calldata: [recipient, amount_low, amount_high]

const U128_MASK = (1n << 128n) - 1n;

function u256Wire(value) {
  const v = BigInt(value);
  if (v < 0n) throw new Error(`u256 cannot be negative: ${value}`);
  return ['0x' + (v & U128_MASK).toString(16), '0x' + (v >> 128n).toString(16)];
}

function requireFields(obj, fields, what) {
  for (const f of fields) {
    if (obj?.[f] === undefined || obj[f] === null || obj[f] === '') {
      throw new Error(`${what} is missing '${f}'`);
    }
  }
}

// Record-path-only derivation (OBS-36). Once a cap amendment's transaction has
// LANDED, the live policy equals the amendment target, so the signing-mode
// guard rightly refuses to derive it again ("pointless cap change") - which
// left /api/outside/record unable to adopt the very transaction that applied
// the amendment when the in-flight record write died with a server restart.
// When ctx.verifyApplied is set and the live policy already holds the target,
// the expected wire is the LIVE values: the applied tx carried the target cap
// and preserved every other field, so the post-apply read reproduces the
// pre-apply wire byte for byte. plan/wire/submit never pass this flag - a
// pointless change is never SIGNED, only verified after the chain applied it.
function appliedPolicyCalls(ctx, policy, what) {
  return {
    calls: [{
      to: ctx.gateAddress,
      entrypoint: 'set_spending_policy',
      calldata: [
        ctx.sessionPublicKey,
        policy.token,
        ...u256Wire(policy.maxPerCall),
        ...u256Wire(policy.maxPerWindow),
        '0x' + BigInt(policy.windowSeconds).toString(16),
      ],
    }],
    sideEffects: [
      `${what} is already the live policy - this derivation verifies a transaction ` +
      'that APPLIED it; it is not an offer to sign a new one',
    ],
  };
}

// proposal: a store proposal (status must be APPROVED_ONCE or AMENDED).
// ctx: { gateAddress, sessionPublicKey, currentPolicy } - currentPolicy is the LIVE
//      policy snapshot (mandate-reader), used to preserve fields the amendment does
//      not change.
export function resolutionToCalls(proposal, ctx) {
  requireFields(ctx, ['gateAddress', 'sessionPublicKey', 'currentPolicy'], 'resolution context');
  if (proposal.status === 'PENDING') {
    throw new Error('a PENDING proposal produces no calls - resolve it with the owner key first');
  }
  if (proposal.status === 'DECLINED') {
    throw new Error('a DECLINED proposal produces no calls - the block stands');
  }

  if (proposal.status === 'APPROVED_ONCE') {
    // The owner submits the agent's exact requested action themselves.
    const c = proposal.request?.context ?? {};
    requireFields(c, ['recipient', 'amount', 'token'], 'execute-once request context');
    return {
      calls: [{
        to: c.token,
        entrypoint: 'transfer',
        calldata: [c.recipient, ...u256Wire(c.amount)],
      }],
      sideEffects: ['the owner (not the agent) makes this transfer; the agent gains nothing'],
    };
  }

  // AMENDED
  const amendment = proposal.resolution?.amendment;
  requireFields(amendment, ['kind'], 'amendment');
  const policy = ctx.currentPolicy;

  if (amendment.kind === 'raise-per-call-cap') {
    requireFields(amendment, ['token', 'maxPerCall'], 'raise-per-call-cap amendment');
    if (String(amendment.token).toLowerCase() !== String(policy.token).toLowerCase()) {
      throw new Error('amendment token does not match the live policy token');
    }
    const newCap = BigInt(amendment.maxPerCall);
    if (newCap <= policy.maxPerCall) {
      if (ctx.verifyApplied && newCap === policy.maxPerCall) {
        return appliedPolicyCalls(ctx, policy, `per-call cap ${newCap}`);
      }
      throw new Error(`maxPerCall ${newCap} is not above the current cap ${policy.maxPerCall} - ` +
        'refusing to sign a pointless cap change');
    }
    if (newCap > policy.maxPerWindow) {
      throw new Error(`maxPerCall ${newCap} would exceed the window cap ${policy.maxPerWindow} - ` +
        'the on-chain policy would contradict itself');
    }
    return {
      calls: [{
        to: ctx.gateAddress,
        entrypoint: 'set_spending_policy',
        calldata: [
          ctx.sessionPublicKey,
          amendment.token,
          ...u256Wire(newCap),
          ...u256Wire(policy.maxPerWindow),
          '0x' + BigInt(policy.windowSeconds).toString(16),
        ],
      }],
      sideEffects: [
        `per-call cap: ${policy.maxPerCall} -> ${newCap}`,
        'WARNING (v0.2 contract): re-setting the policy RESTARTS the spending window - ' +
        `spent_in_window resets to 0 (was ${policy.spentInWindow}). The monthly counter starts over.`,
      ],
    };
  }

  if (amendment.kind === 'raise-window-cap') {
    // The way out of the dead corner (OBS-35): when the per-call cap already
    // equals the window cap, "raise the per-call cap" has no valid value. This
    // kind raises the WINDOW cap and preserves the per-call cap, so a per-call
    // raise becomes decidable again as a separate, previewable amendment.
    requireFields(amendment, ['token', 'maxPerWindow'], 'raise-window-cap amendment');
    if (String(amendment.token).toLowerCase() !== String(policy.token).toLowerCase()) {
      throw new Error('amendment token does not match the live policy token');
    }
    const newWindow = BigInt(amendment.maxPerWindow);
    if (newWindow <= policy.maxPerWindow) {
      if (ctx.verifyApplied && newWindow === policy.maxPerWindow) {
        return appliedPolicyCalls(ctx, policy, `window cap ${newWindow}`);
      }
      throw new Error(`maxPerWindow ${newWindow} is not above the current window cap ${policy.maxPerWindow} - ` +
        'refusing to sign a pointless cap change');
    }
    if (newWindow < policy.maxPerCall) {
      throw new Error(`maxPerWindow ${newWindow} would sit below the per-call cap ${policy.maxPerCall} - ` +
        'the on-chain policy would contradict itself');
    }
    return {
      calls: [{
        to: ctx.gateAddress,
        entrypoint: 'set_spending_policy',
        calldata: [
          ctx.sessionPublicKey,
          amendment.token,
          ...u256Wire(policy.maxPerCall),
          ...u256Wire(newWindow),
          '0x' + BigInt(policy.windowSeconds).toString(16),
        ],
      }],
      sideEffects: [
        `window cap: ${policy.maxPerWindow} -> ${newWindow}`,
        `the per-call cap stays at ${policy.maxPerCall} - raising it is a separate, previewable amendment`,
        'WARNING (v0.2 contract): re-setting the policy RESTARTS the spending window - ' +
        `spent_in_window resets to 0 (was ${policy.spentInWindow}). The monthly counter starts over.`,
      ],
    };
  }

  if (amendment.kind === 'allow-recipient') {
    requireFields(amendment, ['token', 'recipient'], 'allow-recipient amendment');
    if (String(amendment.token).toLowerCase() !== String(policy.token).toLowerCase()) {
      throw new Error('amendment token does not match the live policy token');
    }
    return {
      calls: [{
        to: ctx.gateAddress,
        entrypoint: 'allow_recipient',
        calldata: [ctx.sessionPublicKey, amendment.token, amendment.recipient],
      }],
      sideEffects: [`recipient ${amendment.recipient} is added to the allowlist permanently ` +
        '(until disallowed) - it is NOT a one-time exception'],
    };
  }

  throw new Error(`unknown amendment kind '${amendment.kind}'`);
}
