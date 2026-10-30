// The five screens. Vanilla JS, no build step, no framework.
//
// What this file may say: plain language only. The machine's own words
// (codes, statuses, errors) are translated in vocab.js before they reach a
// screen, machine identifiers are mapped to cast names in stores.js, and the
// jargon gate (tools/check-jargon.mjs) fails the build if crypto-native
// vocabulary appears outside an approved crypto-surface block. The two
// approved places are the confirmation popup (phase 2) and the receipt
// drawers (phase 3).
//
// Data: read live from the account through the tested server's API. Nothing
// here is stored or faked; a failed read is shown as a failed read.

import { getMandate, getProposals, fileAsk, pollReceipt } from './data.js';
import {
  plainError, verdictWord, verdictClass, verdictSentence, rulePhrase,
  statusWord, statusClass, statusSentence, resolutionWord, submissionWord,
  units, pct, dayText, daysUntil, agoText, failureKind, sideEffectsPlain,
} from './vocab.js';
import { STORES, storeName, storeWhat, storeFor, isApproved } from './stores.js';
// The machine layer for decisions. Every function here either does the
// confirmed-elsewhere crypto work or renders the dark machine strips; this file
// only ever calls them and shows their HTML, so the screens stay plain.
import {
  walletChoices, connectOwnerWallet, resolutionFromChoice, buildPreview,
  previewIsCurrent, signResolution, planSubmission, controllerIs, submitViaWallet,
  receiptOutcome, receiptErrorMessage,
  reviewMachineHtml, walletMachineHtml, walletPickerHtml, stageMachineHtml,
  planMachineHtml, receiptMachineHtml, resolutionMachineHtml, errorMachineHtml,
  recordReceiptMachineHtml, liveReceipt,
} from './decide.js';

// ------------------------------------------------------------------ state

const S = {
  route: 'rules',

  mandate: null,
  mandateError: null,
  mandateAt: 0,
  loadingMandate: false,

  proposals: null,
  submissions: [],
  proposalsError: null,
  proposalsAt: 0,
  loadingProposals: false,

  ask: null,       // last ask result: { kind: 'ok'|'error', ... }
  askForm: null,   // remembered picker values, restored after re-render
  asking: false,

  // The Waiting screen's decision state. Machine-layer objects (the preview,
  // the plan, the connected account app) live here untouched; screens only
  // hand them back to decide.js. Deliberate survivals across decisions:
  // signer/walletInfo (a connected account app stays connected, the console's
  // rule) and `done` (the last receipt stays available until replaced).
  waiting: {
    id: null,          // the proposal being decided (#/waiting/<id>)
    choice: 'once',    // once | amend | decline
    form: null,        // { kind, cap, windowCap, recipient }
    formTouched: false,
    preview: null,
    building: false,
    error: null,
    modal: null,       // { stage, ... }
    walletApps: [],
    walletId: null,
    signer: null,
    walletInfo: null,
    resolved: false,
    confirmation: null,
    plan: null,
    txHash: null,
    record: null,
    receipt: null,
    receiptTries: 0,
    doneKind: null,
    done: null,
    running: false,
    flowResumed: false,
  },
};

// How old a live read may be before entering a screen triggers a new one.
const FRESH_MS = 120_000;

// ------------------------------------------------------------------ dom

const $ = (id) => document.getElementById(id);

const els = {
  screen: $('screen'),
  title: $('screen-title'),
  sub: $('screen-sub'),
  status: $('topbar-status'),
  flash: $('flash'),
  waitCount: $('nav-wait-count'),
  drawer: $('drawer'),
  drawerTitle: $('drawer-title'),
  drawerBody: $('drawer-body'),
  drawerClose: $('drawer-close'),
  backdrop: $('drawer-backdrop'),
  modal: $('modal'),
  modalBackdrop: $('modal-backdrop'),
  modalTitle: $('modal-title'),
  modalBody: $('modal-body'),
  modalClose: $('modal-close'),
};

/** Escape anything that came from a machine before it goes near the DOM. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ------------------------------------------------------------------ routing

const ROUTES = {
  rules: { title: 'Rules', sub: 'What your assistant may spend, read live from your account.' },
  requests: { title: 'Requests', sub: 'Every ask your assistant made, and what your rules did with it.' },
  waiting: { title: 'Waiting for you', sub: 'Nothing here moves until you decide.' },
  activity: { title: 'Activity', sub: 'Every change and payment, in order, kept forever.' },
  how: { title: 'How it works', sub: 'The whole system, in plain words.' },
};

function routeFromHash() {
  const h = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  const cut = h.indexOf('/');
  const base = cut === -1 ? h : h.slice(0, cut);
  const param = cut === -1 ? null : (h.slice(cut + 1) || null);
  return {
    route: Object.prototype.hasOwnProperty.call(ROUTES, base) ? base : 'rules',
    param,
  };
}

function navigate() {
  const { route, param } = routeFromHash();
  S.route = route;
  for (const a of document.querySelectorAll('.nav-item')) {
    if (a.dataset.route === S.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (route === 'waiting') setWaitingTarget(param);
  const r = ROUTES[S.route];
  els.title.textContent = r.title;
  els.sub.textContent = r.sub;
  ensureRouteData();
  render();
}

function proposalById(id) {
  return (S.proposals ?? []).find((p) => p.id === id) ?? null;
}

/** Enter (or leave) a decision. Never yanks the screen during a live flow. */
function setWaitingTarget(id) {
  const w = S.waiting;
  if (w.id === id) return;
  if (w.running) return;
  resetDecision(id);
  maybeInitDecisionForm();
}

function resetDecision(id) {
  const w = S.waiting;
  w.id = id;
  w.choice = 'once';
  w.form = null;
  w.formTouched = false;
  w.preview = null;
  w.building = false;
  w.error = null;
  w.modal = null;
  w.resolved = false;
  w.confirmation = null;
  w.plan = null;
  w.txHash = null;
  w.record = null;
  w.receipt = null;
  w.receiptTries = 0;
  w.doneKind = null;
  w.flowResumed = false;
  // signer, walletInfo, walletApps, walletId and done deliberately survive.
}

function ensureRouteData() {
  const stale = (at) => !at || Date.now() - at > FRESH_MS;
  // The live read powers the status chip on every screen, so it is kept
  // fresh everywhere; proposals only where a screen lists them.
  if (!S.loadingMandate && (!S.mandate || stale(S.mandateAt))) loadMandate();
  const needsProposals = ['requests', 'waiting', 'activity'].includes(S.route);
  if (needsProposals && !S.loadingProposals && (!S.proposals || stale(S.proposalsAt))) loadProposals();
}

// ------------------------------------------------------------------ loaders

async function loadMandate(force = false) {
  if (S.loadingMandate) return;
  if (!force && S.mandate && Date.now() - S.mandateAt < FRESH_MS) return;
  S.loadingMandate = true;
  renderStatus();
  try {
    S.mandate = await getMandate();
    S.mandateError = null;
    S.mandateAt = Date.now();
  } catch (e) {
    S.mandateError = plainError(e.message);
  } finally {
    S.loadingMandate = false;
    renderStatus();
    maybeInitDecisionForm();
    render();
  }
}

async function loadProposals(force = false) {
  if (S.loadingProposals) return;
  if (!force && S.proposals && Date.now() - S.proposalsAt < FRESH_MS) return;
  S.loadingProposals = true;
  try {
    const j = await getProposals();
    S.proposals = j?.proposals ?? [];
    S.submissions = j?.submissions ?? [];
    S.proposalsError = null;
    S.proposalsAt = Date.now();
  } catch (e) {
    S.proposalsError = plainError(e.message);
  } finally {
    S.loadingProposals = false;
    updateWaitBadge();
    maybeInitDecisionForm();
    render();
  }
}

// ------------------------------------------------------------------ status chip

function renderStatus() {
  if (S.loadingMandate && !S.mandate) {
    els.status.innerHTML = '<span class="read-chip"><span class="dot dot-wait"></span>reading your rules…</span>';
    return;
  }
  if (!S.mandate) {
    els.status.innerHTML = `
      <span class="read-chip is-bad"><span class="dot dot-stop"></span>${esc(S.mandateError ?? 'not read yet')}</span>
      <button class="btn btn-sm" type="button" data-action="retry">Try again</button>`;
    return;
  }
  const chip = S.mandateError
    ? '<span class="read-chip is-bad"><span class="dot dot-stop"></span>last refresh failed</span>'
    : `<span class="read-chip"><span class="dot dot-ok"></span>read ${esc(agoText(S.mandateAt))}</span>`;
  els.status.innerHTML = `${chip}
    <button class="btn btn-sm btn-quiet" type="button" data-action="refresh">Refresh</button>`;
}

function updateWaitBadge() {
  if (!S.proposals) return;
  const n = S.proposals.filter((p) => p.status === 'PENDING').length;
  els.waitCount.textContent = String(n);
  els.waitCount.hidden = n === 0;
}

// ------------------------------------------------------------------ shared bits

function skelHtml(n = 2) {
  return '<div class="skel skel-card"></div>'.repeat(n);
}

function errorCardHtml(message) {
  return `<div class="card"><div class="card-body">
    <p>${esc(message ?? 'The read did not work.')}</p>
    <p class="card-note"><button class="btn btn-sm" type="button" data-action="retry">Try again</button></p>
  </div></div>`;
}

function finalSubmissionFor(id) {
  const mine = S.submissions.filter((s) => s.proposalId === id);
  return mine.find((s) => s.status === 'SUCCEEDED' || s.status === 'REVERTED')
    ?? mine[mine.length - 1] ?? null;
}

function flash(message, bad = false) {
  const el = document.createElement('div');
  el.className = bad ? 'flash flash-bad' : 'flash';
  el.textContent = message;
  els.flash.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function closeDrawer() {
  els.drawer.hidden = true;
  els.backdrop.hidden = true;
}

// ------------------------------------------------------------------ rules screen

function askCardHtml(m, left) {
  const perCall = Number(m.maxPerCall);
  const allowed = m.allowedRecipients ?? [];
  const options = STORES.map((s) => {
    const ok = isApproved(s.id, allowed);
    return `<option value="${esc(s.id)}">${esc(s.name)} · ${ok ? 'approved' : 'not approved'}</option>`;
  }).join('');

  // Quick picks computed from the LIVE numbers, never hard-coded.
  const inside = left > 30 ? Math.min(perCall, left) - 30 : 0;
  const over = perCall + 250;
  const notApproved = STORES.find((s) => !isApproved(s.id, allowed));

  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">try it</div>
        <div class="card-title">Ask for a purchase</div>
      </div>
    </div>
    <div class="card-body">
      <form class="ask-form" data-action="ask">
        <label class="field">
          <span class="field-label">Store</span>
          <select class="control" id="ask-store">${options}</select>
        </label>
        <label class="field">
          <span class="field-label">Amount, in units</span>
          <input class="control" id="ask-amount" type="number" min="1" step="1" inputmode="numeric" placeholder="120">
        </label>
        <button class="btn btn-primary" id="ask-go" type="submit">Check it</button>
      </form>
      <div class="quick-row">
        <span class="quick-label">Try one of these:</span>
        ${inside > 0 ? `<button class="quick" type="button" data-action="quick" data-amount="${inside}">inside your limit · ${units(inside)}</button>` : ''}
        <button class="quick" type="button" data-action="quick" data-amount="${over}">over your limit · ${units(over)}</button>
        ${notApproved ? `<button class="quick" type="button" data-action="quick-store" data-amount="${Math.max(1, inside || 40)}">${esc(notApproved.name)}, not approved</button>` : ''}
      </div>
      <p class="card-note">This checks a purchase against your rules. A check is not a payment: nothing moves unless you approve it later.</p>
      ${askResultHtml()}
    </div>
  </div>`;
}

function askResultHtml() {
  const a = S.ask;
  if (!a) return '';
  if (a.kind === 'error') {
    return `<div class="verdict verdict-error">
      <div class="verdict-head"><span class="chip chip-deny">not checked</span></div>
      <div class="verdict-line">${esc(a.message)}</div>
    </div>`;
  }
  const d = a.decision ?? {};
  const cls = d.verdict === 'ALLOW' ? 'verdict-allow' : d.verdict === 'ASK_USER' ? 'verdict-ask' : 'verdict-deny';
  const sentence = verdictSentence(d.verdict, d.code, { limit: a.limit, left: a.left, store: a.store });
  let note;
  if (d.verdict === 'ALLOW') {
    note = 'This was a check against your rules. Nothing has been paid.';
  } else if (a.proposalId) {
    note = `It is now waiting for you, and nothing has been paid. <a href="#/waiting/${esc(a.proposalId)}">Decide it</a>.`;
  } else {
    note = 'Nothing has been paid.';
  }
  return `<div class="verdict ${cls}">
    <div class="verdict-head">
      <span class="chip ${verdictClass(d.verdict)}">${esc(verdictWord(d.verdict))}</span>
      <span class="mono">${esc(a.store)} · ${esc(units(a.amount))}</span>
    </div>
    <div class="verdict-line">${esc(sentence)}</div>
    <div class="verdict-note">${note}</div>
  </div>`;
}

function storesCardHtml(allowed) {
  const castRows = STORES.map((s) => {
    const ok = isApproved(s.id, allowed);
    return `<div class="store-row">
      <div>
        <div class="store-name">${esc(s.name)}</div>
        <div class="store-what">${esc(s.what)}</div>
      </div>
      <span class="chip ${ok ? 'chip-allow' : 'chip-quiet'}">${ok ? 'approved' : 'not approved'}</span>
    </div>`;
  }).join('');

  // Honest about approved stores outside the demo cast, if any exist.
  const extras = allowed.filter((a) => !storeFor(a)).map(() => `<div class="store-row">
      <div>
        <div class="store-name">Another store</div>
        <div class="store-what">On your approved list, outside the demo cast</div>
      </div>
      <span class="chip chip-allow">approved</span>
    </div>`).join('');

  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">who your assistant may pay</div>
        <div class="card-title">Approved stores</div>
      </div>
      <span class="chip chip-quiet tabular">${allowed.length} approved</span>
    </div>
    <div class="card-body">
      <div class="store-list">${castRows}${extras}</div>
      <p class="card-note">A store that is not on this list is refused automatically. When one asks, you can approve it from Waiting for you.</p>
    </div>
  </div>`;
}

function accessCardHtml(m) {
  const callsLeft = Math.max(0, Number(m.maxCalls) - Number(m.callsUsed));
  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">what your assistant holds</div>
        <div class="card-title">Assistant access</div>
      </div>
    </div>
    <div class="card-body">
      <div class="fact-list">
        <div class="fact">
          <span class="fact-k">Can make payments until</span>
          <span class="fact-v">${dayText(m.validUntil)} (${daysUntil(m.validUntil)})</span>
        </div>
        <div class="fact">
          <span class="fact-k">Actions it may take</span>
          <span class="fact-v">${units(callsLeft)} of ${units(m.maxCalls)} left</span>
        </div>
        <div class="fact">
          <span class="fact-k">What it may do</span>
          <span class="fact-v">Pay approved stores, inside the limits above</span>
        </div>
      </div>
      <p class="card-note">You can change or end this access at any time. A change takes one confirmation from you and is recorded permanently.</p>
    </div>
  </div>`;
}

function renderRules() {
  if (S.loadingMandate && !S.mandate) return skelHtml(2);
  if (!S.mandate) return errorCardHtml(S.mandateError);

  const m = S.mandate.mandate;
  const perCall = Number(m.maxPerCall);
  const perWindow = Number(m.maxPerWindow);
  const spent = Number(m.spentInWindow);
  const left = Math.max(0, perWindow - spent);
  const usedPct = pct(spent, perWindow);
  const resetAt = Number(m.windowStart) + Number(m.windowSeconds);
  const allowed = m.allowedRecipients ?? [];

  return `
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-label">your rules right now</div>
          <div class="card-title">Spending limits</div>
        </div>
        <span class="chip chip-quiet">live</span>
      </div>
      <div class="card-body">
        <div class="stats">
          <div class="stat">
            <div class="stat-label">Per-purchase limit</div>
            <div class="stat-value">${units(perCall)}</div>
            <div class="stat-note">Anything above this stops automatically</div>
          </div>
          <div class="stat">
            <div class="stat-label">This month's budget</div>
            <div class="stat-value">${units(perWindow)}</div>
            <div class="stat-note">Resets ${dayText(resetAt)} · ${daysUntil(resetAt)}</div>
          </div>
        </div>
        <div class="meter-block">
          <div class="meter-legend">
            <span>Spent so far this month</span>
            <span><b>${units(spent)}</b> of ${units(perWindow)} · ${units(left)} left</span>
          </div>
          <div class="meter"><div class="meter-fill${usedPct >= 100 ? ' is-full' : ''}" style="width:${usedPct}%"></div></div>
        </div>
      </div>
    </div>
    ${askCardHtml(m, left)}
    ${storesCardHtml(allowed)}
    ${accessCardHtml(m)}`;
}

// ------------------------------------------------------------------ requests screen

function renderRequests() {
  if (S.loadingProposals && !S.proposals) return skelHtml(2);
  if (!S.proposals) return errorCardHtml(S.proposalsError);

  const ps = [...S.proposals].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (!ps.length) {
    return `<div class="card"><div class="empty">No asks yet. When your assistant requests a purchase your rules do not clear on the spot, it shows up here.</div></div>`;
  }

  const rows = ps.map((p) => {
    const recipient = p.request?.context?.recipient;
    const name = storeName(recipient);
    const what = storeWhat(recipient);
    const sub = finalSubmissionFor(p.id);
    const outcome = [
      p.resolution ? resolutionWord(p.resolution) : null,
      sub ? submissionWord(sub) : null,
    ].filter(Boolean).join(' · ');
    return `<div class="req">
      <div class="req-main">
        <div class="req-name">${esc(name)}${what ? ` <span class="req-what">${esc(what)}</span>` : ''}</div>
        <div class="req-when">asked ${dayText((p.createdAt ?? 0) / 1000)} · ${esc(agoText(p.createdAt))}</div>
      </div>
      <div class="req-mid">
        <div class="req-amount">${esc(units(p.request?.context?.amount))}</div>
        <div class="req-rule">${esc(rulePhrase(p.blockedBecause?.code))}</div>
      </div>
      <div class="req-side">
        <span class="chip ${statusClass(p.status)}">${esc(statusWord(p.status))}</span>
        ${outcome ? `<div class="req-outcome">${esc(outcome)}</div>` : ''}
        ${p.status === 'PENDING' ? `<a class="req-link" href="#/waiting/${esc(p.id)}">Decide</a>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">every ask, newest first</div>
        <div class="card-title">All requests</div>
      </div>
      <span class="chip chip-quiet tabular">${ps.length}</span>
    </div>
    <div>${rows}</div>
  </div>`;
}

// ------------------------------------------------------------------ waiting screen

const EXECUTABLE = ['APPROVED_ONCE', 'AMENDED'];

/** The defaults for the amendment subform, ported from the tested console
 *  (its initForm): every suggestion is computed from the LIVE numbers. */
function initDecisionForm(p) {
  const m = S.mandate?.mandate;
  const c = p.request?.context ?? {};
  const allowed = m?.allowedRecipients ?? [];
  const recipientAllowed = isApproved(c.recipient, allowed);
  let kind = p.blockedBecause?.code === 'recipient-not-allowed' && !recipientAllowed
    ? 'allow-recipient' : 'raise-per-call-cap';
  let cap = '10';
  let winCap = '100';
  if (m) {
    const current = BigInt(m.maxPerCall);
    const windowCap = BigInt(m.maxPerWindow);
    let suggested = current + 10n;
    let winSuggested = windowCap + 50n;
    let amount = null;
    try {
      amount = BigInt(c.amount);
      if (amount > current) suggested = amount;
      if (amount > winSuggested) winSuggested = amount;
    } catch { /* not every ask carries a number; the default suggestion stands */ }
    if (suggested > windowCap) suggested = windowCap;
    // The dead corner (OBS-35): when the ask does not fit under this month's
    // budget, raising the per-purchase limit has no valid value at all - the
    // budget raise is the change that unblocks it, and the limit raise becomes
    // decidable afterwards as a separate decision.
    if (amount !== null && amount > windowCap) kind = 'raise-window-cap';
    cap = suggested.toString();
    winCap = winSuggested.toString();
  }
  if (m && BigInt(m.maxPerCall) >= BigInt(m.maxPerWindow) && kind === 'raise-per-call-cap') {
    kind = 'raise-window-cap';
  }
  if (kind === 'allow-recipient' && recipientAllowed) kind = 'raise-window-cap';
  return { kind, cap, windowCap: winCap, recipient: c.recipient ?? null };
}

/** Re-derive the form defaults once the live rules arrive, until the user
 *  has touched the form - after that their numbers are the truth. */
function maybeInitDecisionForm() {
  const w = S.waiting;
  if (S.route !== 'waiting' || !w.id || w.formTouched) return;
  const p = proposalById(w.id);
  if (p && p.status === 'PENDING' && S.mandate?.mandate) w.form = initDecisionForm(p);
}

/** Which rule changes are actually on offer for this ask. An option that the
 *  live rules make impossible (or pointless) is not offered at all. */
function amendKindsFor(p, m) {
  const out = [];
  const recipient = p.request?.context?.recipient;
  if (recipient && !isApproved(recipient, m.allowedRecipients ?? [])) {
    out.push({
      value: 'allow-recipient',
      label: `Add ${storeName(recipient)} to your approved list`,
      needsValue: false,
      note: 'This is permanent until you remove it. It is not a one-time exception.',
    });
  }
  const perCall = BigInt(m.maxPerCall);
  const windowCap = BigInt(m.maxPerWindow);
  if (perCall < windowCap) {
    out.push({
      value: 'raise-per-call-cap',
      label: 'Raise your per-purchase limit',
      needsValue: true,
      field: 'cap',
      valueLabel: 'New per-purchase limit',
      note: `Now ${units(m.maxPerCall)}. It must be more than ${units(m.maxPerCall)} ` +
        `and no more than ${units(m.maxPerWindow)}.`,
    });
  }
  out.push({
    value: 'raise-window-cap',
    label: "Raise this month's budget",
    needsValue: true,
    field: 'windowCap',
    valueLabel: 'New monthly budget',
    note: `Now ${units(m.maxPerWindow)}. Your per-purchase limit stays ${units(m.maxPerCall)}; ` +
      'raising it is a separate decision.',
  });
  return out;
}

function waitRowHtml(p, actionHtml) {
  const recipient = p.request?.context?.recipient;
  const what = storeWhat(recipient);
  return `<div class="req">
    <div class="req-main">
      <div class="req-name">${esc(storeName(recipient))}${what ? ` <span class="req-what">${esc(what)}</span>` : ''}</div>
      <div class="req-when">asked ${dayText((p.createdAt ?? 0) / 1000)} · ${esc(agoText(p.createdAt))}</div>
    </div>
    <div class="req-mid">
      <div class="req-amount">${esc(units(p.request?.context?.amount))}</div>
      <div class="req-rule">${esc(rulePhrase(p.blockedBecause?.code))}</div>
    </div>
    <div class="req-side">${actionHtml}</div>
  </div>`;
}

function justDecidedHtml(d) {
  const p = proposalById(d.proposalId);
  const who = p
    ? `${storeName(p.request?.context?.recipient)} · ${units(p.request?.context?.amount)}`
    : 'Your last decision';
  const chip = d.kind === 'decline'
    ? '<span class="chip chip-quiet">you said no</span>'
    : '<span class="chip chip-allow">recorded</span>';
  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">just decided</div>
        <div class="card-title">${esc(who)}</div>
      </div>
      ${chip}
    </div>
    <div class="card-body">
      <p>${esc(DONE_TEXT[d.kind] ?? DONE_TEXT.amend)}</p>
      <p class="decision-actions"><button class="btn" type="button" data-action="receipt">Show the receipt</button></p>
    </div>
  </div>`;
}

/** A recorded change the live rules have already overtaken. Landing it now
 *  would move the rules BACKWARDS (an old raise to 20 when the live limit is
 *  150), so it is never offered as "finish it". Returns the plain reason, or
 *  null when the change is still meaningful to land - or when the live rules
 *  are not read yet, because unproven means treated as finishable, exactly
 *  like before. One-off payments are never superseded: they are money, not
 *  rules, and a recorded approval stays finishable until it lands. */
function supersededReason(p) {
  const m = S.mandate?.mandate;
  if (!m || p.status !== 'AMENDED') return null;
  const a = p.resolution?.amendment;
  if (!a) return null;
  const c = p.request?.context ?? {};
  try {
    if (a.kind === 'raise-per-call-cap' && BigInt(m.maxPerCall) >= BigInt(a.maxPerCall)) {
      return `Your per-purchase limit is already ${units(m.maxPerCall)}, at or past the ${units(a.maxPerCall)} this decision asked for.`;
    }
    if (a.kind === 'raise-window-cap' && BigInt(m.maxPerWindow) >= BigInt(a.maxPerWindow)) {
      return `This month's budget is already ${units(m.maxPerWindow)}, at or past the ${units(a.maxPerWindow)} this decision asked for.`;
    }
    if (a.kind === 'allow-recipient' && isApproved(a.recipient ?? c.recipient, m.allowedRecipients ?? [])) {
      return `${storeName(a.recipient ?? c.recipient)} is already an approved store.`;
    }
  } catch { /* a malformed target is not provably superseded; the old path stands */ }
  return null;
}

function renderWaiting() {
  const w = S.waiting;
  if (w.id) return renderDecision();
  if (S.loadingProposals && !S.proposals) return skelHtml(2);
  if (!S.proposals) return errorCardHtml(S.proposalsError);

  const byNewest = (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0);
  const pending = S.proposals.filter((p) => p.status === 'PENDING').sort(byNewest);
  const inflightAll = S.proposals
    .filter((p) => EXECUTABLE.includes(p.status) && !finalSubmissionFor(p.id));
  const superseded = inflightAll.filter((p) => supersededReason(p)).sort(byNewest);
  const inflight = inflightAll.filter((p) => !supersededReason(p)).sort(byNewest);
  const doneCard = w.done ? justDecidedHtml(w.done) : '';

  if (!pending.length && !inflight.length && !superseded.length) {
    return `${doneCard}<div class="card"><div class="empty">Nothing is waiting on you. When your assistant asks for something your rules do not clear on the spot, it shows up here, and nothing moves until you decide.</div></div>`;
  }

  const inflightCard = inflight.length ? `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">decided, not landed yet</div>
        <div class="card-title">Finish these</div>
      </div>
      <span class="chip chip-quiet tabular">${inflight.length}</span>
    </div>
    <div>${inflight.map((p) => waitRowHtml(p,
    `<a class="btn btn-sm" href="#/waiting/${esc(p.id)}">Finish it</a>`)).join('')}</div>
    <div class="card-body"><p class="card-note note-flat">Your decision is recorded, but the change itself has not landed on your account yet. Until it lands, your rules read exactly as before.</p></div>
  </div>` : '';

  // Recorded decisions the live rules have overtaken. Kept on screen - evidence
  // is never removed - but with no way to land them, because landing an old
  // change would tighten today's rules. The full record lives in Activity.
  const supersededCard = superseded.length ? `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">nothing left to land</div>
        <div class="card-title">Already covered by your rules</div>
      </div>
      <span class="chip chip-quiet tabular">${superseded.length}</span>
    </div>
    <div>${superseded.map((p) => waitRowHtml(p,
    '<span class="req-outcome">already covered</span>')).join('')}</div>
    <div class="card-body"><p class="card-note note-flat">Each of these recorded decisions asked for less than your rules give you today, so landing one now would move your rules backwards. There is nothing to finish, and each one stays in <a href="#/activity">Activity</a> forever.</p></div>
  </div>` : '';

  const pendingCard = pending.length ? `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">nothing moves until you decide</div>
        <div class="card-title">Waiting on you</div>
      </div>
      <span class="chip chip-quiet tabular">${pending.length}</span>
    </div>
    <div>${pending.map((p) => waitRowHtml(p,
    `<a class="btn btn-sm" href="#/waiting/${esc(p.id)}">Decide</a>`)).join('')}</div>
  </div>` : '';

  return `${doneCard}${inflightCard}${pendingCard}${supersededCard}`;
}

// ------------------------------------------------------------------ decision view

function askFactsCardHtml(p) {
  const c = p.request?.context ?? {};
  const m = S.mandate?.mandate;
  const left = m ? Math.max(0, Number(m.maxPerWindow) - Number(m.spentInWindow)) : undefined;
  const sentence = verdictSentence('DENY', p.blockedBecause?.code, {
    limit: m ? Number(m.maxPerCall) : undefined,
    left,
    store: storeName(c.recipient),
  });
  const what = storeWhat(c.recipient);
  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">waiting on you</div>
        <div class="card-title">${esc(storeName(c.recipient))} wants ${esc(units(c.amount))}</div>
      </div>
      <span class="chip chip-ask">waiting on you</span>
    </div>
    <div class="card-body">
      <div class="fact-list">
        <div class="fact"><span class="fact-k">Store</span><span class="fact-v">${esc(storeName(c.recipient))}${what ? ` · ${esc(what)}` : ''}</span></div>
        <div class="fact"><span class="fact-k">Amount</span><span class="fact-v">${esc(units(c.amount))}</span></div>
        <div class="fact"><span class="fact-k">Asked</span><span class="fact-v">${dayText((p.createdAt ?? 0) / 1000)} (${esc(agoText(p.createdAt))})</span></div>
      </div>
      <div class="verdict verdict-deny">
        <div class="verdict-head"><span class="chip chip-deny">blocked</span></div>
        <div class="verdict-line">${esc(sentence)}</div>
        <div class="verdict-note">Nothing has been paid. It waits here until you decide, and your rules keep holding in the meantime.</div>
      </div>
    </div>
  </div>`;
}

function choiceHtml(value, title, desc) {
  const on = S.waiting.choice === value;
  return `<label class="choice${on ? ' is-on' : ''}">
    <input type="radio" name="decision" value="${value}"${on ? ' checked' : ''}>
    <span class="choice-mark" aria-hidden="true"></span>
    <span class="choice-text">
      <span class="choice-title">${esc(title)}</span>
      <span class="choice-desc">${esc(desc)}</span>
    </span>
  </label>`;
}

function amendSubformHtml(p, m) {
  const w = S.waiting;
  const kinds = amendKindsFor(p, m);
  if (!kinds.length) return '';
  if (!kinds.some((k) => k.value === w.form?.kind)) w.form.kind = kinds[0].value;
  const kind = kinds.find((k) => k.value === w.form.kind);
  const options = kinds.map((k) =>
    `<option value="${k.value}"${k.value === kind.value ? ' selected' : ''}>${esc(k.label)}</option>`).join('');
  const value = kind.field === 'cap' ? w.form.cap : w.form.windowCap;
  const raises = kind.value !== 'allow-recipient';
  const deadCorner = p.blockedBecause?.code === 'over-per-call-cap'
    && !kinds.some((k) => k.value === 'raise-per-call-cap')
    ? `<p class="field-note">Your per-purchase limit already equals this month's budget, so the budget is what needs raising first. The limit becomes raisable afterwards, as its own decision.</p>` : '';
  return `<div class="subform">
    <div class="subform-grid">
      <label class="field">
        <span class="field-label">The change</span>
        <select class="control" id="amend-kind">${options}</select>
      </label>
      ${kind.needsValue ? `<label class="field">
        <span class="field-label">${esc(kind.valueLabel ?? 'New value')}</span>
        <input class="control" id="amend-value" type="number" min="1" step="1" inputmode="numeric" value="${esc(value)}">
      </label>` : ''}
    </div>
    <p class="field-note">${esc(kind.note)}</p>
    ${deadCorner}
    ${raises ? `<div class="warn-note">Making this change restarts this month's spending count: what has been spent goes back to zero.</div>` : ''}
  </div>`;
}

function decisionCardHtml(p, m) {
  const w = S.waiting;
  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">owner only</div>
        <div class="card-title">Your decision</div>
      </div>
    </div>
    <div class="card-body">
      <div class="choices">
        ${choiceHtml('once', 'Approve this purchase once', 'You make this exact payment yourself. Your assistant gains no new power.')}
        ${choiceHtml('amend', 'Change the rules', 'Raise a limit or approve the store permanently. Future asks are answered by the new rules.')}
        ${choiceHtml('decline', 'Say no', 'It stays refused. Nothing is paid, and your no is recorded.')}
      </div>
      ${w.choice === 'amend' && w.form ? amendSubformHtml(p, m) : ''}
      ${w.error ? `<div class="modal-error form-error">${esc(w.error)}</div>` : ''}
      <div class="decision-actions">
        <button class="btn btn-primary" type="button" data-action="review"${w.building ? ' disabled' : ''}>${w.building ? 'Checking…' : 'Review and confirm'}</button>
        <a class="btn btn-quiet" href="#/waiting">Back to the list</a>
      </div>
      <p class="card-note">Nothing moves until you confirm in the window that opens over this page. Every decision is recorded permanently.</p>
    </div>
  </div>`;
}

function settledHtml(p, sub) {
  const w = S.waiting;
  const c = p.request?.context ?? {};
  const outcome = [
    p.resolution ? resolutionWord(p.resolution) : null,
    sub ? submissionWord(sub) : null,
  ].filter(Boolean).join(' · ');
  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">${esc(storeName(c.recipient))} · ${esc(units(c.amount))}</div>
        <div class="card-title">${esc(statusSentence(p.status))}</div>
      </div>
      <span class="chip ${statusClass(p.status)}">${esc(statusWord(p.status))}</span>
    </div>
    <div class="card-body">
      ${outcome ? `<p>${esc(outcome)}</p>` : ''}
      ${sub && sub.status === 'PENDING' ? '<p class="card-note">The record is still waiting for the network to confirm it.</p>' : ''}
      ${w.done?.proposalId === p.id ? '<p class="decision-actions"><button class="btn" type="button" data-action="receipt">Show the receipt</button></p>' : ''}
      <p class="card-note"><a href="#/waiting">Back to the list</a></p>
    </div>
  </div>`;
}

function resumeHtml(p) {
  const c = p.request?.context ?? {};
  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">decided, not landed yet</div>
        <div class="card-title">${esc(storeName(c.recipient))} · ${esc(units(c.amount))}</div>
      </div>
      <span class="chip ${statusClass(p.status)}">${esc(statusWord(p.status))}</span>
    </div>
    <div class="card-body">
      <p>${esc(statusSentence(p.status))} The change itself has not landed on your account yet: until it does, your rules read exactly as before.</p>
      <p class="decision-actions">
        <button class="btn btn-primary" type="button" data-action="finish">Finish it now</button>
        <a class="btn btn-quiet" href="#/waiting">Back to the list</a>
      </p>
      <p class="card-note">Finishing asks for the same confirmations as before. Your decision is not recorded a second time.</p>
    </div>
  </div>`;
}

/** The deep-link view for a recorded decision the live rules have overtaken:
 *  the honest sentence instead of a land button (landing would tighten today's
 *  rules). The record itself stays in Activity forever. */
function supersededHtml(p, reason) {
  const c = p.request?.context ?? {};
  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">nothing left to land</div>
        <div class="card-title">${esc(storeName(c.recipient))} · ${esc(units(c.amount))}</div>
      </div>
      <span class="chip ${statusClass(p.status)}">${esc(statusWord(p.status))}</span>
    </div>
    <div class="card-body">
      <p>${esc(reason)} Landing this recorded decision now would move your rules backwards, so there is nothing to finish.</p>
      <p class="decision-actions"><a class="btn btn-quiet" href="#/waiting">Back to the list</a></p>
      <p class="card-note">The decision stays recorded forever - you can open its record from <a href="#/activity">Activity</a>.</p>
    </div>
  </div>`;
}

function renderDecision() {
  const w = S.waiting;
  const p = proposalById(w.id);
  if (!p) {
    if (S.loadingProposals && !S.proposals) return skelHtml(1);
    return `<div class="card"><div class="card-body">
      <p>That request is not here.</p>
      <p class="card-note"><a href="#/waiting">Back to the list</a></p>
    </div></div>`;
  }
  const sub = finalSubmissionFor(p.id);
  if (p.status === 'DECLINED' || sub) return settledHtml(p, sub);
  if (EXECUTABLE.includes(p.status)) {
    const reason = supersededReason(p);
    return reason ? supersededHtml(p, reason) : resumeHtml(p);
  }

  const m = S.mandate?.mandate;
  const ask = askFactsCardHtml(p);
  if (!m || !w.form) {
    return `${ask}<div class="card"><div class="card-body">
      <p class="modal-busy"><span class="spinner" aria-hidden="true"></span><span>Reading your live rules, so your decision is built from them…</span></p>
    </div></div>`;
  }
  return ask + decisionCardHtml(p, m);
}

// ------------------------------------------------------------------ activity screen

// The permanent record, rendered newest first. It is built from what the server
// keeps forever: every submission (an action that landed on the account) joined
// to the decision that produced it, plus every recorded decision that produced
// no submission (a refusal, or an early change). Nothing pending appears here -
// that is Waiting's job - and nothing is ever dropped, so the ledger and the
// record can never disagree. `activityCache` is the exact list on screen, so a
// receipt button's index always resolves to the row the user clicked.
let activityCache = [];

function activityEntries() {
  const proposals = S.proposals ?? [];
  const submissions = S.submissions ?? [];
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const entries = [];
  const covered = new Set();
  for (const s of submissions) {
    const p = byId.get(s.proposalId) ?? null;
    if (p) covered.add(p.id);
    entries.push({ proposal: p, submission: s, ts: s.submittedAt ?? 0 });
  }
  for (const p of proposals) {
    if (covered.has(p.id) || p.status === 'PENDING') continue;
    entries.push({ proposal: p, submission: null, ts: p.resolvedAt ?? p.createdAt ?? 0 });
  }
  entries.sort((a, b) => b.ts - a.ts);
  return entries;
}

/** The plain words for one ledger line. No machine field is ever rendered here;
 *  the receipt drawer (decide.js, fenced) is the only place those appear. */
function activityLine(e) {
  const p = e.proposal;
  const s = e.submission;
  const res = p?.resolution ?? null;
  const kind = res?.amendment?.kind ?? res?.type ?? null;
  const ctx = p?.request?.context ?? {};
  const store = storeName(ctx.recipient);
  const amt = ctx.amount === null || ctx.amount === undefined || ctx.amount === ''
    ? '' : ` · ${units(ctx.amount)}`;

  let title;
  if (kind === 'raise-per-call-cap') title = `You raised your per-purchase limit to ${units(res.amendment.maxPerCall)}`;
  else if (kind === 'raise-window-cap') title = `You raised this month's budget to ${units(res.amendment.maxPerWindow)}`;
  else if (kind === 'allow-recipient') title = `You approved ${store} as a store`;
  else if (kind === 'execute-once') title = `You approved a payment to ${store}${amt}`;
  else if (res?.type === 'decline') title = ctx.recipient ? `You said no to ${store}${amt}` : 'You said no to a request';
  else if (s) title = 'A change you confirmed landed on your account';
  else title = 'A decision you recorded';

  let chipClass; let chipWord; let sub;
  if (s && s.status === 'SUCCEEDED') { chipClass = 'chip-allow'; chipWord = 'Live'; sub = 'Confirmed by you · recorded permanently'; }
  else if (s && s.status === 'PENDING') { chipClass = 'chip-ask'; chipWord = 'In progress'; sub = 'Still being confirmed'; }
  else if (s && s.status === 'REVERTED') { chipClass = 'chip-deny'; chipWord = 'Did not go through'; sub = 'It did not go through · nothing changed'; }
  else if (res?.type === 'decline') { chipClass = 'chip-quiet'; chipWord = 'recorded'; sub = 'Recorded permanently · nothing was paid'; }
  else { chipClass = 'chip-quiet'; chipWord = 'recorded'; sub = 'Recorded permanently'; }

  return { title, sub, chipClass, chipWord };
}

function renderActivity() {
  if (S.loadingProposals && !S.proposals) return skelHtml(2);
  if (!S.proposals) return errorCardHtml(S.proposalsError);

  activityCache = activityEntries();
  if (!activityCache.length) {
    return `<div class="card"><div class="empty">Nothing has happened yet. When you change a rule or make a payment, it is written down here forever, with a receipt you can open.</div></div>`;
  }

  const rows = activityCache.map((e, i) => {
    const line = activityLine(e);
    return `<div class="req">
      <div class="req-main">
        <div class="req-name">${esc(line.title)}</div>
        <div class="req-when">${dayText(e.ts / 1000)} · ${esc(agoText(e.ts))}</div>
      </div>
      <div class="req-mid">
        <div class="req-rule">${esc(line.sub)}</div>
      </div>
      <div class="req-side">
        <span class="chip ${line.chipClass}">${esc(line.chipWord)}</span>
        <button class="btn btn-sm" type="button" data-action="record-receipt" data-key="${i}">Show the receipt</button>
      </div>
    </div>`;
  }).join('');

  return `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">kept forever, newest first</div>
        <div class="card-title">Every change and payment</div>
      </div>
      <span class="chip chip-quiet tabular">${activityCache.length}</span>
    </div>
    <div>${rows}</div>
    <div class="card-body"><p class="card-note note-flat">Nothing here can be edited or deleted, and every line keeps its receipt. A line marked Live landed on your account: open its receipt to read the network's own answer.</p></div>
  </div>`;
}

/** Open the receipt for one ledger line. The persisted record renders at once;
 *  if the line landed, the network's own answer is read once and appended. */
async function openRecordReceipt(index) {
  const entry = activityCache[Number(index)];
  if (!entry) return;
  els.drawerTitle.textContent = 'The receipt';
  const draw = (receipt) => {
    els.drawerBody.innerHTML = recordReceiptMachineHtml({
      proposal: entry.proposal, submission: entry.submission, receipt,
    }) || '<p>Nothing was recorded for this decision.</p>';
  };
  draw(null);
  els.drawer.hidden = false;
  els.backdrop.hidden = false;
  if (entry.submission) {
    const receipt = await liveReceipt(entry.submission);
    // Only repaint if this receipt is still the one open (the user may have
    // closed it or opened another while the read was in flight).
    if (!els.drawer.hidden && activityCache[Number(index)] === entry) draw(receipt);
  }
}

// ------------------------------------------------------------------ how screen

const TICK_YES = '<svg class="tick tick-yes" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.4"></circle><path d="M6 10.5l2.6 2.6L14 7.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
const TICK_NO = '<svg class="tick tick-no" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.4"></circle><path d="M7 7l6 6M13 7l-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>';

function tickList(items, tick) {
  return `<ul class="tick-list">${items.map((t) => `<li>${tick}<span>${t}</span></li>`).join('')}</ul>`;
}

function renderHow() {
  return `
  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">the short version</div>
        <div class="card-title">Three moves</div>
      </div>
    </div>
    <div class="card-body">
      <div class="steps">
        <div class="step"><span class="step-n"></span><div>
          <div class="step-t">You set the rules</div>
          <div class="step-d">A limit per purchase, a budget for the month, and which stores your assistant may pay. Only you can change any of it.</div>
        </div></div>
        <div class="step"><span class="step-n"></span><div>
          <div class="step-t">Your assistant asks</div>
          <div class="step-d">Every purchase it wants to make is checked against your rules before anything happens.</div>
        </div></div>
        <div class="step"><span class="step-n"></span><div>
          <div class="step-t">The rules answer</div>
          <div class="step-d">It goes ahead inside your rules, it stops automatically, or it waits for you. When it waits, only your decision moves it.</div>
        </div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">yours alone</div>
        <div class="card-title">What only you can do</div>
      </div>
    </div>
    <div class="card-body">
      ${tickList([
        'Approve a waiting purchase, once.',
        'Change a limit, or approve a new store.',
        'Say no, and it stays refused.',
        'End your assistant\'s access at any time.',
      ], TICK_YES)}
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">enforced, not promised</div>
        <div class="card-title">What your assistant can never do</div>
      </div>
    </div>
    <div class="card-body">
      ${tickList([
        'Spend over your per-purchase limit.',
        'Spend outside this month\'s budget.',
        'Pay a store you have not approved.',
        'Keep working after its access ends.',
      ], TICK_NO)}
      <p class="card-note">These are not good intentions. They are enforced by your rules themselves, so a purchase that breaks one simply does not happen.</p>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <div>
        <div class="card-label">honest numbers</div>
        <div class="card-title">Where everything on these screens comes from</div>
      </div>
    </div>
    <div class="card-body">
      <p>Every limit, total, and store list here is read from your live account at the moment you look, and shown to you as it is. When you change a rule, the change takes one confirmation from you and is recorded permanently, with a receipt kept in Activity.</p>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ render

function restoreAskForm() {
  if (S.route !== 'rules' || !S.askForm) return;
  const sel = $('ask-store');
  const inp = $('ask-amount');
  if (sel && S.askForm.store) sel.value = S.askForm.store;
  if (inp && S.askForm.amount) inp.value = S.askForm.amount;
}

function render() {
  const byRoute = {
    rules: renderRules,
    requests: renderRequests,
    waiting: renderWaiting,
    activity: renderActivity,
    how: renderHow,
  };
  els.screen.innerHTML = (byRoute[S.route] ?? renderRules)();
  restoreAskForm();
}

// ------------------------------------------------------------------ ask

async function onAsk(form) {
  const storeSel = form.querySelector('#ask-store');
  const amountEl = form.querySelector('#ask-amount');
  const go = form.querySelector('#ask-go');
  const who = storeSel?.value ?? '';
  const raw = String(amountEl?.value ?? '').trim();

  S.askForm = { store: who, amount: raw };

  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    S.ask = { kind: 'error', message: 'Enter a whole number of units, more than zero.' };
    render();
    return;
  }

  S.asking = true;
  if (go) {
    go.disabled = true;
    go.textContent = 'Checking…';
  }
  try {
    const j = await fileAsk(who, raw);
    const m = S.mandate?.mandate;
    S.ask = {
      kind: 'ok',
      store: storeName(who),
      amount: raw,
      decision: j?.decision ?? null,
      proposalId: j?.proposal?.id ?? null,
      limit: m ? Number(m.maxPerCall) : undefined,
      left: m ? Math.max(0, Number(m.maxPerWindow) - Number(m.spentInWindow)) : undefined,
    };
    if (j?.proposal) loadProposals(true);
  } catch (e) {
    S.ask = { kind: 'error', message: plainError(e.message) };
  } finally {
    S.asking = false;
    render();
  }
}

// ------------------------------------------------------------------ the popup

// The confirmation popup: the one place a decision becomes real. Its plain
// copy lives here; every machine detail it shows is rendered by decide.js
// (the app's only crypto surface) into the dark strips.

const STAGE_STEPS = [
  { key: 'connect', label: "Confirm it's you" },
  { key: 'record', label: 'Record your decision' },
  { key: 'prepare', label: 'Prepare the change' },
  { key: 'authorize', label: 'Confirm the change' },
  { key: 'send', label: 'Send it' },
  { key: 'confirm', label: 'Wait for it to land' },
];

const ACTIVE_STAGES = ['connect', 'record', 'prepare', 'authorize', 'send', 'confirm'];

// The machine's own step names, mapped to the steps above.
const FLOW_MAP = { authorize: 'authorize', wire: 'send', send: 'send', record: 'confirm' };

const STAGE_TEXT = {
  connect: 'Your account app is opening. Allow the connection there.',
  record: 'Confirm your decision in the window that just opened. It confirms exactly what you reviewed, and nothing else.',
  prepare: 'Preparing the exact change. Nothing to do here.',
  authorize: 'Confirm the change in the window that just opened.',
  send: 'Sending it from your own account. Approve the send there.',
  confirm: 'Sent. Waiting for your account to update. This can take a minute.',
};

const MODAL_TITLES = {
  review: 'One last look',
  connect: "Confirm it's you",
  record: 'Record your decision',
  prepare: 'Preparing the change',
  authorize: 'Confirm the change',
  send: 'Sending it',
  confirm: 'Almost there',
  stalled: 'Sent, not confirmed yet',
  done: 'Done',
  failed: 'It did not go through',
};

const DONE_TEXT = {
  decline: 'You said no. It stays refused, and your no is recorded.',
  once: 'Done. The payment went through, sent by you, and it is recorded permanently.',
  amend: 'Done. Your rules changed, and the change is recorded permanently.',
};

function activeStage(md) {
  return !!md && ACTIVE_STAGES.includes(md.stage);
}

function setStage(key, extra = {}) {
  S.waiting.modal = { stage: key, ...extra };
  renderModal();
}

function openModal(stage) {
  S.waiting.modal = { stage };
  renderModal();
  const btn = els.modalBody.querySelector('.btn-primary');
  if (btn) btn.focus();
}

/**
 * Closing is refused while a step is in flight: a popup owns the moment, and
 * walking away mid-send is exactly the ambiguity this product refuses to have.
 * Everything is recoverable by design - a decision that got recorded but not
 * landed shows up as "Finish these", and the server never accepts a second
 * landing for the same one.
 */
function closeModal() {
  const w = S.waiting;
  if (w.running && activeStage(w.modal)) return;
  w.modal = null;
  els.modal.hidden = true;
  els.modalBackdrop.hidden = true;
}

function finishModal() {
  closeModal();
  location.hash = '#/waiting';
}

function flowSteps() {
  const w = S.waiting;
  if ((w.choice === 'decline' || w.doneKind === 'decline') && !w.flowResumed) {
    return STAGE_STEPS.slice(0, 2);
  }
  return STAGE_STEPS;
}

function stageListHtml(md) {
  const w = S.waiting;
  const steps = flowSteps();
  const atKey = md.stage === 'failed' ? md.failedAt : md.stage === 'stalled' ? 'confirm' : md.stage;
  let curIdx = steps.findIndex((s) => s.key === atKey);
  if (md.stage === 'done') curIdx = steps.length;
  return `<div class="stage-list">${steps.map((s, i) => {
    let cls = '';
    if (md.stage === 'failed' && i === curIdx) cls = ' is-bad';
    else if (i < curIdx || (w.flowResumed && s.key === 'record')) cls = ' is-done';
    else if (i === curIdx) cls = ' is-now';
    return `<div class="stage${cls}"><span class="stage-dot" aria-hidden="true"></span><span>${esc(s.label)}</span></div>`;
  }).join('')}</div>`;
}

function factRow(k, v) {
  return `<div class="fact"><span class="fact-k">${esc(k)}</span><span class="fact-v">${esc(v)}</span></div>`;
}

function decisionSummaryText(p) {
  const w = S.waiting;
  const m = S.mandate?.mandate;
  const c = p?.request?.context ?? {};
  if (w.choice === 'once') return `Approve once: ${units(c.amount)} to ${storeName(c.recipient)}, paid by you.`;
  if (w.choice === 'decline') return 'Say no. It stays refused.';
  const kind = w.form?.kind;
  if (kind === 'raise-per-call-cap') return `Raise your per-purchase limit from ${units(m?.maxPerCall)} to ${units(w.form?.cap)}.`;
  if (kind === 'raise-window-cap') return `Raise this month's budget from ${units(m?.maxPerWindow)} to ${units(w.form?.windowCap)}.`;
  return `Add ${storeName(w.form?.recipient)} to your approved list, permanently.`;
}

function modalActionsHtml(md) {
  const w = S.waiting;
  const btns = [];
  if (md.stage === 'review') {
    btns.push('<button class="btn btn-quiet" type="button" data-action="m-back">Back</button>');
    btns.push('<button class="btn btn-primary" type="button" data-action="m-continue">Continue</button>');
  } else if (md.stage === 'done') {
    btns.push('<button class="btn" type="button" data-action="m-receipt">Show the receipt</button>');
    btns.push('<button class="btn btn-primary" type="button" data-action="m-finish">Done</button>');
  } else if (md.stage === 'stalled') {
    btns.push('<button class="btn btn-primary" type="button" data-action="m-keep-looking">Keep looking</button>');
    if (w.txHash) btns.push('<button class="btn" type="button" data-action="m-receipt">Show the receipt</button>');
    btns.push('<button class="btn btn-quiet" type="button" data-action="m-close">Close</button>');
  } else if (md.stage === 'failed') {
    btns.push('<button class="btn btn-primary" type="button" data-action="m-retry">Try again</button>');
    if (w.txHash) btns.push('<button class="btn" type="button" data-action="m-receipt">Show the receipt</button>');
    btns.push('<button class="btn btn-quiet" type="button" data-action="m-close">Close</button>');
  }
  // Active stages deliberately render no actions: the popups own the moment.
  return btns.length ? `<div class="modal-actions">${btns.join('')}</div>` : '';
}

function reviewBodyHtml(p) {
  const w = S.waiting;
  const c = p?.request?.context ?? {};
  const sidePlain = sideEffectsPlain(w.preview?.sideEffects ?? []);
  return `
    <div class="fact-list">
      ${factRow('The ask', `${storeName(c.recipient)} · ${units(c.amount)}`)}
      ${factRow('Your decision', decisionSummaryText(p))}
    </div>
    ${sidePlain.length ? `<div class="warn-note">${sidePlain.map((s) => esc(s)).join('<br>')}</div>` : ''}
    <div class="modal-text">The confirmation happens in your account app, in a window that opens over this page. What you confirm there is exactly what is written here, and nothing else.</div>
    ${reviewMachineHtml(w.preview)}
    ${w.signer && w.walletInfo ? walletMachineHtml(w.walletInfo) : walletPickerHtml(w.walletApps, w.walletId)}
    ${modalActionsHtml({ stage: 'review' })}`;
}

function progressBodyHtml(md) {
  const w = S.waiting;
  const parts = [stageListHtml(md)];
  if (ACTIVE_STAGES.includes(md.stage)) {
    let text = STAGE_TEXT[md.stage] ?? '';
    if (md.stage === 'confirm' && md.tries) text += ` (check ${md.tries})`;
    parts.push(`<div class="modal-busy"><span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span></div>`);
  }
  if (md.stage === 'stalled') {
    parts.push('<div class="modal-text">It was sent, but your account had not confirmed it within two minutes. The record says so honestly. Keep looking, or close this: it is never sent a second time.</div>');
  }
  if (md.stage === 'done') {
    parts.push(`<div class="modal-text">${esc(DONE_TEXT[w.doneKind] ?? DONE_TEXT.amend)}</div>`);
  }
  if (md.stage === 'failed') {
    parts.push(`<div class="modal-error">${esc(md.error ?? 'That did not work. Nothing was changed.')}</div>`);
  }
  if (ACTIVE_STAGES.includes(md.stage) || md.stage === 'stalled') {
    parts.push(stageMachineHtml(md.stage === 'stalled' ? 'confirm' : md.stage, {
      walletInfo: w.walletInfo,
      plan: w.plan,
      isController: w.plan ? controllerIs(w.signer, w.plan) : undefined,
      txHash: w.txHash,
      tries: md.tries,
    }));
  }
  if (md.stage === 'failed') parts.push(errorMachineHtml(md.machineError));
  parts.push(modalActionsHtml(md));
  return parts.join('');
}

function renderModal() {
  const w = S.waiting;
  const md = w.modal;
  if (!md) {
    els.modal.hidden = true;
    els.modalBackdrop.hidden = true;
    return;
  }
  els.modal.hidden = false;
  els.modalBackdrop.hidden = false;
  els.modalClose.hidden = activeStage(md);
  els.modalTitle.textContent = MODAL_TITLES[md.stage] ?? 'Your decision';
  els.modalBody.innerHTML = md.stage === 'review'
    ? reviewBodyHtml(proposalById(w.id))
    : progressBodyHtml(md);
}

// ------------------------------------------------------------------ the decision flow

function currentChoiceResolution() {
  const w = S.waiting;
  const m = S.mandate?.mandate;
  const resolution = resolutionFromChoice({ choice: w.choice, form: w.form, token: m?.token });
  if (!previewIsCurrent(w.preview, resolution)) {
    throw new Error('the decision changed after the preview - review it again before confirming');
  }
  return resolution;
}

async function onReview() {
  const w = S.waiting;
  if (w.running || w.building) return;
  const p = proposalById(w.id);
  const m = S.mandate?.mandate;
  if (!p || p.status !== 'PENDING') return;
  if (!m || !w.form) {
    w.error = 'Your live rules are not fully read yet. Wait a moment, then try again.';
    render();
    return;
  }
  let resolution;
  try {
    resolution = resolutionFromChoice({ choice: w.choice, form: w.form, token: m.token });
  } catch (e) {
    w.error = plainError(e.message);
    render();
    return;
  }
  w.building = true;
  w.error = null;
  render();
  try {
    const preview = await buildPreview(w.id, resolution);
    if (!preview.matches) {
      throw new Error('the browser and the server computed different digests - refusing to continue');
    }
    w.preview = preview;
    w.walletApps = walletChoices();
    openModal('review');
  } catch (e) {
    w.preview = null;
    w.error = plainError(e.message);
  } finally {
    w.building = false;
    render();
  }
}

async function afterDecision(kind) {
  const w = S.waiting;
  w.doneKind = kind;
  w.done = {
    proposalId: w.id,
    kind,
    at: Date.now(),
    preview: w.preview,
    confirmation: w.confirmation ?? null,
    plan: w.plan ?? null,
    txHash: w.txHash ?? null,
    receipt: w.receipt ?? null,
    record: w.record ?? null,
  };
  flash(DONE_TEXT[kind] ?? DONE_TEXT.amend);
  setStage('done');
}

async function confirmLanding() {
  const w = S.waiting;
  const receipt = await pollReceipt(w.txHash, {
    onTick: (i, tries) => {
      w.receiptTries = i;
      setStage('confirm', { tries: `${i} of ${tries}` });
    },
  });
  w.receipt = receipt;
  const outcome = receiptOutcome(receipt);
  await loadProposals(true);
  if (outcome === 'succeeded') {
    await loadMandate(true);
    await afterDecision(w.doneKind ?? 'amend');
    return;
  }
  if (outcome === 'reverted') throw new Error(receiptErrorMessage(receipt));
  throw new Error('it was sent, but your account had not confirmed it within two minutes');
}

/**
 * The whole sequence, in the order the tested console proved on the live
 * network: connect -> confirm the decision (popup 1) -> record it on the
 * server -> prepare the landing -> confirm the change (popup 2) -> send it
 * from the owner's own account (popup 3) -> adopt the record -> wait for the
 * network's answer. A resume (decision already recorded, not yet landed)
 * skips straight to preparing, and never records twice.
 */
async function runFlow() {
  const w = S.waiting;
  if (w.running) return;
  const p0 = proposalById(w.id);
  if (!p0) return;
  w.running = true;
  w.flowResumed = w.resolved || EXECUTABLE.includes(p0.status);
  try {
    if (!w.signer) {
      setStage('connect');
      const out = await connectOwnerWallet({ mandate: S.mandate, walletId: w.walletId });
      w.signer = out.signer;
      w.walletInfo = out.info;
      setStage('connect');
    }
    if (!w.flowResumed) {
      setStage('record');
      const resolution = currentChoiceResolution();
      const out = await signResolution({
        mandate: S.mandate,
        signer: w.signer,
        preview: w.preview,
        resolution,
        proposalId: w.id,
      });
      w.resolved = true;
      w.confirmation = out;
      if (resolution.type === 'decline') {
        await loadProposals(true);
        await afterDecision('decline');
        return;
      }
      w.doneKind = resolution.type === 'execute-once' ? 'once' : 'amend';
      await loadProposals(true);
    } else {
      w.doneKind = p0.status === 'APPROVED_ONCE' ? 'once' : 'amend';
    }
    setStage('prepare');
    const plan = await planSubmission(w.id);
    w.plan = plan;
    const out = await submitViaWallet({
      signer: w.signer,
      plan,
      onStage: (machineStep) => setStage(FLOW_MAP[machineStep] ?? 'prepare'),
    });
    w.txHash = out.txHash;
    w.record = out.record;
    setStage('confirm');
    await confirmLanding();
  } catch (e) {
    failFlow(e);
  } finally {
    w.running = false;
    renderModal();
  }
}

function failFlow(e) {
  const w = S.waiting;
  const message = String(e?.message ?? e);
  const kind = failureKind(message);
  w.modal = {
    stage: kind === 'stalled' ? 'stalled' : 'failed',
    failedAt: w.modal?.stage ?? null,
    error: plainError(message),
    machineError: message,
  };
  renderModal();
}

function retryFlow() {
  const w = S.waiting;
  if (w.running) return;
  const p = proposalById(w.id);
  const resume = w.resolved || (p && EXECUTABLE.includes(p.status));
  closeModal();
  if (resume) {
    runFlow();
    return;
  }
  // Not recorded yet: rebuild the preview from the live numbers first, so the
  // retry always confirms a fresh, re-validated decision.
  onReview();
}

async function keepLooking() {
  const w = S.waiting;
  if (w.running || !w.txHash) return;
  w.running = true;
  setStage('confirm');
  try {
    await confirmLanding();
  } catch (e) {
    failFlow(e);
  } finally {
    w.running = false;
    renderModal();
  }
}

// ------------------------------------------------------------------ the receipt

function openReceipt() {
  const d = S.waiting.done;
  if (!d) return;
  els.drawerTitle.textContent = 'The receipt';
  els.drawerBody.innerHTML = [
    resolutionMachineHtml(d.confirmation),
    reviewMachineHtml(d.preview),
    planMachineHtml(d.plan, S.waiting.walletInfo),
    receiptMachineHtml({ txHash: d.txHash, receipt: d.receipt, record: d.record }),
  ].join('') || '<p>Nothing was recorded for this decision.</p>';
  els.drawer.hidden = false;
  els.backdrop.hidden = false;
}

// ------------------------------------------------------------------ events

els.screen.addEventListener('submit', (ev) => {
  const form = ev.target.closest('form[data-action="ask"]');
  if (!form) return;
  ev.preventDefault();
  onAsk(form);
});

els.screen.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'retry' || action === 'refresh') {
    loadMandate(true);
    if (['requests', 'waiting', 'activity'].includes(S.route)) loadProposals(true);
    return;
  }
  if (action === 'review') { onReview(); return; }
  if (action === 'finish') { runFlow(); return; }
  if (action === 'receipt') { openReceipt(); return; }
  if (action === 'record-receipt') { openRecordReceipt(el.dataset.key); return; }
  if (action === 'quick') {
    const inp = $('ask-amount');
    if (inp) {
      inp.value = el.dataset.amount ?? '';
      S.askForm = { ...(S.askForm ?? {}), amount: inp.value };
      inp.focus();
    }
    return;
  }
  if (action === 'quick-store') {
    const sel = $('ask-store');
    const inp = $('ask-amount');
    const allowed = S.mandate?.mandate?.allowedRecipients ?? [];
    const target = STORES.find((s) => !isApproved(s.id, allowed));
    if (sel && target) sel.value = target.id;
    if (inp && el.dataset.amount) inp.value = el.dataset.amount;
    S.askForm = { store: sel?.value ?? '', amount: inp?.value ?? '' };
    inp?.focus();
  }
});

els.status.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  loadMandate(true);
  if (['requests', 'waiting', 'activity'].includes(S.route)) loadProposals(true);
});

els.screen.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.matches('input[name="decision"]')) {
    S.waiting.choice = t.value;
    S.waiting.preview = null;
    S.waiting.error = null;
    render();
    return;
  }
  if (t.id === 'amend-kind' && S.waiting.form) {
    S.waiting.formTouched = true;
    S.waiting.form.kind = t.value;
    S.waiting.preview = null;
    render();
  }
});

els.screen.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id !== 'amend-value' || !S.waiting.form) return;
  S.waiting.formTouched = true;
  if (S.waiting.form.kind === 'raise-per-call-cap') S.waiting.form.cap = t.value;
  if (S.waiting.form.kind === 'raise-window-cap') S.waiting.form.windowCap = t.value;
  // State only, no re-render: never move the field while the user is typing.
  // The preview is now stale; onReview rebuilds it from these values.
  S.waiting.preview = null;
});

els.modal.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'm-back' || action === 'm-close') { closeModal(); return; }
  if (action === 'm-continue') { runFlow(); return; }
  if (action === 'm-retry') { retryFlow(); return; }
  if (action === 'm-keep-looking') { keepLooking(); return; }
  if (action === 'm-receipt') { openReceipt(); return; }
  if (action === 'm-finish') { finishModal(); return; }
  if (action === 'pick-app') {
    S.waiting.walletId = el.dataset.id ?? null;
    renderModal();
  }
});

els.modalClose.addEventListener('click', closeModal);
els.modalBackdrop.addEventListener('click', closeModal);
els.drawerClose.addEventListener('click', closeDrawer);
els.backdrop.addEventListener('click', closeDrawer);
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!els.drawer.hidden) { closeDrawer(); return; }
  closeModal();
});

window.addEventListener('hashchange', navigate);

// ------------------------------------------------------------------ boot

navigate();

// Keep the read chip honest ("read 12s ago") and refresh stale reads.
setInterval(() => {
  renderStatus();
  ensureRouteData();
}, 15_000);
