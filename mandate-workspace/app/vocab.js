// Plain language for everything the app says.
//
// Voice rules (the same discipline AnchorGate shipped with): second person,
// active voice, one idea per line, no raw codes on screen, no em dashes, no
// jargon, no fake enthusiasm. Every sentence here is what a user reads cold.
//
// The rule this file exists to keep: the machine's own words never reach a
// screen. Codes become sentences here; raw server errors become plainError().

// ---------------------------------------------------------------- amounts

/** Whole units, no currency symbol (the scenario never names a coin). */
export function units(n) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '0';
}

/** A percentage 0-100, clamped, for meters. */
export function pct(part, whole) {
  const p = Number(part ?? 0);
  const w = Number(whole ?? 0);
  if (!w) return 0;
  return Math.max(0, Math.min(100, Math.round((p / w) * 100)));
}

// ---------------------------------------------------------------- dates

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 1793176023 -> "18 Oct 2026" (local time; a date a person recognises). */
export function dayText(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return 'no date set';
  const d = new Date(n * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Whole days from now until a moment, as a sentence fragment. */
export function daysUntil(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n)) return null;
  const days = Math.ceil((n * 1000 - Date.now()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** "3s ago" / "2 min ago" / "1 h ago" - for the read indicator. */
export function agoText(msEpoch) {
  const t = Number(msEpoch);
  if (!Number.isFinite(t) || t <= 0) return 'not read yet';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

// ---------------------------------------------------------------- verdicts

/** The one-word standing of a decision. ALLOW / DENY / ASK_USER only. */
export function verdictWord(verdict) {
  if (verdict === 'ALLOW') return 'allowed';
  if (verdict === 'ASK_USER') return 'needs you';
  return 'blocked';
}

/** Chip class for a verdict. */
export function verdictClass(verdict) {
  if (verdict === 'ALLOW') return 'chip-allow';
  if (verdict === 'ASK_USER') return 'chip-ask';
  return 'chip-deny';
}

/**
 * The plain sentence for a decision. The machine's reason string is never
 * shown; the code is translated here, and an unknown code still gets an
 * honest sentence rather than a blank or a code.
 */
export function verdictSentence(verdict, code, ctx = {}) {
  const limit = ctx.limit !== undefined ? units(ctx.limit) : null;
  const left = ctx.left !== undefined ? units(ctx.left) : null;
  const store = ctx.store ?? null;

  if (verdict === 'ALLOW') {
    return 'Inside your rules, so it can go ahead.';
  }

  if (verdict === 'ASK_USER') {
    return 'It needs your okay before anything happens.';
  }

  switch (code) {
    case 'over-per-call-cap':
      return limit !== null
        ? `It is over your ${limit} per-purchase limit, so it stopped.`
        : 'It is over your per-purchase limit, so it stopped.';
    case 'over-window-cap':
      return left !== null
        ? `Only ${left} is left of this month's budget, so it stopped.`
        : "It does not fit in this month's budget, so it stopped.";
    case 'recipient-not-allowed':
      return store
        ? `${store} is not on your approved list, so it stopped.`
        : 'That store is not on your approved list, so it stopped.';
    case 'no-policy':
      return 'You have not set rules yet, so nothing can be approved.';
    case 'no-session':
      return 'Your assistant has no active access, so nothing can be approved.';
    case 'session-expired':
      return "Your assistant's access has expired, so nothing can be approved.";
    case 'budget-exhausted':
      return 'Your assistant has used every action it was given.';
    case 'selector-not-whitelisted':
      return 'Your assistant is not allowed to make payments at all.';
    case 'non-positive-amount':
      return 'The amount does not look right, so it is a no.';
    case 'incomplete-context':
      return 'The request is missing something, so it is a no.';
    case 'approval-required':
      return 'It needs your okay before anything happens.';
    case 'malformed-request':
      return 'The request is missing something, so it is a no.';
    case 'unnamespaced-action':
      return 'The request does not say what it wants to do, so it is a no.';
    case 'no-gate':
      return 'There is no rule for that kind of action, so it is a no.';
    case 'action-not-declared':
      return 'Your assistant is not allowed to do that.';
    case 'gate-misbehaved':
      return 'Your rules could not be read, so nothing is approved.';
    default:
      return 'It is a no.';
  }
}

/** The short rule name, for dense rows. Never a raw code. */
export function rulePhrase(code) {
  switch (code) {
    case 'over-per-call-cap': return 'over your per-purchase limit';
    case 'over-window-cap': return "over this month's budget";
    case 'recipient-not-allowed': return 'store not approved';
    case 'no-policy': return 'no rules set';
    case 'no-session': return 'assistant has no access';
    case 'session-expired': return 'assistant access expired';
    case 'budget-exhausted': return 'no actions left';
    case 'selector-not-whitelisted': return 'payments not allowed';
    case 'non-positive-amount': return 'bad amount';
    case 'incomplete-context': return 'incomplete request';
    case 'approval-required': return 'your okay needed';
    case 'within-mandate': return 'within your rules';
    default: return 'not allowed';
  }
}

// ---------------------------------------------------------------- statuses

/** The quiet standing word for a request, in the action column. */
export function statusWord(status) {
  switch (status) {
    case 'PENDING': return 'waiting on you';
    case 'APPROVED_ONCE': return 'you said yes';
    case 'AMENDED': return 'you changed the rules';
    case 'DECLINED': return 'you said no';
    default: return String(status ?? 'unknown').toLowerCase();
  }
}

/** The full sentence for a request's standing. */
export function statusSentence(status) {
  switch (status) {
    case 'PENDING': return 'Waiting on you. Nothing has been charged.';
    case 'APPROVED_ONCE': return 'You approved this one purchase.';
    case 'AMENDED': return 'You changed the rules because of this one.';
    case 'DECLINED': return 'You said no. It stays refused.';
    default: return 'Nothing has happened with this one yet.';
  }
}

export function statusClass(status) {
  switch (status) {
    case 'PENDING': return 'chip-ask';
    case 'APPROVED_ONCE': return 'chip-allow';
    case 'AMENDED': return 'chip-allow';
    case 'DECLINED': return 'chip-deny';
    default: return 'chip-quiet';
  }
}

/** What a decision the owner made is called, in plain words. */
export function resolutionWord(resolution) {
  const type = resolution?.type;
  if (type === 'execute-once') return 'approved once';
  if (type === 'decline') return 'refused';
  if (type === 'amend') {
    const kind = resolution?.amendment?.kind;
    if (kind === 'raise-per-call-cap') return 'raised the per-purchase limit';
    if (kind === 'raise-window-cap') return "raised this month's budget";
    if (kind === 'allow-recipient') return 'approved a new store';
    return 'changed the rules';
  }
  return 'decided';
}

/** The sentence for a payment attempt's outcome. */
export function submissionSentence(sub) {
  switch (sub?.status) {
    case 'SUCCEEDED': return 'Done and recorded.';
    case 'REVERTED': return 'It did not go through. Nothing was charged.';
    case 'PENDING': return 'Still in progress.';
    default: return 'No attempt has been made yet.';
  }
}

export function submissionWord(sub) {
  switch (sub?.status) {
    case 'SUCCEEDED': return 'recorded';
    case 'REVERTED': return 'did not go through';
    case 'PENDING': return 'in progress';
    default: return 'not sent';
  }
}

// ---------------------------------------------------------------- errors

/**
 * Server errors arrive in the machine's own words. They are translated here so
 * a raw message can never reach a screen. The original is kept for the receipt
 * drawer and the dev console, never for the page.
 */
export function plainError(message) {
  const m = String(message ?? '');
  // crypto-surface:start
  // Recognition patterns only. These lines READ the machine's words so they
  // can be translated; the matched text is never emitted. Every branch below
  // returns plain copy, and an unmatched message still gets an honest plain
  // sentence rather than the raw one.
  if (/recipient must be/i.test(m)) return 'Pick a store from the list.';
  if (/amount must be a positive whole number/i.test(m)) return 'Enter a whole number of units, more than zero.';
  if (/positive whole number/i.test(m)) return 'Enter a whole number of units, more than zero.';
  if (/carries no recipient/i.test(m)) return 'This request has no store to approve.';
  if (/is already (APPROVED_ONCE|AMENDED|DECLINED|SUCCEEDED|REVERTED)/i.test(m)) return 'You have already decided this one.';
  if (/only a pending proposal/i.test(m)) return 'This one is already decided.';
  if (/signature does not verify/i.test(m)) return 'That confirmation did not match. Nothing changed.';
  if (/no proposal/i.test(m)) return 'That request is not here any more.';
  if (/did not answer within/i.test(m)) return 'The read took too long. Nothing changed. Try again.';
  if (/refusing to sign a pointless|is not above the current/i.test(m)) return 'That value would change nothing, so it was refused. Pick a number above the current one.';
  if (/would exceed the window cap|would sit below the per-call cap/i.test(m)) return 'Those two limits would contradict each other, so it was refused.';
  if (/cannot build the on-chain call/i.test(m)) return 'That change is not possible right now.';
  if (/no starknet wallet found/i.test(m)) return 'This browser has no account app to confirm with. Open this page in the browser that has yours.';
  if (/declined the connection|user rejected|user denied|rejected the|denied the|cancel/i.test(m)) return 'You turned the confirmation down. Nothing changed.';
  if (/wrong wallet|does not hold the owner key|is not the controller/i.test(m)) return 'That account app is not the one your rules name as owner. Nothing can be confirmed with it.';
  if (/the wallet is on|switch the wallet's network/i.test(m)) return 'Your account app is on the wrong network. Switch it to the one these rules live on, then try again.';
  if (/cannot read which network/i.test(m)) return 'This app could not tell which network your account app is on, so it refused to guess.';
  if (/different digests/i.test(m)) return 'This app and the server disagree about what you are confirming. It refused to continue. Nothing changed.';
  if (/changed after the preview|moved after the preview/i.test(m)) return 'The decision changed while it was being confirmed. Review it again.';
  if (/the live account is not loaded|live mandate is not loaded|owner key on chain is not loaded|refusing to connect blind/i.test(m)) return 'Your live rules are not fully read yet. Wait a moment, then try again.';
  if (/window|nonce/i.test(m)) return 'The confirmation window closed before it finished. Nothing was sent twice; try again and it prepares a fresh one.';
  if (/could not record the transaction/i.test(m)) return 'Your account app sent it, but this app could not record the result. Open the receipt to see what happened.';
  if (/chain has no transaction|cannot read back/i.test(m)) return 'What your account app sent never arrived at your account, and nothing there has heard of it. Nothing was recorded and nothing changed. Trying again prepares a fresh send.';
  if (/the transaction reverted|it did not go through/i.test(m)) return 'It did not go through on your account. Nothing was changed.';
  if (/had not confirmed within|not confirmed within/i.test(m)) return 'It was sent, but the confirmation is taking a while. The record says so honestly.';
  if (/failed to fetch|networkerror|did not answer/i.test(m)) return 'The app cannot reach its own server. Is it still running?';
  // crypto-surface:end
  return 'That did not work. Nothing was changed.';
}

/**
 * What KIND of failure the machine reported, for flow control only: the popup
 * shows different honest endings for "you cancelled", "it was sent but has not
 * confirmed" and "it failed". Recognition happens inside the fence; the returned
 * category words are plain and carry no machine text.
 */
export function failureKind(message) {
  const m = String(message ?? '');
  // crypto-surface:start
  if (/had not confirmed within|not confirmed within/i.test(m)) return 'stalled';
  if (/cancel|user rejected|user denied|declined the connection|rejected the|denied the|turned down/i.test(m)) return 'cancelled';
  // crypto-surface:end
  return 'failed';
}

/**
 * The side effects of a decision, in plain sentences. The machine's own list is
 * always shown verbatim in the popup's machine strip; this is the translation a
 * person reads BEFORE confirming. An effect this file does not recognise is left
 * out here and still appears there, raw - nothing is hidden, only untranslated.
 */
export function sideEffectsPlain(sideEffects = []) {
  const out = [];
  for (const raw of sideEffects.map(String)) {
    // crypto-surface:start
    let m;
    if (/RESTARTS the spending window/i.test(raw)) {
      out.push("Making this change restarts this month's spending count: what has been spent goes back to zero.");
      continue;
    }
    if ((m = /^per-call cap: (\d+) -> (\d+)$/.exec(raw))) {
      out.push(`Your per-purchase limit goes from ${units(m[1])} to ${units(m[2])}.`);
      continue;
    }
    if ((m = /^window cap: (\d+) -> (\d+)$/.exec(raw))) {
      out.push(`This month's budget goes from ${units(m[1])} to ${units(m[2])}.`);
      continue;
    }
    if (/per-call cap stays at/i.test(raw)) {
      out.push('Your per-purchase limit stays as it is. Raising it is a separate decision.');
      continue;
    }
    if (/added to the allowlist permanently/i.test(raw)) {
      out.push('This adds the store to your approved list permanently, until you remove it. It is not a one-time exception.');
      continue;
    }
    if (/the owner \(not the agent\) makes this transfer/i.test(raw)) {
      out.push('You make this payment yourself, once. Your assistant gains no new power.');
      continue;
    }
    if (/the block stands/i.test(raw)) {
      out.push('It stays refused. Nothing is paid, and your no is recorded.');
      continue;
    }
    if (/already the live policy/i.test(raw)) {
      out.push('This change is already live on your account. Confirming it only adopts the record.');
      continue;
    }
    // crypto-surface:end
  }
  return out;
}
