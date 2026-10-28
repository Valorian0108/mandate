// Gate #1: the spending gate.
//
// This gate's rules are not its own - they are a MIRROR of GateAccount's on-chain
// enforcement (gate-account/src/lib.cairo), the same checks in the same order, with
// the contract's exact error strings as reasons. That is deliberate: the off-chain
// engine predicts what the lock will do, and the live-alignment test
// (tests/live-alignment.test.mjs) holds the prediction against the real chain state
// and the three real Sepolia verdicts from Stage 2.
//
// On-chain order being mirrored:
//   __validate__:  session exists -> not expired -> call budget left -> selector whitelisted
//   __execute__ (enforce_spending): policy exists -> recipient allowed ->
//                                   per-call cap -> window cap
// Anything the chain would reject, this gate must DENY with the same words.
// (The chain is still the final authority - see the engine's split note.)

const SEL_TRANSFER = '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e';

// The gate's paperwork (see GATE-FORMAT.md / src/gate-schema.mjs). The engine
// checks it at registration; tests/gate-schema.test.mjs checks it against the
// gate's ACTUAL behaviour, so this document cannot drift from the code.
const POLICY_FIELDS = [
  'sessionPublicKey', 'validUntil', 'maxCalls', 'callsUsed', 'allowedSelectors',
  'token', 'maxPerCall', 'maxPerWindow', 'windowSeconds', 'spentInWindow',
  'windowStart', 'allowedRecipients',
];

export const spendingGateDocument = {
  version: 1,
  namespace: 'spend',
  description: 'Mirrors the GateAccount lock: who the agent may pay, how much per call and per window.',
  actions: ['spend:transfer'],
  contextFields: {
    'spend:transfer': [
      { name: 'recipient', type: 'address', required: true },
      { name: 'amount', type: 'uint', required: true },
      { name: 'token', type: 'address', required: true },
      { name: 'now', type: 'uint', required: false },
    ],
  },
  policyFields: POLICY_FIELDS,
  codes: [
    'incomplete-context', 'non-positive-amount', 'no-policy', 'no-session',
    'session-expired', 'budget-exhausted', 'selector-not-whitelisted',
    'recipient-not-allowed', 'over-per-call-cap', 'over-window-cap', 'within-mandate',
  ],
  approvals: {
    canAskUser: false,
    resolutions: ['execute-once', 'amend', 'decline'],
    amendmentKinds: ['raise-per-call-cap', 'raise-window-cap', 'allow-recipient'],
  },
  advisoryOnly: false,
  onchain: {
    contract: 'GateAccount',
    entrypoints: ['__validate__', 'enforce_spending'],
    mirroredErrors: [
      'GateAccount: no spending policy for token',
      'GateAccount: recipient not allowed',
      'GateAccount: amount over per-call cap',
      'GateAccount: over window cap',
    ],
  },
};

function deny(code, reason) {
  return { verdict: 'DENY', code, reason };
}

export const spendingGate = {
  namespace: 'spend',
  actions: ['spend:transfer'],
  // What the policy snapshot must contain (mandate-reader.mjs fills these from the chain).
  policyFields: POLICY_FIELDS,
  advisoryOnly: false, // enforced on-chain by GateAccount; this is the fast pre-check.
  document: spendingGateDocument,

  evaluate(request, policy) {
    const ctx = request.context ?? {};
    const { recipient, amount, token } = ctx;
    // C4: numbers and addresses only. `amount` must be a whole token unit count.
    if (recipient === undefined || amount === undefined || token === undefined) {
      return deny('incomplete-context',
        'a spend:transfer request needs recipient, amount and token in its context');
    }
    const amt = (() => {
      try {
        return BigInt(amount);
      } catch {
        return null;
      }
    })();
    if (amt === null) {
      return deny('incomplete-context',
        `amount must be a whole token unit count, got '${amount}'`);
    }
    if (amt <= 0n) {
      return deny('non-positive-amount', `amount must be positive, got ${amount}`);
    }

    // No policy snapshot at all: the chain denies spends without a policy, so do we.
    if (!policy) {
      return deny('no-policy', 'GateAccount: no spending policy for token');
    }

    // --- the __validate__ half ---
    const now = (() => {
      try {
        return BigInt(ctx.now ?? Math.floor(Date.now() / 1000));
      } catch {
        return null;
      }
    })();
    if (now === null) {
      return deny('incomplete-context',
        `context.now must be a whole Unix timestamp, got '${ctx.now}'`);
    }
    if (!policy.sessionPublicKey || policy.validUntil === undefined) {
      return deny('no-session', 'no session key is registered for this agent');
    }
    if (now > BigInt(policy.validUntil)) {
      return deny('session-expired', 'the agent session has expired');
    }
    if (BigInt(policy.callsUsed ?? 0) >= BigInt(policy.maxCalls ?? 0)) {
      return deny('budget-exhausted', 'the agent has used all of its call budget');
    }
    const selectors = (policy.allowedSelectors ?? []).map((s) => s.toLowerCase());
    if (selectors.length === 0 || !selectors.includes(SEL_TRANSFER)) {
      return deny('selector-not-whitelisted',
        'the agent session does not allow transfer calls');
    }
    if (String(token).toLowerCase() !== String(policy.token).toLowerCase()) {
      // Per (session, token) policy on-chain; a different token simply has no policy.
      return deny('no-policy', 'GateAccount: no spending policy for token');
    }

    // --- the enforce_spending half, in the contract's exact order ---
    const norm = (x) => String(x).toLowerCase().replace(/^0x0+/, '0x');
    const allowed = (policy.allowedRecipients ?? []).map(norm);
    if (!allowed.includes(norm(recipient))) {
      return deny('recipient-not-allowed', 'GateAccount: recipient not allowed');
    }
    if (amt > BigInt(policy.maxPerCall)) {
      return deny('over-per-call-cap', 'GateAccount: amount over per-call cap');
    }
    // Window rollover: if the window has elapsed, the chain resets spent to 0 first.
    const windowStart = BigInt(policy.windowStart ?? 0);
    const windowSeconds = BigInt(policy.windowSeconds ?? 0);
    const spent = now >= windowStart + windowSeconds ? 0n : BigInt(policy.spentInWindow ?? 0);
    if (spent + amt > BigInt(policy.maxPerWindow)) {
      return deny('over-window-cap', 'GateAccount: over window cap');
    }

    return {
      verdict: 'ALLOW',
      code: 'within-mandate',
      reason: `transfer of ${amt} to a listed merchant is inside every limit ` +
        `(per-call ${policy.maxPerCall}, window ${policy.maxPerWindow}, ` +
        `spent so far ${spent})`,
    };
  },
};
