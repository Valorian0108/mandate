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

import { getMandate, getProposals, fileAsk } from './data.js';
import {
  plainError, verdictWord, verdictClass, verdictSentence, rulePhrase,
  statusWord, statusClass, resolutionWord, submissionWord,
  units, pct, dayText, daysUntil, agoText,
} from './vocab.js';
import { STORES, storeName, storeWhat, storeFor, isApproved } from './stores.js';

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
  return Object.prototype.hasOwnProperty.call(ROUTES, h) ? h : 'rules';
}

function navigate() {
  S.route = routeFromHash();
  for (const a of document.querySelectorAll('.nav-item')) {
    if (a.dataset.route === S.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const r = ROUTES[S.route];
  els.title.textContent = r.title;
  els.sub.textContent = r.sub;
  ensureRouteData();
  render();
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
    note = 'It is now waiting for you, and nothing has been paid. <a href="#/waiting">Decide it</a>.';
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
        ${p.status === 'PENDING' ? '<a class="req-link" href="#/waiting">Decide</a>' : ''}
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

// ------------------------------------------------------------------ placeholders (honest)

function renderWaiting() {
  const pending = S.proposals ? S.proposals.filter((p) => p.status === 'PENDING').length : null;
  const now = pending === null
    ? 'This screen is being built next.'
    : pending === 1
      ? 'Right now 1 ask is waiting on you.'
      : `Right now ${pending} asks are waiting on you.`;
  return `<div class="card soon-card">
    <div class="card-head">
      <div>
        <div class="card-label">being built next</div>
        <div class="card-title">Your decisions live here</div>
      </div>
    </div>
    <div class="card-body">
      <p>${now} This is where you approve one purchase, change a rule, or say no. Nothing moves until you decide.</p>
      <p class="card-note">Until it is ready, every waiting ask is listed on the <a href="#/requests">Requests</a> screen, and nothing can be spent while one waits.</p>
    </div>
  </div>`;
}

function renderActivity() {
  return `<div class="card soon-card">
    <div class="card-head">
      <div>
        <div class="card-label">being built next</div>
        <div class="card-title">The permanent record</div>
      </div>
    </div>
    <div class="card-body">
      <p>Every rule change and every payment will be listed here in order, each with a receipt you can open. Nothing is ever removed.</p>
      <p class="card-note">For now, the <a href="#/requests">Requests</a> screen already shows every ask and how it ended.</p>
    </div>
  </div>`;
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

els.drawerClose.addEventListener('click', closeDrawer);
els.backdrop.addEventListener('click', closeDrawer);
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeDrawer();
});

window.addEventListener('hashchange', navigate);

// ------------------------------------------------------------------ boot

navigate();

// Keep the read chip honest ("read 12s ago") and refresh stale reads.
setInterval(() => {
  renderStatus();
  ensureRouteData();
}, 15_000);
