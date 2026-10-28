// The five screens. Vanilla JS, no build step, no framework.
//
// Data comes from the chain (via the local server's starknet_call reads) and from
// the append-only proposal/submission records. The owner private key lives only in
// this module's memory while the Approvals or Résumé screen is open; it is never
// sent to the server and never written to storage.

import { ladderChangeDigest, resolutionDigest, witnessAttestationDigest } from './signer.js';
import { buildInvokeTx } from './tx-signer.js';
import { signerForInput } from './signers.js';
import { connectWallet, detectWallets } from './wallet.js';

// ------------------------------------------------------------------ state

const S = {
  route: '',
  mandate: null,
  mandateError: null,
  mandateAt: 0,
  loadingMandate: false,

  proposals: null,
  submissions: [],
  proposalsError: null,
  proposalsAt: 0,
  loadingProposals: false,

  audit: null,
  auditError: null,
  loadingAudit: false,

  resume: null,
  resumeError: null,
  loadingResume: false,
  ladderForm: null,
  ladderPreview: null,
  ladderPreviewError: null,
  witnessForm: null,
  witnessPreview: null,
  witnessPreviewError: null,
  anchorBusy: false,
  anchorStage: null,
  anchorResult: null,
  anchorError: null,
  // The anchor's wallet-mode plan (purpose: 'anchor' on the outside relay).
  // Separate from S.plan: a plan is per screen, and the résumé keeps its own.
  anchorPlan: null,
  anchorPlanError: null,
  anchorPlanLoading: false,

  // Owner-action upgrade path (the v0.4 install). The card lives on the
  // mandate screen; the flow mirrors the submit panel, but this is an OWNER
  // action, not a proposal: planned from the state file's recorded pending
  // class checked against the chain's current one, signed in this tab,
  // carried by the same relay under the same three controls.
  upgrade: null,            // status payload from /api/owner/upgrade
  upgradeError: null,
  upgradeLoading: false,
  upgradePlan: null,
  upgradePlanError: null,
  upgradePlanLoading: false,
  upgradeBusy: null,        // 'submit' | 'receipt'
  upgradeReceiptTries: 0,
  upgradeAck: false,        // the loud confirmation, per priced plan
  upgradeTx: null,          // { hash, status } - the card's record line

  selected: null,
  form: null,
  decision: null,
  preview: null,
  previewError: null,
  plan: null,
  planError: null,
  planLoading: false,
  receiptTries: 0,

  // Every screen that signs holds one of these, never a private key.
  // Shape: { signer, check } | null. See web/signers.js for the contract.
  signers: { approvals: null, ladder: null, anchor: null, tx: null, witness: null, upgrade: null },
  // Native-wallet connection state: null, { connecting: true }, { error }, or
  // { info, signer } after a successful connect. The signer stays here (not in a
  // slot) because ONE decision spans two signatures: the resolution (approvals
  // slot) and the final transaction (submit panel) both use it. A wallet holds
  // no key material in this tab and re-prompts for every signature, so it
  // persists through the flow; a pasted key is forgotten the moment it is used.
  wallet: null,
  busy: null,
  flash: null,
};

const ROUTES = ['mandate', 'proposals', 'approvals', 'audit', 'resume'];
const TITLES = {
  mandate: 'What the agent may do',
  proposals: 'What the agent asked for',
  approvals: 'Your signature, not ours',
  audit: 'The record, in order',
  resume: 'What the agent has earned',
};

// ------------------------------------------------------------------ utilities

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const norm = (v) => {
  try { return '0x' + BigInt(v).toString(16); } catch { return String(v ?? '').toLowerCase(); }
};

const short = (v, head = 6, tail = 4) => {
  const s = String(v ?? '');
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
};

const fmtInt = (v) => {
  try { return BigInt(v).toLocaleString('en-US'); } catch { return String(v ?? '—'); }
};

const fmtNum = (v) => Number(v ?? 0).toLocaleString('en-US');

// Not every proposal is a spend: the store also holds files:share records (from
// the toy demo) whose context carries no amount or recipient. Titles must say
// what was actually asked instead of rendering "— units → ".
const proposalTitle = (p) => {
  const c = p.request.context ?? {};
  if (c.amount === undefined || c.amount === null) {
    return `${esc(p.request.action)}${p.request.resource
      ? ` — ${esc(short(p.request.resource, 10, 16))}` : ''}`;
  }
  return `${fmtInt(c.amount)} units → ${esc(short(c.recipient))}`;
};

const when = (ts) => (ts
  ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  : '—');

// Outside-execution windows arrive in unix SECONDS (the chain's own unit).
const fmtUnix = (sec) => (sec === null || sec === undefined
  ? '—'
  : new Date(Number(sec) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));

const ago = (ts) => {
  if (!ts) return 'not yet';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const voyager = (hash) => `https://sepolia.voyager.online/tx/${encodeURIComponent(hash)}`;

const copyBtn = (value, what = 'value') =>
  `<button class="copy" type="button" data-copy="${esc(value)}" aria-label="Copy ${esc(what)}">Copy</button>`;

const spinner = '<span class="spinner" aria-hidden="true"></span>';

function statusChip(status) {
  const map = {
    PENDING: ['pending', 'Pending'],
    APPROVED_ONCE: ['approved', 'Approved once'],
    AMENDED: ['amended', 'Amended'],
    DECLINED: ['declined', 'Declined'],
  };
  const [kind, label] = map[status] ?? ['plain', status];
  return `<span class="chip chip--${kind}">${esc(label)}</span>`;
}

// An evidence outcome is not a proposal status. Real results and simulated ones
// are deliberately different colours: a sandbox record must never look like a
// transfer that actually happened.
function outcomeChip(outcome) {
  const kind = {
    executed: 'approved',
    approved: 'approved',
    blocked: 'danger',
    declined: 'declined',
    asked: 'pending',
    'sandbox-allowed': 'plain',
    'sandbox-blocked': 'danger',
    'sandbox-asked': 'pending',
  }[outcome] ?? 'plain';
  return `<span class="chip chip--${kind}">${esc(outcome)}</span>`;
}

function stageChip(stage) {
  const kind = {
    new: 'plain',
    probation: 'pending',
    trusted: 'approved',
    established: 'approved',
    restricted: 'danger',
  }[stage] ?? 'plain';
  return `<span class="chip chip--${kind}">${esc(stage)}</span>`;
}

function submissionFor(id) {
  return [...S.submissions].reverse().find((s) => s.proposalId === id) ?? null;
}

function finalSubmissionFor(id) {
  return [...S.submissions].reverse()
    .find((s) => s.proposalId === id && (s.status === 'SUCCEEDED' || s.status === 'REVERTED'))
    ?? null;
}

function resolutionText(p) {
  const r = p.resolution;
  if (!r) return '—';
  if (r.type === 'execute-once') return 'approved once · the owner makes the transfer';
  if (r.type === 'decline') return 'declined · the block stands';
  const a = r.amendment ?? {};
  if (a.kind === 'raise-per-call-cap') return `per-call cap raised to ${fmtInt(a.maxPerCall)}`;
  if (a.kind === 'raise-window-cap') return `window cap raised to ${fmtInt(a.maxPerWindow)}`;
  if (a.kind === 'allow-recipient') return `recipient ${short(a.recipient)} added to the allowlist`;
  return 'amended';
}

function flashHtml() {
  if (!S.flash) return '';
  const kind = S.flash.kind === 'danger' ? ' flash--danger' : '';
  return `<div class="flash${kind}" id="flash" role="status">
    <span>${esc(S.flash.text)}</span>
    <button class="copy" type="button" data-action="dismiss-flash" aria-label="Dismiss message">Dismiss</button>
  </div>`;
}

// ------------------------------------------------------------------ API

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

// ------------------------------------------------------------------ the relay
// The tab signs the FINAL transaction; the server only carries the signed bytes.
// These helpers are the browser half of that: ask the server to price a plan,
// build and sign it locally, hand it over, then watch the chain - never the
// server - declare the outcome.

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Poll the chain (through the server's verbatim receipt read) until the
// transaction is final. Returns the receipt, or null if it is still pending -
// pending is a fact, not an error, and the UI must say so plainly.
async function pollReceipt(txHash, { tries = 30, everyMs = 4000, onTick } = {}) {
  for (let i = 1; i <= tries; i += 1) {
    await sleep(everyMs);
    let out = null;
    try {
      out = await api(`/api/tx/receipt?hash=${encodeURIComponent(txHash)}`);
    } catch { /* node unreachable - keep trying, honestly */ }
    if (onTick) onTick(i, out);
    if (out?.final) return out.receipt;
  }
  return null;
}

// Any submission left at BROADCAST (the tab closed before the receipt landed)
// gets one honest look on the next load. The server writes the final status
// from the receipt; this only asks.
async function settleBroadcastSubmissions() {
  const pending = S.submissions.filter((s) => s.status === 'BROADCAST' && s.tx_hash);
  if (pending.length === 0) return false;
  await Promise.allSettled(pending.map((s) => (
    api(`/api/tx/receipt?hash=${encodeURIComponent(s.tx_hash)}`))));
  await loadProposals(true);
  return true;
}

// ------------------------------------------------------------------ loaders

async function loadMandate(force = false) {
  if (S.loadingMandate) return;
  if (!force && S.mandate) return;
  S.loadingMandate = true;
  S.mandateError = null;
  try {
    S.mandate = await api('/api/mandate');
    S.mandateAt = Date.now();
  } catch (e) {
    S.mandateError = e.message;
  } finally {
    S.loadingMandate = false;
    renderStatus();
  }
}

// The gate's contract status for the upgrade card: the recorded version and
// pending class from the state file, next to the CURRENT class hash read from
// the chain. The chain read is the authority; the file is the record.
async function loadUpgradeStatus(force = false) {
  if (S.upgradeLoading) return;
  if (!force && S.upgrade) return;
  S.upgradeLoading = true;
  S.upgradeError = null;
  try {
    S.upgrade = await api('/api/owner/upgrade');
  } catch (e) {
    S.upgradeError = e.message;
  } finally {
    S.upgradeLoading = false;
    renderUpgradePanel();
  }
}

async function loadProposals(force = false) {
  if (S.loadingProposals) return;
  if (!force && S.proposals) return;
  S.loadingProposals = true;
  S.proposalsError = null;
  try {
    const out = await api('/api/proposals');
    S.proposals = out.proposals;
    S.submissions = out.submissions ?? [];
    S.proposalsAt = Date.now();
  } catch (e) {
    S.proposalsError = e.message;
  } finally {
    S.loadingProposals = false;
  }
}

async function loadAudit(force = false) {
  if (S.loadingAudit) return;
  if (!force && S.audit) return;
  S.loadingAudit = true;
  S.auditError = null;
  try {
    S.audit = await api('/api/audit');
  } catch (e) {
    S.auditError = e.message;
  } finally {
    S.loadingAudit = false;
  }
}

async function loadResume(force = false) {
  if (S.loadingResume) return;
  if (!force && S.resume) return;
  S.loadingResume = true;
  S.resumeError = null;
  try {
    S.resume = await api('/api/resume');
  } catch (e) {
    S.resumeError = e.message;
  } finally {
    S.loadingResume = false;
  }
}

// ------------------------------------------------------------------ routing

function routeFromHash() {
  const m = location.hash.match(/^#\/([a-z]+)/);
  return ROUTES.includes(m?.[1]) ? m[1] : 'mandate';
}

function navigate() {
  const next = routeFromHash();
  if (next === S.route) return;
  if (S.route === 'approvals') {
    S.signers.approvals = null;
    S.signers.tx = null;
    S.wallet = null;
    S.preview = null;
    S.previewError = null;
    S.plan = null;
    S.planError = null;
  }
  if (S.route === 'resume') {
    // Leaving the screen forgets the owner key, exactly like Approvals does.
    // A wallet connected HERE belongs to this screen's decision only - each
    // screen connects (and refuses) on its own facts.
    S.signers.ladder = null;
    S.signers.anchor = null;
    S.signers.witness = null;
    S.ladderPreview = null;
    S.ladderPreviewError = null;
    S.witnessPreview = null;
    S.witnessPreviewError = null;
    S.wallet = null;
    S.anchorPlan = null;
    S.anchorPlanError = null;
  }
  S.route = next;
  S.flash = null;
  render({ focus: true });
  ensureRouteData();
}

async function ensureRouteData() {
  // Approvals reads the LIVE mandate for every default and every amendment bound
  // (current cap, window cap, token). Loading it is not an optimisation here -
  // without it the screen cannot be rendered honestly.
  if ((S.route === 'mandate' || S.route === 'proposals' || S.route === 'approvals'
    || S.route === 'resume') && !S.mandate && !S.loadingMandate) {
    await loadMandate();
    render();
  }
  if ((S.route === 'proposals' || S.route === 'approvals')
    && !S.proposals && !S.loadingProposals) {
    await loadProposals();
    render();
  }
  if (S.route === 'audit' && !S.audit && !S.loadingAudit) {
    await loadAudit();
    render();
  }
  // The résumé shows "the live mandate applies" for the broader stages, so it
  // needs the chain numbers too - otherwise that phrase is a guess.
  if (S.route === 'resume' && !S.resume && !S.loadingResume) {
    await loadResume();
    render();
  }
  if (S.route === 'approvals') loadPlanIfNeeded();
}

// ------------------------------------------------------------------ render

let lastRoute = null;

function render({ focus = false } = {}) {
  const view = $('#view');
  if (!view) return;

  renderNav();
  renderStatus();

  const title = TITLES[S.route] ?? 'Permission console';
  document.title = `${title} · Mandate`;

  if (S.route === 'mandate') view.innerHTML = screenMandate();
  else if (S.route === 'proposals') view.innerHTML = screenProposals();
  else if (S.route === 'approvals') view.innerHTML = screenApprovals();
  else if (S.route === 'resume') view.innerHTML = screenResume();
  else view.innerHTML = screenAudit();

  bindScreen();

  if ((focus || lastRoute !== S.route) && lastRoute !== S.route) {
    const h1 = view.querySelector('h1');
    if (h1) {
      h1.setAttribute('tabindex', '-1');
      h1.focus({ preventScroll: true });
    }
  }
  lastRoute = S.route;
}

function renderNav() {
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === S.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const pending = (S.proposals ?? []).filter((p) => p.status === 'PENDING').length;
  const badge = $('[data-count="approvals"]');
  if (badge) {
    badge.hidden = pending === 0;
    badge.textContent = String(pending);
  }
}

function renderStatus() {
  const m = S.mandate;
  const block = m?.status?.blockNumber;
  const gate = m?.gate;
  const chain = (m?.chainId ?? 'SN_SEPOLIA').replace(/^SN_/, '');
  const blockText = block != null ? `block ${fmtNum(block)}` : 'block —';
  const gateText = gate ? `gate ${short(gate)}` : 'gate —';

  const set = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
  set('#status-chain', chain);
  set('#status-block', blockText);
  set('#status-gate', gateText);
  set('#status-read', S.mandateAt ? `read ${ago(S.mandateAt)}` : 'not read yet');
  set('#rail-block', blockText);
}

// ------------------------------------------------------------------ shared UI

function errorCard(title, message) {
  return `<section class="screen">
    ${flashHtml()}
    <div class="error-card">
      <h2>${esc(title)}</h2>
      <p>${esc(message)}</p>
      <button class="btn" type="button" data-action="refresh">Read again</button>
    </div>
  </section>`;
}

function skeletonScreen() {
  return `<section class="screen" aria-busy="true">
    <div class="skeleton">
      <div class="skeleton-line skeleton-line--title"></div>
      <div class="skeleton-line skeleton-line--short"></div>
      <div class="skeleton-block"></div>
      <div class="skeleton-block"></div>
    </div>
    <p class="hint">Reading the chain…</p>
  </section>`;
}

function screenHead(lede, actions = '') {
  return `<header class="screen-head">
    <div>
      <h1>${esc(TITLES[S.route])}.</h1>
      <p class="lede">${esc(lede)}</p>
    </div>
    <div class="screen-actions">${actions}</div>
  </header>`;
}

// ------------------------------------------------------------------ screen: mandate

function screenMandate() {
  if (S.mandateError) return errorCard('The chain did not answer.', S.mandateError);
  if (!S.mandate) return skeletonScreen();

  const m = S.mandate.mandate;
  const now = Math.floor(Date.now() / 1000);
  const windowElapsed = now >= m.windowStart + m.windowSeconds;
  const spent = windowElapsed ? 0n : BigInt(m.spentInWindow);
  const windowCap = BigInt(m.maxPerWindow);
  const spentPct = windowCap > 0n ? Number((spent * 1000n) / windowCap) / 10 : 0;
  const spentLevel = spentPct >= 100 ? 'full' : spentPct >= 80 ? 'warn' : 'none';
  const callsPct = m.maxCalls > 0 ? Math.min(100, (m.callsUsed / m.maxCalls) * 100) : 0;
  const resetAt = (m.windowStart + m.windowSeconds) * 1000;
  const expired = now > m.validUntil;
  const ownerKey = S.mandate.ownerPublicKey;
  const ownerChip = S.mandate.ownerKeyMatchesRecord === true
    ? '<span class="chip chip--approved">matches registration record</span>'
    : S.mandate.ownerKeyMatchesRecord === false
      ? '<span class="chip chip--danger">record mismatch</span>'
      : '<span class="chip chip--plain">not cross-checked</span>';

  const allowed = m.allowedRecipients ?? [];
  const stranger = S.mandate.stranger;

  return `<section class="screen">
    ${flashHtml()}
    ${screenHead('These limits are read from the Starknet account itself — not from a company database. If the account says no, the agent cannot spend.', `
      <span class="chip chip--plain">${esc((S.mandate.chainId ?? 'SN_SEPOLIA').replace(/^SN_/, ''))}</span>
      <button class="btn" type="button" data-action="refresh">Read again</button>
    `)}

    <div class="grid">
      <section class="card span-7">
        <div class="card-head">
          <h2 class="card-title">Spending limits</h2>
          <span class="readout">${windowElapsed ? 'window elapsed' : 'live'}</span>
        </div>
        <div class="stat-row">
          <div class="stat">
            <p class="label">Per call</p>
            <p class="stat-value">${fmtInt(m.maxPerCall)}</p>
            <p class="stat-unit">mock units</p>
          </div>
          <div class="stat">
            <p class="label">Per window</p>
            <p class="stat-value">${fmtInt(m.maxPerWindow)}</p>
            <p class="stat-unit">${Math.round(m.windowSeconds / 86400)}-day window</p>
          </div>
          <div class="stat">
            <p class="label">Spent this window</p>
            <p class="stat-value">${fmtInt(spent)}</p>
            <p class="stat-unit">of ${fmtInt(m.maxPerWindow)}</p>
          </div>
        </div>
        <div class="meter-block">
          <div class="meter-head">
            <span class="label">Window used</span>
            <span class="mono">${spentPct.toFixed(1)}%</span>
          </div>
          <div class="meter" data-level="${spentLevel}" role="img"
               aria-label="${fmtInt(spent)} of ${fmtInt(m.maxPerWindow)} mock units spent in this window">
            <span style="--fill:${Math.min(1, spentPct / 100)}"></span>
          </div>
          <p class="hint">${windowElapsed
            ? 'The window has elapsed. The contract will reset the spent counter on the next spend.'
            : `The window resets ${when(resetAt)}.`}</p>
        </div>
        <div class="meter-block">
          <div class="meter-head">
            <span class="label">Calls used</span>
            <span class="mono">${fmtNum(m.callsUsed)} / ${fmtNum(m.maxCalls)}</span>
          </div>
          <div class="meter" data-level="${callsPct >= 100 ? 'full' : 'none'}" role="img"
               aria-label="${fmtNum(m.callsUsed)} of ${fmtNum(m.maxCalls)} agent calls used">
            <span style="--fill:${Math.min(1, callsPct / 100)}"></span>
          </div>
          <p class="hint">Only successful calls count. Reverted calls consume no budget.</p>
        </div>
      </section>

      <section class="card span-5">
        <div class="card-head">
          <h2 class="card-title">The lock</h2>
          ${ownerChip}
        </div>
        <dl class="facts">
          <div class="fact">
            <dt>Account</dt>
            <dd><div class="addr-row"><span class="addr">${esc(S.mandate.gate)}</span>${copyBtn(S.mandate.gate, 'account address')}</div></dd>
          </div>
          <div class="fact">
            <dt>Owner key</dt>
            <dd>
              <div class="addr-row"><span class="addr">${esc(ownerKey ?? 'unavailable')}</span>${ownerKey ? copyBtn(ownerKey, 'owner public key') : ''}</div>
              <p class="hint">Read from the account with <span class="mono">get_public_key</span>. This is the key that must sign every approval.</p>
            </dd>
          </div>
          <div class="fact">
            <dt>Token</dt>
            <dd><div class="addr-row"><span class="addr">${esc(S.mandate.token)}</span>${copyBtn(S.mandate.token, 'token address')}</div></dd>
          </div>
        </dl>
        ${S.mandate.ownerKeyError ? `<div class="callout callout--danger" style="margin-top:var(--space-4)">Owner key read failed: ${esc(S.mandate.ownerKeyError)}</div>` : ''}
        ${S.mandate.ownerKeyMatchesRecord === false ? '<div class="callout callout--danger" style="margin-top:var(--space-4)">The key on chain does not match the registration record. Do not approve anything until this is explained.</div>' : ''}
      </section>

      <section class="card span-7">
        <div class="card-head">
          <h2 class="card-title">Merchant allowlist</h2>
          <span class="readout">${allowed.length} allowed</span>
        </div>
        <div class="list">
          ${allowed.length === 0 ? '<p class="hint">No recipient is allowed. The agent can spend nothing.</p>' : allowed.map((r) => `
            <div class="list-row">
              <div class="list-main">
                <p class="list-title">${norm(r) === norm(S.mandate.merchant) ? 'Merchant' : 'Recipient'}</p>
                <p class="addr">${esc(r)}</p>
              </div>
              <span class="chip chip--approved">allowed</span>
            </div>`).join('')}
          ${stranger && !allowed.some((r) => norm(r) === norm(stranger)) ? `
            <div class="list-row">
              <div class="list-main">
                <p class="list-title">Known stranger</p>
                <p class="addr">${esc(stranger)}</p>
              </div>
              <span class="chip chip--danger">not allowed</span>
            </div>` : ''}
        </div>
        <p class="hint" style="margin-top:var(--space-4)">The contract stores the allowlist as a map with no way to list it. This list comes from the registration record, and every entry above is re-checked against the chain with <span class="mono">is_recipient_allowed</span>.</p>
      </section>

      <section class="card span-5">
        <div class="card-head">
          <h2 class="card-title">Agent session</h2>
          <span class="chip ${expired ? 'chip--danger' : 'chip--approved'}">${expired ? 'expired' : 'valid'}</span>
        </div>
        <dl class="facts">
          <div class="fact">
            <dt>Session key</dt>
            <dd><div class="addr-row"><span class="addr">${esc(m.sessionPublicKey)}</span>${copyBtn(m.sessionPublicKey, 'session public key')}</div></dd>
          </div>
          <div class="fact">
            <dt>Valid until</dt>
            <dd>${when(m.validUntil * 1000)}</dd>
          </div>
          <div class="fact">
            <dt>Selectors</dt>
            <dd class="mono">${m.allowedSelectors.length} allowed · transfer</dd>
          </div>
          <div class="fact">
            <dt>Call budget</dt>
            <dd>${fmtNum(m.callsUsed)} of ${fmtNum(m.maxCalls)} used</dd>
          </div>
        </dl>
        <p class="hint" style="margin-top:var(--space-4)">The agent holds only this session key. It cannot sign for the owner, and it cannot spend outside the policy above.</p>
      </section>

      <section class="card span-12">
        <div class="card-head">
          <h2 class="card-title">Gates registered</h2>
          <span class="readout">${S.mandate.gates.length}</span>
        </div>
        <div class="list">
          ${S.mandate.gates.map((g) => `
            <div class="list-row">
              <div class="list-main">
                <p class="list-title mono">${esc(g.namespace)}</p>
                <p class="list-sub">${g.actions.map(esc).join(' · ')}</p>
              </div>
              <span class="chip ${g.advisoryOnly ? 'chip--pending' : 'chip--approved'}">${g.advisoryOnly ? 'advisory only' : 'enforced on-chain'}</span>
            </div>`).join('')}
        </div>
        <p class="hint" style="margin-top:var(--space-4)">The spending gate mirrors the account contract's checks in the same order. The chain remains the final authority; the gate is the fast pre-check.</p>
      </section>

      <section class="card span-12" id="upgrade-card">
        <div class="card-head">
          <h2 class="card-title">Gate contract</h2>
          <span class="readout" id="upgrade-readout">reading…</span>
        </div>
        <div id="upgrade-box"><p class="hint">${spinner} Reading the gate's class hash from the chain…</p></div>
      </section>
    </div>

    <p class="hint">Read at block ${fmtNum(S.mandate.status?.blockNumber)} · ${esc(ago(S.mandateAt))}. Amounts are whole mock-token units; the test token has no market value and no decimals.</p>
  </section>`;
}

// ------------------------------------------------------------------ screen: proposals

function screenProposals() {
  if (S.proposalsError) return errorCard('The proposal record did not load.', S.proposalsError);
  if (!S.proposals) return skeletonScreen();

  const m = S.mandate?.mandate;
  const merchant = S.mandate?.merchant ?? '';
  const stranger = S.mandate?.stranger ?? '';
  const suggested = m ? (BigInt(m.maxPerCall) + 5n).toString() : '25';
  const pending = S.proposals.filter((p) => p.status === 'PENDING');
  const rest = S.proposals.filter((p) => p.status !== 'PENDING')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt));

  return `<section class="screen">
    ${flashHtml()}
    ${screenHead('Every request is checked against the live mandate. When the mandate blocks it, the request becomes a proposal that only you can resolve.', `
      <button class="btn" type="button" data-action="refresh">Read again</button>
    `)}

    <form class="card" id="ask-form">
      <div class="card-head">
        <h2 class="card-title">Ask as the agent</h2>
        <span class="readout">spend:transfer</span>
      </div>
      <p class="hint">This runs the same request the agent would make. If the mandate allows it, no proposal is created — the agent may proceed.</p>
      <div class="form-row" style="margin-top:var(--space-4)">
        <div class="field">
          <label for="ask-recipient">Recipient</label>
          <div class="input-row">
            <input class="input" id="ask-recipient" name="recipient" value="${esc(merchant)}"
                   spellcheck="false" autocomplete="off" aria-describedby="ask-recipient-hint">
            <button class="btn btn--sm" type="button" data-fill-recipient="${esc(merchant)}">Merchant</button>
            <button class="btn btn--sm" type="button" data-fill-recipient="${esc(stranger)}">Stranger</button>
          </div>
          <p class="field-hint" id="ask-recipient-hint">Merchant is on the allowlist. Stranger is not.</p>
        </div>
        <div class="field">
          <label for="ask-amount">Amount (mock units)</label>
          <input class="input" id="ask-amount" name="amount" value="${esc(suggested)}"
                 inputmode="numeric" spellcheck="false" autocomplete="off"
                 aria-describedby="ask-amount-hint">
          <p class="field-hint" id="ask-amount-hint">Prefilled just above the current per-call cap${m ? ` (${fmtInt(m.maxPerCall)})` : ''}.</p>
        </div>
        <button class="btn btn--primary" type="submit" id="ask-btn">Ask the engine</button>
      </div>
      <div id="ask-result" style="margin-top:var(--space-4)">${askResultHtml()}</div>
    </form>

    <div class="section-head">
      <h2 class="card-title">Proposals</h2>
      <span class="readout">${pending.length} pending · ${rest.length} resolved</span>
    </div>

    ${S.proposals.length === 0
      ? '<div class="empty"><strong>No proposals yet.</strong>Ask the agent to do something above. A blocked request will appear here.</div>'
      : `<div class="proposal-list">
          ${[...pending, ...rest].map((p) => proposalRow(p)).join('')}
        </div>`}
  </section>`;
}

function askResultHtml() {
  if (!S.decision) return '';
  const d = S.decision.decision;
  if (d.verdict === 'ALLOW') {
    return `<div class="callout callout--ok">
      <strong>The mandate allows this.</strong> The agent may proceed; no approval is needed.
      <span class="mono" style="display:block;margin-top:var(--space-1)">${esc(d.code)} · ${esc(d.reason)}</span>
    </div>`;
  }
  const proposal = S.decision.proposal;
  return `<div class="callout callout--warn">
    <strong>Blocked. A proposal is waiting for the owner.</strong>
    <span class="mono" style="display:block;margin-top:var(--space-1)">${esc(d.code)} · ${esc(d.reason)}</span>
    ${proposal ? `<div style="margin-top:var(--space-3)"><button class="btn btn--sm" type="button" data-review="${esc(proposal.id)}">Review proposal ${esc(proposal.id)}</button></div>` : ''}
  </div>`;
}

function proposalRow(p) {
  return `<article class="proposal-row">
    <div class="proposal-main">
      <div class="proposal-top">
        <span class="mono">${esc(p.id)}</span>
        ${statusChip(p.status)}
        <span class="readout">${esc(when(p.createdAt))}</span>
      </div>
      <p class="proposal-title">${proposalTitle(p)}</p>
      <p class="proposal-reason">${esc(p.blockedBecause.reason)}</p>
    </div>
    <div>
      ${p.status === 'PENDING'
        ? `<button class="btn" type="button" data-review="${esc(p.id)}">Review</button>`
        : `<button class="btn btn--quiet" type="button" data-review="${esc(p.id)}">Open</button>`}
    </div>
  </article>`;
}

// ------------------------------------------------------------------ screen: approvals

function screenApprovals() {
  if (S.mandateError && !S.mandate) {
    return errorCard('The live mandate did not load.', S.mandateError);
  }
  if (S.proposalsError) return errorCard('The proposal record did not load.', S.proposalsError);
  if (!S.mandate || !S.proposals) return skeletonScreen();

  const pending = S.proposals.filter((p) => p.status === 'PENDING');
  const resolved = S.proposals.filter((p) => p.status !== 'PENDING')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt));

  let p = S.proposals.find((x) => x.id === S.selected) ?? pending[0] ?? resolved[0] ?? null;
  if (p && S.form?.proposalId !== p.id) {
    initForm(p);
  }
  S.selected = p?.id ?? null;

  return `<section class="screen">
    ${flashHtml()}
    ${screenHead('Read the request, preview the exact effect, then sign with the owner key in this browser. The server never sees the key.', `
      <button class="btn" type="button" data-action="refresh">Read again</button>
    `)}

    ${S.proposals.length === 0
      ? '<div class="empty"><strong>Nothing to approve.</strong>The agent has not asked for anything yet. Start on the Proposals screen.</div>'
      : `<div class="grid">
          <aside class="card span-4">
            <div class="card-head">
              <h2 class="card-title">Waiting for you</h2>
              <span class="readout">${pending.length}</span>
            </div>
            ${pending.length === 0
              ? '<p class="hint">Nothing is pending. Resolved proposals are below.</p>'
              : `<div class="picks">${pending.map((x) => pickHtml(x, p?.id)).join('')}</div>`}
            ${resolved.length > 0 ? `
              <div class="section-head" style="margin-top:var(--space-6)">
                <h2 class="label">Resolved</h2>
              </div>
              <div class="picks">${resolved.slice(0, 6).map((x) => pickHtml(x, p?.id)).join('')}</div>` : ''}
          </aside>

          <div class="span-8 review" id="review">
            ${p ? reviewHtml(p) : '<div class="empty"><strong>Select a proposal.</strong></div>'}
          </div>
        </div>`}
  </section>`;
}

function pickHtml(p, selectedId) {
  return `<button class="pick" type="button" data-select="${esc(p.id)}"
      aria-current="${p.id === selectedId ? 'true' : 'false'}">
    <span class="pick-top">
      <span class="mono">${esc(p.id)}</span>
      ${statusChip(p.status)}
    </span>
    <span class="pick-title">${proposalTitle(p)}</span>
    <span class="pick-reason">${esc(p.blockedBecause.reason)}</span>
  </button>`;
}

function initForm(p) {
  const m = S.mandate?.mandate;
  const c = p.request.context;
  let kind = p.blockedBecause.code === 'recipient-not-allowed'
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
      // Non-spend proposals (files:share) carry no amount - the default
      // suggestion stands. BigInt(undefined) threw here and killed the whole
      // Approvals screen render; a stale record must never take the console down.
      amount = BigInt(c.amount);
      if (amount > current) suggested = amount;
      if (amount > winSuggested) winSuggested = amount;
    } catch { /* no numeric amount in this request */ }
    if (suggested > windowCap) suggested = windowCap;
    // The dead corner (OBS-35): when the ask does not fit under the WINDOW cap,
    // a per-call raise has no valid value at all - every candidate is refused by
    // one guard or the other. Default to the amendment that actually unblocks
    // it (raise the window cap) instead of suggesting a cap the preview must
    // refuse. The per-call raise then works as a second, separate decision.
    if (amount !== null && amount > windowCap) kind = 'raise-window-cap';
    cap = suggested.toString();
    winCap = winSuggested.toString();
  }
  S.form = {
    proposalId: p.id,
    type: 'execute-once',
    kind,
    cap,
    windowCap: winCap,
    recipient: c.recipient,
  };
  S.preview = null;
  S.previewError = null;
  S.plan = null;
  S.planError = null;
}

function reviewHtml(p) {
  if (p.status !== 'PENDING') return resolvedReviewHtml(p);
  return `<div id="action-error" hidden></div>
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Proposal ${esc(p.id)}</h2>
        ${statusChip(p.status)}
      </div>
      ${requestFacts(p)}
      <div class="section-head" style="margin-top:var(--space-6)">
        <h2 class="label">Why it was blocked</h2>
      </div>
      <div class="callout callout--warn">
        <strong>${esc(p.blockedBecause.verdict)} · ${esc(p.blockedBecause.code)}</strong>
        <span style="display:block;margin-top:var(--space-1)">${esc(p.blockedBecause.reason)}</span>
        <span class="mono" style="display:block;margin-top:var(--space-1)">gate: ${esc(p.blockedBecause.gate)}</span>
      </div>
    </section>

    <form class="card" id="resolution-form" onsubmit="return false">
      <div class="card-head">
        <h2 class="card-title">Your decision</h2>
        <span class="readout">owner only</span>
      </div>
      <div class="choices">
        ${choice('execute-once', 'Approve once', 'You make this exact transfer yourself. The agent gains no new power.')}
        ${choice('amend', 'Amend the mandate', 'Change the on-chain policy, then let the agent retry.')}
        ${choice('decline', 'Decline', 'Record the decision. The block stands.')}
      </div>

      <div class="amend-fields" id="amend-fields">
        <div class="field">
          <label for="amend-kind">Change</label>
          <select class="select" id="amend-kind">
            <option value="raise-per-call-cap"${S.form.kind === 'raise-per-call-cap' ? ' selected' : ''}>Raise the per-call cap</option>
            <option value="raise-window-cap"${S.form.kind === 'raise-window-cap' ? ' selected' : ''}>Raise the window cap</option>
            <option value="allow-recipient"${S.form.kind === 'allow-recipient' ? ' selected' : ''}>Allow this recipient</option>
          </select>
        </div>
        <div class="field" data-amend="raise">
          <label for="amend-cap">New per-call cap (mock units)</label>
          <input class="input" id="amend-cap" value="${esc(S.form.cap)}" inputmode="numeric"
                 spellcheck="false" autocomplete="off">
          <p class="field-hint">Current cap ${fmtInt(S.mandate.mandate.maxPerCall)}; window cap ${fmtInt(S.mandate.mandate.maxPerWindow)}. This changes the per-call cap only. The contract restarts the spending window when the policy is re-set.</p>
        </div>
        <div class="field" data-amend="window">
          <label for="amend-window">New window cap (mock units)</label>
          <input class="input" id="amend-window" value="${esc(S.form.windowCap)}" inputmode="numeric"
                 spellcheck="false" autocomplete="off">
          <p class="field-hint">Current window cap ${fmtInt(S.mandate.mandate.maxPerWindow)}; the per-call cap stays ${fmtInt(S.mandate.mandate.maxPerCall)}. Raise this when the per-call cap has no room left under the window. The contract restarts the spending window when the policy is re-set.</p>
        </div>
        <div class="field" data-amend="allow">
          <label for="amend-recipient">Recipient to allow</label>
          <input class="input" id="amend-recipient" value="${esc(S.form.recipient)}"
                 spellcheck="false" autocomplete="off">
          <p class="field-hint">This adds the recipient permanently (until disallowed). It is not a one-time exception.</p>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn" type="button" id="preview-btn">Preview the exact effect</button>
      </div>
    </form>

    <section class="card card--inset" id="preview-panel"></section>

    <section class="card" id="sign-card">
      <div class="card-head">
        <h2 class="card-title">Sign as the owner</h2>
        <span class="readout">wallet or key · never sent to the server</span>
      </div>
      <div id="wallet-box" style="margin-top:var(--space-2)"></div>
      <div class="field" style="margin-top:var(--space-4)">
        <label for="owner-key">Or paste the owner private key (testnet recovery path)</label>
        <input class="input" id="owner-key" type="password" autocomplete="off"
               spellcheck="false" placeholder="0x…" data-1p-ignore data-lpignore="true">
      </div>
      <p class="hint">A pasted key is used in this browser only and never sent anywhere. The server receives the signature, not the key.</p>
      <div id="key-status" class="key-status is-muted">No wallet connected and no key entered.</div>
      <div class="form-actions">
        <button class="btn btn--primary" type="button" id="sign-btn" disabled>Sign resolution</button>
        <button class="btn btn--quiet" type="button" id="forget-btn">Forget key</button>
      </div>
      <p class="hint" style="margin-top:var(--space-3)">The browser recomputes the digest from the proposal and your decision, then signs it. If its computation differs from the server's, it refuses to sign. The server verifies the signature against the owner key read from the chain.</p>
    </section>`;
}

function choice(value, title, desc) {
  return `<label class="choice">
    <input type="radio" name="resolution" value="${value}"${S.form.type === value ? ' checked' : ''}>
    <span class="choice-mark" aria-hidden="true"></span>
    <span>
      <span class="choice-title">${esc(title)}</span>
      <span class="choice-desc">${esc(desc)}</span>
    </span>
  </label>`;
}

function requestFacts(p) {
  const c = p.request.context;
  return `<dl class="facts">
    <div class="fact"><dt>Amount</dt><dd class="mono">${fmtInt(c.amount)} mock units</dd></div>
    <div class="fact"><dt>Recipient</dt><dd><div class="addr-row"><span class="addr">${esc(c.recipient)}</span>${copyBtn(c.recipient, 'recipient')}</div></dd></div>
    <div class="fact"><dt>Token</dt><dd><div class="addr-row"><span class="addr">${esc(c.token)}</span>${copyBtn(c.token, 'token')}</div></dd></div>
    <div class="fact"><dt>Agent</dt><dd class="mono">${esc(p.request.agent)}</dd></div>
    <div class="fact"><dt>Asked</dt><dd>${esc(when(p.createdAt))}</dd></div>
  </dl>`;
}

function resolvedReviewHtml(p) {
  const digest = p.digest ?? null;
  const validNow = p.signatureValidNow;
  return `<div id="action-error" hidden></div>
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Proposal ${esc(p.id)}</h2>
        ${statusChip(p.status)}
      </div>
      ${requestFacts(p)}
      <div class="callout callout--warn" style="margin-top:var(--space-5)">
        <strong>${esc(p.blockedBecause.verdict)} · ${esc(p.blockedBecause.code)}</strong>
        <span style="display:block;margin-top:var(--space-1)">${esc(p.blockedBecause.reason)}</span>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">The owner's decision</h2>
        <span class="readout">${esc(when(p.resolvedAt))}</span>
      </div>
      <dl class="facts">
        <div class="fact"><dt>Decision</dt><dd>${esc(resolutionText(p))}</dd></div>
        ${digest ? `<div class="fact"><dt>Digest</dt><dd><p class="digest">${esc(digest)}</p></dd></div>` : ''}
        ${p.signature ? `<div class="fact"><dt>Signature</dt><dd class="mono">r ${esc(short(p.signature.r, 10, 8))} · s ${esc(short(p.signature.s, 10, 8))}</dd></div>` : ''}
        <div class="fact"><dt>Verified against</dt><dd><span class="mono">${esc(short(p.ownerPublicKeyAtResolution, 12, 8))}</span> <span class="chip chip--approved">chain key</span></dd></div>
      </dl>
      ${validNow === false ? '<div class="callout callout--danger" style="margin-top:var(--space-4)"><strong>This signature no longer matches the current owner key.</strong> The owner key has changed on chain since this approval. Do not submit it.</div>' : ''}
      ${p.status === 'DECLINED' ? '<p class="hint" style="margin-top:var(--space-4)">Declined. The block stands; nothing goes on-chain.</p>' : ''}
    </section>

    ${p.status === 'DECLINED' ? '' : `
      <section class="card" id="submit-card">
        <div class="card-head">
          <h2 class="card-title">Put it on-chain</h2>
          <span class="readout">owner transaction</span>
        </div>
        <div id="submit-panel"></div>
      </section>`}
`;
}

function submissionHtml(sub) {
  if (sub.status === 'SUCCEEDED') {
    return `<div class="callout callout--ok">
      <strong>Submitted and executed.</strong>
      ${sub.kind === 'outside' ? `<span style="display:block;margin-top:var(--space-1)">${sub.via === 'wallet-submitted'
      ? 'Authorized in the wallet and sent by the wallet itself — nobody carried it for the owner.'
      : "Authorized in the wallet and relayed by the server's gas-only key."}${sub.nonce_consumed
    ? ' The one-shot nonce is burned on chain — this authorization can never be replayed.' : ''}</span>` : ''}
      <span class="mono" style="display:block;margin-top:var(--space-1)">tx ${esc(sub.tx_hash)}</span>
      <div style="margin-top:var(--space-2)"><a href="${voyager(sub.tx_hash)}" target="_blank" rel="noreferrer">Open on Voyager</a></div>
    </div>`;
  }
  if (sub.status === 'REVERTED') {
    return `<div class="callout callout--danger">
      <strong>The transaction reverted.</strong>
      <span style="display:block;margin-top:var(--space-1)">${esc(sub.revert_reason ?? 'no reason returned')}</span>
      <span class="mono" style="display:block;margin-top:var(--space-1)">tx ${esc(sub.tx_hash)}</span>
      <div style="margin-top:var(--space-2)"><a href="${voyager(sub.tx_hash)}" target="_blank" rel="noreferrer">Open on Voyager</a></div>
    </div>`;
  }
  if (sub.status === 'BROADCAST') {
    return `<div class="callout callout--warn">
      <strong>${sub.kind === 'outside' ? 'Signed in the wallet' : 'Signed in this tab'} and relayed — the chain has not confirmed yet.</strong>
      <span class="mono" style="display:block;margin-top:var(--space-1)">tx ${esc(sub.tx_hash)}</span>
      <span style="display:block;margin-top:var(--space-1)">The final status is written only from a receipt read back from Starknet — never from the relay. "Read again" keeps looking.</span>
      <div style="margin-top:var(--space-2)"><a href="${voyager(sub.tx_hash)}" target="_blank" rel="noreferrer">Open on Voyager</a></div>
    </div>`;
  }
  return `<div class="callout callout--danger">
    <strong>The submission did not complete.</strong>
    <span style="display:block;margin-top:var(--space-1)">${esc(sub.message ?? 'no message')}</span>
  </div>`;
}

// ------------------------------------------------------------------ screen: audit

function screenAudit() {
  if (S.auditError) return errorCard('The audit record did not load.', S.auditError);
  if (!S.audit) return skeletonScreen();

  const events = buildAuditEvents(S.audit);
  const proposals = S.audit.proposals ?? [];
  const pending = proposals.filter((p) => p.status === 'PENDING').length;
  const resolved = proposals.filter((p) => p.status !== 'PENDING').length;
  const submissions = (S.audit.submissions ?? []).length;
  const demoRuns = (S.audit.demoRuns ?? []).length;

  return `<section class="screen">
    ${flashHtml()}
    ${screenHead('Proposals, signatures and transactions, as they happened. The files are append-only; this screen never edits history.', `
      <button class="btn" type="button" data-action="refresh">Read again</button>
    `)}

    <div class="summary">
      <div class="summary-item"><p class="label">Proposals</p><p class="stat-value">${proposals.length}</p></div>
      <div class="summary-item"><p class="label">Pending</p><p class="stat-value">${pending}</p></div>
      <div class="summary-item"><p class="label">Resolved</p><p class="stat-value">${resolved}</p></div>
      <div class="summary-item"><p class="label">On-chain submissions</p><p class="stat-value">${submissions}</p></div>
    </div>

    ${events.length === 0
      ? '<div class="empty"><strong>No records yet.</strong>Proposals, owner signatures and transactions will appear here in order.</div>'
      : `<div class="table-scroll">
          <table>
            <caption>Audit trail: proposals, owner resolutions and on-chain submissions</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Event</th>
                <th scope="col">Proposal</th>
                <th scope="col">Detail</th>
                <th scope="col">Proof</th>
              </tr>
            </thead>
            <tbody>
              ${events.map((e) => `<tr>
                <td class="mono">${esc(when(e.t))}</td>
                <td><span class="table-event">${esc(e.title)}</span></td>
                <td class="mono">${e.id ? esc(e.id) : '—'}</td>
                <td>${e.detail}</td>
                <td>${e.proof}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`}

    <div class="card card--inset">
      <div class="card-head">
        <h2 class="card-title">Where this comes from</h2>
        <span class="readout">${demoRuns} live demo runs</span>
      </div>
      <p class="hint">Proposals: <span class="mono">.data/demo-proposals.json</span> · submissions: <span class="mono">.data/submissions.json</span> · live demo runs: <span class="mono">gate-account/.sepolia/state.json</span>. Resolved signatures are re-verified against the current owner key when this screen loads; a signature that no longer matches is marked loudly rather than hidden.</p>
      ${S.audit.ownerError ? `<div class="callout callout--warn" style="margin-top:var(--space-3)">Could not re-read the owner key: ${esc(S.audit.ownerError)}</div>` : ''}
    </div>
  </section>`;
}

function buildAuditEvents(data) {
  const events = [];
  for (const p of data.proposals ?? []) {
    const c = p.request.context ?? {};
    events.push({
      t: p.createdAt,
      title: 'Proposal created',
      id: p.id,
      detail: `${fmtInt(c.amount)} units → ${esc(short(c.recipient))} · ${esc(p.blockedBecause.code)}`,
      proof: `<span class="mono">${esc(p.blockedBecause.verdict)}</span>`,
    });
    if (p.resolvedAt) {
      events.push({
        t: p.resolvedAt,
        title: `Owner resolved · ${p.status}`,
        id: p.id,
        detail: esc(resolutionText(p))
          + (p.signatureValidNow === false ? ' <span class="chip chip--danger">key changed</span>' : ''),
        proof: p.digest
          ? `<span class="mono" title="${esc(p.digest)}">${esc(short(p.digest, 10, 8))}</span> ${copyBtn(p.digest, 'resolution digest')}`
          : '—',
      });
    }
  }
  for (const s of data.submissions ?? []) {
    events.push({
      t: s.submittedAt,
      title: `Submitted on-chain · ${s.status}`,
      id: s.proposalId,
      detail: s.tx_hash
        ? `<a href="${voyager(s.tx_hash)}" target="_blank" rel="noreferrer">${esc(short(s.tx_hash, 12, 10))}</a>`
        : esc(s.message ?? 'no transaction hash'),
      proof: s.tx_hash ? `<span class="chip ${s.status === 'SUCCEEDED' ? 'chip--approved' : 'chip--danger'}">${esc(s.status)}</span>` : '—',
    });
  }
  for (const d of data.demoRuns ?? []) {
    events.push({
      t: Date.parse(d.date),
      title: 'Live cap-raise demo · owner amendment',
      id: d.proposal_id,
      detail: `cap ${esc(d.policy_before?.maxPerCall ?? '—')} → ${esc(d.policy_after?.maxPerCall ?? '—')} · ${fmtInt(d.amount_sent)} units sent by the agent`,
      proof: d.owner_tx_hash
        ? `<a href="${voyager(d.owner_tx_hash)}" target="_blank" rel="noreferrer">${esc(short(d.owner_tx_hash, 10, 8))}</a>` : '—',
    });
    if (d.agent_tx_hash) {
      events.push({
        t: Date.parse(d.date),
        title: 'Live cap-raise demo · agent retry',
        id: d.proposal_id,
        detail: `${fmtInt(d.amount_sent)} units to ${esc(short(d.merchant))} · SUCCEEDED`,
        proof: `<a href="${voyager(d.agent_tx_hash)}" target="_blank" rel="noreferrer">${esc(short(d.agent_tx_hash, 10, 8))}</a>`,
      });
    }
  }
  return events.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
}

// ------------------------------------------------------------------ screen: résumé

function screenResume() {
  if (S.resumeError) return errorCard('The résumé did not load.', S.resumeError);
  if (!S.resume) return skeletonScreen();
  if (!S.resume.ok) {
    // Not a crash and not a blank page: a refusal to show a trust state that
    // cannot be proved. The reason is the system working, so it is shown verbatim.
    return errorCard('This agent\'s trust state could not be verified.', S.resume.reason);
  }

  const r = S.resume;
  if (!S.ladderForm || S.ladderForm.stage !== r.stage) initLadderForm(r);
  if (!S.witnessForm || S.witnessForm.agentId !== r.identity.agentId) initWitnessForm(r);

  return `<section class="screen">
    ${flashHtml()}
    ${screenHead('The stage this agent has earned, the limits that come with it, and the signed records behind them. Nothing here is a company opinion - the identity, the evidence and every ladder change are checked against a signature.', `
      <button class="btn" type="button" data-action="refresh">Read again</button>
    `)}

    <div class="grid">
      <aside class="card span-4">
        ${resumeStageCard(r)}
        ${resumeEvidenceCard(r)}
      </aside>
      <div class="span-8">
        ${resumeLimitsCard(r)}
        ${resumeAnchorCard(r)}
        ${resumeHistoryCard(r)}
        ${resumeNextStepCard(r)}
        ${resumeWitnessCard(r)}
      </div>
    </div>
  </section>`;
}

function resumeStageCard(r) {
  return `<div class="card-head">
      <h2 class="card-title">Where this agent is</h2>
      ${stageChip(r.stage)}
    </div>
    <p class="stat-value" style="margin-top:var(--space-2)">${esc(r.stage)}</p>
    <p class="hint">${esc(r.stageLabel)} · ${esc(stageSentence(r.stage))}</p>
    <dl class="facts" style="margin-top:var(--space-4)">
      <div class="fact"><dt>Agent id</dt><dd><div class="addr-row"><span class="addr">${esc(r.identity.agentId)}</span>${copyBtn(r.identity.agentId, 'agent id')}</div></dd></div>
      <div class="fact"><dt>Purpose</dt><dd>${esc(r.identity.purpose)}</dd></div>
      <div class="fact"><dt>Created</dt><dd>${esc(when(r.identity.createdAt))}</dd></div>
      <div class="fact"><dt>Owner on chain</dt><dd><div class="addr-row"><span class="addr">${esc(short(r.owner, 14, 10))}</span><span class="chip chip--approved">identity verified</span></div></dd></div>
    </dl>`;
}

function stageSentence(stage) {
  return {
    new: 'nothing happens without you. Every action becomes a proposal.',
    probation: 'small steps only. Bigger ones still come to you.',
    trusted: 'it may act inside your live on-chain mandate.',
    established: 'the live mandate, plus sharing and more file deletes.',
    restricted: 'held back after violations. Every action comes to you again.',
  }[stage] ?? '';
}

function resumeLimitsCard(r) {
  const m = S.mandate?.mandate ?? null;
  return `<section class="card">
    <div class="card-head">
      <h2 class="card-title">What this stage allows</h2>
      <span class="readout">enforced before the gates</span>
    </div>
    <dl class="facts">
      <div class="fact"><dt>Per call</dt><dd>${esc(spendLimitText(r.profile, m, 'autoSpendPerCall', 'call'))}</dd></div>
      <div class="fact"><dt>Per window</dt><dd>${esc(spendLimitText(r.profile, m, 'autoSpendPerWindow', 'window'))}</dd></div>
      <div class="fact"><dt>File deletes</dt><dd>${r.profile.maxDeletesPerDay === 0 ? 'none without your approval' : `${fmtNum(r.profile.maxDeletesPerDay)} per day`}</dd></div>
      <div class="fact"><dt>Sharing files</dt><dd>${r.profile.canShare ? 'allowed' : 'needs your approval'}</dd></div>
    </dl>
    <p class="hint" style="margin-top:var(--space-3)">These limits sit in front of the spending and files gates, so a block always names the rule that actually stopped it. The chain stays the final authority: an action that passes here can still be refused on-chain.</p>
  </section>`;
}

function spendLimitText(profile, mandate, field, unit) {
  const raw = profile[field];
  if (raw === null) {
    const live = field === 'autoSpendPerCall' ? mandate?.maxPerCall : mandate?.maxPerWindow;
    return live === undefined || live === null
      ? `the live on-chain mandate (chain not read yet)`
      : `the live on-chain mandate (${fmtInt(live)} per ${unit})`;
  }
  if (BigInt(raw) === 0n) return `nothing without your approval`;
  return `${fmtInt(raw)} per ${unit}`;
}

function resumeEvidenceCard(r) {
  const s = r.summary;
  // Track 3: an owner-signed attestation chain explains rotated keys. With one,
  // several witnesses are legitimate history and get a timeline; without one,
  // two witnesses remain the contradiction they always were.
  const attested = (r.witnessHistory ?? []).filter((h) => h.seq > 0);
  const witnessProblem = r.witnesses.length > 1 && attested.length === 0
    ? `<div class="callout callout--danger" style="margin-top:var(--space-4)">
        <strong>These records were signed by ${r.witnesses.length} different app witnesses.</strong>
        <span style="display:block;margin-top:var(--space-1)">One app saw all of this, or the file has been assembled from somewhere else. If the app honestly rotated its key, vouch for the keys below - an owner-signed attestation turns the rotation into legitimate history. Until then: do not promote on it.</span>
      </div>`
    : '';
  const recent = r.recent.length === 0
    ? '<p class="hint" style="margin-top:var(--space-3)">No records yet. The agent has not been through the door.</p>'
    : `<div class="section-head" style="margin-top:var(--space-5)">
        <h2 class="label">The ${r.recent.length} most recent records</h2>
      </div>
      <ul class="effects">${r.recent.slice().reverse().map((rec) => `<li>
          <span class="mono">#${rec.seq}</span> ${outcomeChip(rec.outcome)}
          <span class="mono">${esc(rec.action)}</span>${rec.amount === null || rec.amount === undefined ? '' : ` · ${fmtInt(rec.amount)} units`}
          ${rec.code ? ` · <span class="mono">${esc(rec.code)}</span>` : ''}
          ${rec.reason ? `<span class="hint" style="display:block;margin-top:var(--space-1)">${esc(rec.reason)}</span>` : ''}
        </li>`).join('')}</ul>`;

  return `<div class="section-head" style="margin-top:var(--space-6)">
      <h2 class="label">The evidence behind it</h2>
    </div>
    <div class="summary">
      <div class="summary-item"><p class="label">Records</p><p class="stat-value">${fmtNum(s.total)}</p></div>
      <div class="summary-item"><p class="label">Real clean</p><p class="stat-value">${fmtNum(s.realClean)}</p></div>
      <div class="summary-item"><p class="label">Sandbox</p><p class="stat-value">${fmtNum(s.sandboxClean)}</p></div>
      <div class="summary-item"><p class="label">Violations</p><p class="stat-value">${fmtNum(s.strikes)}</p></div>
    </div>
    <p class="hint" style="margin-top:var(--space-2)">Sandbox records are simulations - no value moved. They count toward the first step only.</p>
    <p class="label" style="margin-top:var(--space-4)">Fingerprint of all ${fmtNum(r.count)} records</p>
    <p class="digest" style="margin-top:var(--space-2)">${esc(r.root)}</p>
    ${attested.length > 0 ? `
      <p class="label" style="margin-top:var(--space-4)">Who spoke for this app</p>
      <ul class="effects" style="margin-top:var(--space-1)">${attested.map((h, i) => `<li>
          <span class="mono">${esc(short(h.witness, 12, 8))}</span>${copyBtn(h.witness, 'witness')}
          ${i === attested.length - 1
            ? '<span class="chip chip--approved">speaks now</span>'
            : '<span class="chip">rotated out</span>'}
          <span class="hint" style="display:block;margin-top:var(--space-1)">since ${esc(when(h.validFrom))}${h.supersedes ? ` · replaced ${esc(short(h.supersedes, 10, 6))}` : ' · the first attested key'} — ${esc(h.reason)}</span>
        </li>`).join('')}</ul>
      <p class="hint" style="margin-top:var(--space-2)">Every key listed carries your signature saying it spoke for the app from that moment. Each record is checked against the key in effect when THAT record was made - a rotated-out key can never sign new facts, and old facts survive the rotation.</p>`
      : r.witnesses.length === 1 ? `
      <p class="label" style="margin-top:var(--space-4)">App witness</p>
      <div class="addr-row" style="margin-top:var(--space-1)"><span class="addr">${esc(r.witnesses[0])}</span>${copyBtn(r.witnesses[0], 'witness')}</div>
      <p class="hint" style="margin-top:var(--space-1)">The app signed these facts. It cannot move money and it cannot change this agent's trust - only your key can.</p>` : ''}
    ${witnessProblem}
    ${recent}`;
}

function resumeAnchorCard(r) {
  const a = r.anchor ?? {};
  let body;
  if (!a.available) {
    body = `<div class="callout callout--danger">
      <strong>The chain did not answer.</strong>
      <span style="display:block;margin-top:var(--space-1)">${esc(a.error ?? 'unknown error')}</span>
    </div>`;
  } else if (a.count === 0) {
    body = `<div class="callout callout--warn">
      <strong>Nothing is anchored yet.</strong>
      <span style="display:block;margin-top:var(--space-1)">The registry has no fingerprint for this agent from your account. Anchor it before signing a promotion, so the change points at something the chain has seen.</span>
    </div>`;
  } else if (a.matchesRoot && a.matchesCount) {
    body = `<div class="callout callout--ok">
      <strong>The chain holds this exact fingerprint.</strong>
      <span class="mono" style="display:block;margin-top:var(--space-1)">root ${esc(short(a.root, 14, 10))} · ${fmtNum(a.count)} records</span>
      ${a.recordedTx ? `<div style="margin-top:var(--space-2)"><a href="${voyager(a.recordedTx)}" target="_blank" rel="noreferrer">Anchor transaction on Voyager</a></div>` : ''}
    </div>`;
  } else {
    body = `<div class="callout callout--warn">
      <strong>The chain holds an older fingerprint.</strong>
      <span style="display:block;margin-top:var(--space-1)">On chain: ${esc(short(a.root, 14, 10))} over ${fmtNum(a.count)} records. Here: ${esc(short(r.root, 14, 10))} over ${fmtNum(r.count)} records. The local records have grown since the last anchor.</span>
    </div>`;
  }

  return `<section class="card">
    <div class="card-head">
      <h2 class="card-title">The chain's copy</h2>
      <span class="readout">read fresh</span>
    </div>
    <dl class="facts">
      <div class="fact"><dt>Registry</dt><dd><div class="addr-row"><span class="addr">${esc(a.registry ?? '—')}</span>${a.registry ? copyBtn(a.registry, 'registry') : ''}</div></dd></div>
      <div class="fact"><dt>Anchored by</dt><dd class="mono">${esc(short(a.anchorer, 14, 10))}</dd></div>
      ${a.available && a.count > 0 ? `<div class="fact"><dt>Anchors in this slot</dt><dd class="mono">${fmtNum(a.anchorCount)}</dd></div>` : ''}
    </dl>
    <div style="margin-top:var(--space-4)">${body}</div>
    <p class="hint" style="margin-top:var(--space-3)">The chain stores only the fingerprint - a root and a count. The full records stay off-chain, and the counts can only move forward.</p>
    <div id="anchor-panel"></div>
  </section>`;
}

function renderAnchorPanel() {
  const el = $('#anchor-panel');
  if (!el || !S.resume?.ok) return;
  const a = S.resume.anchor ?? {};
  const alreadyMatches = a.available && a.matchesRoot && a.matchesCount;
  const nothingToAnchor = S.resume.count === 0;

  if (S.anchorBusy) {
    el.innerHTML = `<p class="hint" style="margin-top:var(--space-4)">${spinner} ${esc(S.anchorStage ?? 'Working…')}</p>`;
    return;
  }
  if (S.anchorError) {
    el.innerHTML = `<div class="callout callout--danger" style="margin-top:var(--space-4)">
      <strong>The anchor did not complete.</strong>
      <span style="display:block;margin-top:var(--space-1)">${esc(S.anchorError)}</span>
    </div>
    <div class="form-actions">
      <button class="btn" type="button" data-action="anchor-retry">Try again</button>
    </div>`;
    return;
  }
  if (S.anchorResult) {
    const out = S.anchorResult;
    el.innerHTML = out.status === 'SUCCEEDED'
      ? `<div class="callout callout--ok" style="margin-top:var(--space-4)">
          <strong>${out.via === 'wallet'
            ? 'Anchored — authorized in your wallet, carried by the server’s gas-only key, and read back from the chain.'
            : 'Anchored by a transaction signed in this tab, and read back from the chain.'}</strong>
          <span class="mono" style="display:block;margin-top:var(--space-1)">tx ${esc(out.tx_hash ?? '')}</span>
          <span style="display:block;margin-top:var(--space-1)">The registry now holds ${esc(short(out.anchor?.root, 14, 10))} over ${fmtNum(out.anchor?.count)} records.</span>
          <div style="margin-top:var(--space-2)"><a href="${voyager(out.tx_hash)}" target="_blank" rel="noreferrer">Open on Voyager</a></div>
        </div>`
      : `<div class="callout callout--danger" style="margin-top:var(--space-4)">
          <strong>The anchor ended ${esc(out.status)}.</strong>
          <span style="display:block;margin-top:var(--space-1)">${esc(out.revert_reason ?? out.message ?? 'no reason returned')}</span>
        </div>`;
    return;
  }
  if (nothingToAnchor) {
    el.innerHTML = '<p class="hint" style="margin-top:var(--space-4)">There is nothing to anchor until the agent has a record.</p>';
    return;
  }
  if (S.wallet?.connecting) {
    el.innerHTML = `<p class="hint" style="margin-top:var(--space-4)">${spinner} Waiting for the wallet — confirm the connection in its window.</p>`;
    return;
  }
  if (planMode() === 'outside') {
    renderAnchorWalletPanel(el, alreadyMatches);
    return;
  }
  const anchorWallets = detectWallets(window);
  // A failed connect (e.g. the wrong-wallet refusal) must stay VISIBLE here -
  // the résumé has no wallet card of its own to show it.
  const walletErrorHtml = S.wallet?.error
    ? `<div class="key-status is-error" style="margin-top:var(--space-3)">${esc(S.wallet.error)}</div>`
    : '';
  const connectHtml = anchorWallets.length
    ? `<div class="form-actions" style="margin-top:var(--space-3)">${anchorWallets.map((wl) => `<button class="btn" type="button" data-wallet-connect="${esc(wl.id)}">Connect ${esc(wl.name)}</button>`).join('')}</div>
       <p class="hint" style="margin-top:var(--space-1)">Or connect your wallet: it authorizes the anchor in its own window — this page never sees a key.</p>`
    : '';
  el.innerHTML = `
    ${walletErrorHtml}
    <div class="field" style="margin-top:var(--space-4)">
      <label for="anchor-key">Owner private key (testnet) — signs the anchor in this tab</label>
      <input class="input" id="anchor-key" type="password" autocomplete="off"
             spellcheck="false" placeholder="0x…" data-1p-ignore data-lpignore="true">
    </div>
    <div id="anchor-key-status" class="key-status is-muted">No key entered.</div>
    <div class="form-actions">
      <button class="btn btn--primary" type="button" id="anchor-send-btn" data-action="anchor"
              data-anchored="${alreadyMatches ? 'true' : 'false'}"${alreadyMatches ? ' disabled' : ''}>
        ${alreadyMatches ? 'Already anchored' : 'Sign and send the anchor'}
      </button>
      <button class="btn btn--quiet" type="button" data-action="forget-anchor-key">Forget key</button>
    </div>
    <p class="hint" style="margin-top:var(--space-2)">Your tab signs this transaction; the server only carries the signed bytes to Starknet and reports the chain's answer. Before signing, this screen checks the server's plan against the fingerprint shown above — a mismatch is a refusal, not a warning. After the receipt confirms, the chain is read back once more before anything is recorded.</p>
    ${connectHtml}`;
  const anchorKeyInput = $('#anchor-key');
  if (anchorKeyInput) {
    anchorKeyInput.addEventListener('input', readAnchorKey);
  }
  renderAnchorKeyStatus();
}

function renderAnchorKeyStatus() {
  const el = $('#anchor-key-status');
  const btn = $('#anchor-send-btn');
  if (!el) return;

  const signer = signerFor('anchor');
  const check = signerCheck('anchor');
  let kind = 'muted';
  let text = 'No key entered.';
  if (signer) {
    if (check?.error) {
      kind = 'error';
      text = check.error;
    } else if (check?.matches) {
      kind = 'ok';
      text = `This key derives to the owner on chain: ${short(check.derived, 12, 8)}`;
    } else {
      kind = 'error';
      text = `This key is not the owner of this account (derived ${short(check?.derived, 10, 6)}). The relay would reject it too.`;
    }
  }
  el.className = `key-status is-${kind}`;
  el.textContent = text;

  if (btn && !btn.disabled) {
    btn.title = check?.matches ? '' : 'Enter the matching owner key first — the anchor is signed in this tab.';
  }
}

function readAnchorKey() {
  const input = $('#anchor-key');
  setSigner('anchor', input?.value.trim() ?? '', S.resume?.owner);
  renderAnchorKeyStatus();
  // The send button's readiness depends on the key, and the panel is not
  // re-rendered on typing - update the button in place.
  const btn = $('#anchor-send-btn');
  if (btn && btn.dataset.anchored !== 'true') {
    btn.disabled = !(signerFor('anchor') && signerCheck('anchor')?.matches);
  }
}

// The anchor's wallet mode: the same trust split as the approvals screen's
// wallet path. The plan comes from the server's live reads (purpose: 'anchor'
// on the outside relay), the wallet signs the SNIP-9 authorization in its own
// window, the server re-verifies every field against the LIVE trust state and
// relays with its gas-only key, and the record is written only after a
// SUCCEEDED receipt AND a fresh registry read-back (/api/anchor/record - the
// same endpoint the pasted-key path uses, unchanged).

function loadAnchorPlanIfNeeded() {
  if (planMode() !== 'outside') return;
  if (!S.resume?.ok || S.resume.count === 0) return;
  const a = S.resume.anchor ?? {};
  if (a.available && a.matchesRoot && a.matchesCount) return; // nothing new to anchor
  if (S.anchorPlan) return;
  if (S.anchorPlanLoading) return;
  S.anchorPlanLoading = true;
  S.anchorPlanError = null;
  renderAnchorPanel();
  api('/api/outside/plan', { purpose: 'anchor' })
    .then((out) => { S.anchorPlan = out; })
    .catch((e) => { S.anchorPlanError = e.message; })
    .finally(() => {
      S.anchorPlanLoading = false;
      renderAnchorPanel();
    });
}

function invalidateAnchorPlan() {
  S.anchorPlan = null;
  S.anchorPlanError = null;
  loadAnchorPlanIfNeeded();
}

function renderAnchorWalletPanel(el, alreadyMatches) {
  const plan = S.anchorPlan;
  const w = S.wallet?.signer ?? null;
  // The client-side mirror of the server's control 1, in plain words: the
  // connected wallet must BE the controller the chain names on this gate.
  const isController = !!w && !!plan && norm(w.address) === norm(plan.controller);

  if (alreadyMatches) {
    el.innerHTML = `<p class="hint" style="margin-top:var(--space-4)">The chain already holds exactly this fingerprint — nothing new to anchor.</p>
      <div class="form-actions" style="margin-top:var(--space-2)"><button class="btn btn--quiet" type="button" data-wallet-disconnect="1">Disconnect wallet</button></div>`;
    return;
  }
  if (S.anchorPlanLoading) {
    el.innerHTML = `<p class="hint" style="margin-top:var(--space-4)">${spinner} Re-reading the signed records and drawing a fresh one-shot nonce…</p>`;
    return;
  }
  if (S.anchorPlanError) {
    el.innerHTML = `<div class="callout callout--danger" style="margin-top:var(--space-4)"><strong>Cannot plan the anchor.</strong> ${esc(S.anchorPlanError)}</div>
      <div class="form-actions" style="margin-top:var(--space-2)">
        <button class="btn" type="button" data-action="anchor-replan">Try again</button>
        <button class="btn btn--quiet" type="button" data-action="anchor-wallet-off">Disconnect and use a pasted key</button>
      </div>`;
    return;
  }
  if (!plan) {
    el.innerHTML = '<p class="hint" style="margin-top:var(--space-4)">Checking the signed records…</p>';
    loadAnchorPlanIfNeeded();
    return;
  }

  let statusHtml;
  if (!isController) {
    statusHtml = `<div class="key-status is-error">Wrong wallet: ${esc(w?.walletName ?? 'the wallet')} (${esc(short(w?.address ?? '', 10, 6))}) is NOT the controller this gate names on chain (${esc(short(plan.controller, 10, 6))}). Only the controller's signature can authorize this gate — the server would refuse it too.</div>
      <div class="form-actions" style="margin-top:var(--space-2)"><button class="btn btn--quiet" type="button" data-wallet-disconnect="1">Disconnect wallet</button></div>`;
  } else {
    statusHtml = `<div class="key-status is-ok">${esc(w.walletName ?? 'Wallet')} · ${esc(short(w.address, 10, 6))} — the chain names this wallet as the gate's controller. Its signature can authorize this anchor.</div>
      <div class="form-actions" style="margin-top:var(--space-2)"><button class="btn btn--quiet" type="button" data-action="anchor-wallet-off">Disconnect and use a pasted key</button></div>`;
  }

  // The plan must bind the fingerprint THIS screen shows - a mismatch is a
  // refusal, not a warning (the same binding the pasted-key path checks).
  const binds = !!S.resume && norm(plan.root) === norm(S.resume.root)
    && plan.count === S.resume.count;
  const ready = isController && binds && !S.anchorBusy;

  el.innerHTML = `
    ${(plan.calls ?? []).map((c) => `<pre class="code-card" style="margin-top:var(--space-4)"><code><span class="k">to</span>       <span class="v">${esc(c.to)}</span>
<span class="k">entry</span>    <span class="v">${esc(c.selector)}</span>
<span class="k">calldata</span> <span class="a">[${(c.calldata ?? []).map(esc).join(', ')}]</span></code></pre>`).join('')}
    ${binds ? '' : '<div class="key-status is-error" style="margin-top:var(--space-2)">The plan does not bind the fingerprint shown above. Refusing to ask for a signature.</div>'}

    <p class="label" style="margin-top:var(--space-4)">The authorization your wallet will sign</p>
    <pre class="code-card"><code><span class="k">chain</span>      <span class="v">${esc(plan.chainId)}</span>
<span class="k">caller</span>     <span class="v">${esc(plan.caller)} — anyone may carry it to the chain; this server will, with its gas-only key</span>
<span class="k">nonce</span>      <span class="v">${esc(plan.nonce)} — one-shot; the chain burns it on use, so this can never replay</span>
<span class="k">valid</span>      <span class="v">from ${esc(fmtUnix(plan.executeAfter))} until ${esc(fmtUnix(plan.executeBefore))}</span>
<span class="k">gate</span>       <span class="v">${esc(plan.gate)}</span>
<span class="k">controller</span> <span class="v">${esc(plan.controller)}${plan.controllerPublicKey ? ` (key ${esc(short(plan.controllerPublicKey, 12, 8))}, read from the chain)` : ''}</span>
<span class="k">relayer</span>    <span class="v">${esc(plan.relayer ?? 'the server')} — gas only; this key has no authority over your records</span></code></pre>
    ${plan.note ? `<p class="hint" style="margin-top:var(--space-2)">${esc(plan.note)}</p>` : ''}

    <div style="margin-top:var(--space-4)">${statusHtml}</div>
    <div class="form-actions">
      <button class="btn btn--primary" type="button" id="anchor-send-btn" data-action="anchor"${ready ? '' : ' disabled'}>${S.anchorBusy ? `${spinner} Waiting for the wallet…` : 'Sign in wallet and send the anchor'}</button>
    </div>
    <p class="hint" style="margin-top:var(--space-3)">Your wallet signs an authorization for this exact anchor call — this page never sees a key. The server re-checks everything against the chain (the call rebuilt from the LIVE trust state, the signature against the controller's chain-read key, the nonce unused, the window open) and carries it with a gas-only key. The record is written only after a SUCCEEDED receipt AND one more read of the registry.</p>`;
}

async function onAnchorOutside() {
  const plan = S.anchorPlan;
  const w = S.wallet?.signer;
  if (!w || !plan || S.anchorBusy) return;
  // Plain-words mirrors of the two bindings, checked before the popup: the
  // wallet must be the chain-named controller, and the plan must bind the
  // fingerprint this screen shows.
  if (norm(w.address) !== norm(plan.controller)) {
    S.anchorError = `Wrong wallet: ${w.walletName ?? 'the wallet'} (${short(w.address, 10, 6)}) is not the controller this gate names on chain (${short(plan.controller, 10, 6)}). Only the controller's signature can authorize this gate.`;
    renderAnchorPanel();
    return;
  }
  if (!S.resume || norm(plan.root) !== norm(S.resume.root) || plan.count !== S.resume.count) {
    S.anchorError = 'The anchor plan does not bind the fingerprint shown on this screen. Refusing to ask for a signature.';
    renderAnchorPanel();
    return;
  }
  S.anchorBusy = true;
  S.anchorError = null;
  S.anchorResult = null;
  S.anchorStage = 'Waiting for your wallet — confirm the authorization in its window…';
  renderAnchorPanel();
  try {
    const authorization = await w.authorizeCalls({
      chainId: plan.chainId,
      caller: plan.caller,
      nonce: plan.nonce,
      executeAfter: plan.executeAfter,
      executeBefore: plan.executeBefore,
      calls: plan.calls,
    });
    S.anchorStage = 'Handing the signed authorization to the relay…';
    renderAnchorPanel();
    const out = await api('/api/outside/submit', { purpose: 'anchor', authorization });
    if (!out.relayed || !out.txHash) {
      throw new Error(out.message ?? 'the relay did not carry the authorization');
    }
    const txHash = out.txHash;
    S.anchorStage = `Relayed. tx ${txHash} — waiting for the chain to confirm…`;
    renderAnchorPanel();
    const receipt = await pollReceipt(txHash);
    if (!receipt) {
      throw new Error(`The chain had not confirmed tx ${txHash} within two minutes. Nothing was recorded - that only happens with a SUCCEEDED receipt. "Read again" keeps looking.`);
    }
    if (receipt.execution_status !== 'SUCCEEDED') {
      throw new Error(`The anchor transaction ended ${receipt.execution_status}: ${receipt.revert_reason ?? 'no reason returned'}`);
    }
    S.anchorStage = 'Confirmed - asking the chain to show the fingerprint before recording…';
    renderAnchorPanel();
    const recorded = await api('/api/anchor/record', {
      tx_hash: txHash,
      agentId: plan.agentId,
      root: plan.root,
      count: plan.count,
    });
    S.flash = {
      kind: 'ok',
      text: `Fingerprint anchored — authorized in your wallet, carried by the server's gas-only key. tx ${txHash}`,
    };
    await loadResume(true);
    S.anchorResult = { status: 'SUCCEEDED', tx_hash: txHash, anchor: recorded.anchor, via: 'wallet' };
    // The plan just became stale by definition: the chain holds this exact
    // fingerprint now. Drop it; a refresh re-plans when there is new evidence.
    S.anchorPlan = null;
    S.anchorPlanError = null;
  } catch (e) {
    S.anchorError = e.message;
    // A stale window or a burned nonce means the PLAN went stale: drop it so
    // the next render re-plans with a fresh nonce and window.
    if (/window|nonce/i.test(e.message)) {
      S.anchorPlan = null;
      S.anchorPlanError = null;
    }
  } finally {
    S.anchorBusy = false;
    S.anchorStage = null;
    render();
  }
}

async function onAnchor() {
  // A connected wallet chooses the mode, exactly like the approvals screen:
  // the wallet authorizes, the server re-verifies and relays.
  if (planMode() === 'outside') {
    await onAnchorOutside();
    return;
  }
  if (S.anchorBusy) return;
  const signer = signerFor('anchor');
  if (!signerCheck('anchor')?.matches) {
    S.anchorError = 'Enter the owner key first. The anchor is signed in this tab, and the relay checks the signature against the owner key on chain.';
    renderAnchorPanel();
    return;
  }
  S.anchorBusy = true;
  S.anchorError = null;
  S.anchorResult = null;
  S.anchorStage = 'Reading the signed records and pricing the anchor…';
  renderAnchorPanel();
  try {
    const plan = await api('/api/anchor/plan', {});

    // The plan must bind the fingerprint THIS screen shows, from the account
    // THIS console reads. A mismatch is a refusal, not a warning.
    if (!S.resume || norm(plan.root) !== norm(S.resume.root)
      || plan.count !== S.resume.count) {
      throw new Error('The anchor plan does not bind the fingerprint shown on this screen. Refusing to sign.');
    }
    if (S.mandate?.gate && norm(plan.sender) !== norm(S.mandate.gate)) {
      throw new Error('The plan does not come from the GateAccount this console reads. Refusing to sign.');
    }

    S.anchorStage = 'Signing the anchor transaction in this tab…';
    renderAnchorPanel();
    const built = buildInvokeTx({
      sender: plan.sender,
      calls: plan.calls,
      nonce: plan.nonce,
      resourceBounds: plan.resourceBounds,
      chainId: plan.chainIdFelt,
      tip: 0,
    });
    const { body } = signer.signInvoke(built, built.body);

    S.anchorStage = 'Handing the signed bytes to the relay…';
    renderAnchorPanel();
    const out = await api('/api/broadcast', { transaction: body });
    const txHash = out.result.transaction_hash;
    S.signers.anchor = null;
    if (norm(txHash) !== norm(built.hash)) {
      throw new Error(`The node reported tx ${txHash}, but this tab signed ${built.hash}. That is not the transaction you signed - nothing was recorded; treat the relay as hostile.`);
    }

    S.anchorStage = `Relayed. tx ${txHash} — waiting for the chain to confirm…`;
    renderAnchorPanel();
    const receipt = await pollReceipt(txHash);
    if (!receipt) {
      throw new Error(`The chain had not confirmed tx ${txHash} within two minutes. Nothing was recorded - that only happens with a SUCCEEDED receipt. "Read again" keeps looking.`);
    }
    if (receipt.execution_status !== 'SUCCEEDED') {
      throw new Error(`The anchor transaction ended ${receipt.execution_status}: ${receipt.revert_reason ?? 'no reason returned'}`);
    }

    S.anchorStage = 'Confirmed - asking the chain to show the fingerprint before recording…';
    renderAnchorPanel();
    const recorded = await api('/api/anchor/record', {
      tx_hash: txHash,
      agentId: plan.agentId,
      root: plan.root,
      count: plan.count,
    });
    S.anchorResult = { status: 'SUCCEEDED', tx_hash: txHash, anchor: recorded.anchor };
    S.flash = {
      kind: 'ok',
      text: `Fingerprint anchored by a transaction signed in this tab. tx ${txHash}`,
    };
    await loadResume(true);
    S.anchorResult = { status: 'SUCCEEDED', tx_hash: txHash, anchor: recorded.anchor };
  } catch (e) {
    S.anchorError = e.message;
  } finally {
    S.anchorBusy = false;
    S.anchorStage = null;
    render();
  }
}

function resumeHistoryCard(r) {
  const applied = new Set(r.applied);
  const rejected = new Map(r.rejected.map((x) => [x.seq, x.reason]));

  const rows = r.changes.length === 0
    ? '<p class="hint">No ladder change has ever been signed. The agent is where it started.</p>'
    : r.changes.map((c) => {
      const state = applied.has(c.seq) ? 'applied'
        : rejected.has(c.seq) ? 'rejected' : 'not-reached';
      const chip = state === 'applied'
        ? '<span class="chip chip--approved">applied</span>'
        : state === 'rejected'
          ? '<span class="chip chip--danger">rejected</span>'
          : '<span class="chip chip--plain">not reached</span>';
      return `<div style="margin-top:var(--space-5)">
        <div class="section-head">
          <h2 class="label">Step ${c.seq} · ${esc(c.from)} → ${esc(c.to)}</h2>
          ${chip}
        </div>
        <dl class="facts">
          <div class="fact"><dt>Signed</dt><dd>${esc(when(c.at))}</dd></div>
          <div class="fact"><dt>Reason</dt><dd>${esc(c.reason)}</dd></div>
          <div class="fact"><dt>Bound evidence</dt><dd class="mono">${esc(short(c.evidenceRoot, 14, 10))} · ${fmtNum(c.evidenceCount)} records</dd></div>
          <div class="fact"><dt>Digest</dt><dd><p class="digest">${esc(c.digest)}</p></dd></div>
          <div class="fact"><dt>Signature</dt><dd>${c.verified ? '<span class="chip chip--approved">verifies against the chain owner key</span>' : '<span class="chip chip--danger">does not verify</span>'}</dd></div>
        </dl>
        ${state === 'rejected' ? `<div class="callout callout--danger" style="margin-top:var(--space-3)"><strong>This change was refused.</strong> ${esc(rejected.get(c.seq))}</div>` : ''}
        ${state === 'not-reached' ? '<p class="hint" style="margin-top:var(--space-3)">An earlier change was refused, so this one was never considered. Later steps cannot be trusted if the one before them is broken.</p>' : ''}
      </div>`;
    }).join('');

  return `<section class="card">
    <div class="card-head">
      <h2 class="card-title">How it got here</h2>
      <span class="readout">${r.changes.length} signed</span>
    </div>
    ${rows}
  </section>`;
}

function initLadderForm(r) {
  const to = r.suggestion?.to ?? r.transitions[0] ?? null;
  S.ladderForm = {
    stage: r.stage,
    to,
    reason: r.suggestion?.reason ?? '',
  };
  S.ladderPreview = null;
  S.ladderPreviewError = null;
}

function resumeNextStepCard(r) {
  const options = r.transitions.map((t) => `
    <option value="${esc(t)}"${S.ladderForm.to === t ? ' selected' : ''}>${esc(t)}${r.suggestion?.to === t ? ' — the evidence supports this' : ''}</option>`).join('');

  return `<section class="card">
    <div class="card-head">
      <h2 class="card-title">Move this agent</h2>
      <span class="readout">your signature only</span>
    </div>
    <div id="action-error" hidden></div>

    ${r.suggestion
      ? `<div class="callout callout--ok" style="margin-bottom:var(--space-4)">
          <strong>The evidence supports one step: ${esc(r.suggestion.to)}.</strong>
          <span style="display:block;margin-top:var(--space-1)">${esc(r.suggestion.reason)}. Nothing moves until you sign it.</span>
        </div>`
      : `<p class="hint" style="margin-bottom:var(--space-4)">The evidence does not support another step yet. You can still move this agent yourself - the ladder suggests, it never decides.</p>`}

    ${r.count === 0
      ? '<div class="callout callout--warn"><strong>Nothing to sign yet.</strong> A ladder change must bind at least one signed record, and this agent has none.</div>'
      : `<div class="field">
          <label for="ladder-to">Move to</label>
          <select class="select" id="ladder-to">${options}</select>
          <p class="field-hint">Only the moves this stage legally allows are listed.</p>
        </div>
        <div class="field">
          <label for="ladder-reason">Why</label>
          <input class="input" id="ladder-reason" value="${esc(S.ladderForm.reason)}"
                 spellcheck="true" autocomplete="off" placeholder="A plain sentence you would stand behind">
          <p class="field-hint">This is signed with the change and shown to anyone who reads the ladder later.</p>
        </div>
        <div class="form-actions">
          <button class="btn" type="button" id="ladder-preview-btn">Preview the exact change</button>
        </div>`}

    <section class="card card--inset" id="ladder-preview-panel" style="margin-top:var(--space-5)"></section>

    <section style="margin-top:var(--space-5)">
      <div class="card-head">
        <h2 class="card-title">Sign with the owner key</h2>
        <span class="readout">stays in this tab</span>
      </div>
      <p class="hint">Paste the testnet owner private key. It is used in this browser only and never sent to the server. The server receives the signature, not the key.</p>
      <div class="field" style="margin-top:var(--space-3)">
        <label for="resume-key">Owner private key (testnet)</label>
        <input class="input" id="resume-key" type="password" autocomplete="off"
               spellcheck="false" placeholder="0x…" data-1p-ignore data-lpignore="true">
      </div>
      <div id="ladder-key-status" class="key-status is-muted">No key entered.</div>
      <div class="form-actions">
        <button class="btn btn--primary" type="button" id="ladder-sign-btn" disabled>Sign the ladder change</button>
        <button class="btn btn--quiet" type="button" id="ladder-forget-btn">Forget key</button>
      </div>
      <p class="hint" style="margin-top:var(--space-3)">The browser recomputes the digest from the change it is about to sign. If that differs from the server's, it refuses. The server then checks the signature against the owner key it reads from the chain, and re-checks that the change still binds the evidence that exists right now.</p>
    </section>
  </section>`;
}

function initWitnessForm(r) {
  const history = r.witnessHistory ?? [];
  S.witnessForm = {
    agentId: r.identity.agentId,
    // The first attestation normally makes official the ONE key the records
    // already carry, so prefill it. A rotation names a NEW key - prefilling
    // the current one would only invite the server's "nothing to rotate".
    witness: history.length === 0 && r.witnesses.length === 1 ? r.witnesses[0] : '',
    reason: '',
  };
  S.witnessPreview = null;
  S.witnessPreviewError = null;
}

// The owner's control over WHO speaks for the app (Track 3). Same shape as the
// ladder card: the form supplies only the key and a plain-sentence reason; the
// server builds the exact attestation (agent, seq, the key it replaces, the
// timestamps, the owner) from the signed state; the browser recomputes the
// digest itself and refuses to sign on any mismatch.
function resumeWitnessCard(r) {
  const history = r.witnessHistory ?? [];
  const first = history.length === 0;
  const current = first ? null : history[history.length - 1];

  return `<section class="card">
    <div class="card-head">
      <h2 class="card-title">${first ? 'Vouch for the app witness' : 'Rotate the app witness'}</h2>
      <span class="readout">your signature only</span>
    </div>
    <div id="witness-action-error" hidden></div>

    <p class="hint" style="margin-bottom:var(--space-4)">${first
      ? 'The app signs its records with a witness key. An attestation is your signature on one plain sentence: "this key speaks for this app, from this moment." It turns the key the records already carry into a fact you vouched for - and it is what makes a future key rotation legitimate history instead of a red flag.'
      : `The current attested key is <span class="mono">${esc(short(current.witness, 12, 8))}</span>. Name the key that replaces it and say why. Records made under the old key stay covered - a rotation explains history, it never rewrites it.`}</p>

    <div class="field">
      <label for="witness-new-key">${first ? 'The witness key to vouch for' : 'The new witness key'}</label>
      <input class="input" id="witness-new-key" value="${esc(S.witnessForm.witness)}"
             spellcheck="false" autocomplete="off" placeholder="0x…">
      <p class="field-hint">The app witness PUBLIC key - the one that signs records. Never a private key.</p>
    </div>
    <div class="field">
      <label for="witness-reason">Why</label>
      <input class="input" id="witness-reason" value="${esc(S.witnessForm.reason)}"
             spellcheck="true" autocomplete="off" placeholder="A plain sentence you would stand behind">
      <p class="field-hint">Signed with the attestation and shown to anyone who reads the witness history later.</p>
    </div>
    <div class="form-actions">
      <button class="btn" type="button" id="witness-preview-btn">Preview the exact attestation</button>
    </div>

    <section class="card card--inset" id="witness-preview-panel" style="margin-top:var(--space-5)"></section>

    <section style="margin-top:var(--space-5)">
      <div class="card-head">
        <h2 class="card-title">Sign with the owner key</h2>
        <span class="readout">stays in this tab</span>
      </div>
      <p class="hint">Connect your wallet in the anchor card above, or paste the testnet owner private key. A pasted key is used in this browser only and never sent to the server. The server receives the signature, not the key.</p>
      <div class="field" style="margin-top:var(--space-3)">
        <label for="witness-owner-key">Owner private key (testnet)</label>
        <input class="input" id="witness-owner-key" type="password" autocomplete="off"
               spellcheck="false" placeholder="0x…" data-1p-ignore data-lpignore="true">
      </div>
      <div id="witness-key-status" class="key-status is-muted">No key entered.</div>
      <div class="form-actions">
        <button class="btn btn--primary" type="button" id="witness-sign-btn" disabled>Sign the attestation</button>
        <button class="btn btn--quiet" type="button" id="witness-forget-btn">Forget key</button>
      </div>
      <p class="hint" style="margin-top:var(--space-3)">The browser recomputes the digest from the attestation it is about to sign. If that differs from the server's, it refuses. The server then checks the signature against the owner key it reads from the chain - and re-checks that no signed record is left uncovered by the witness history.</p>
    </section>
  </section>`;
}

function profileDiffHtml(before, after) {
  const rows = [
    ['Per call', spendLimitText(before, null, 'autoSpendPerCall', 'call'), spendLimitText(after, null, 'autoSpendPerCall', 'call')],
    ['Per window', spendLimitText(before, null, 'autoSpendPerWindow', 'window'), spendLimitText(after, null, 'autoSpendPerWindow', 'window')],
    ['File deletes', before.maxDeletesPerDay === 0 ? 'none' : `${before.maxDeletesPerDay} per day`, after.maxDeletesPerDay === 0 ? 'none' : `${after.maxDeletesPerDay} per day`],
    ['Sharing files', before.canShare ? 'allowed' : 'needs approval', after.canShare ? 'allowed' : 'needs approval'],
  ];
  return `<dl class="facts">
    ${rows.map(([label, was, now]) => `<div class="fact">
      <dt>${esc(label)}</dt>
      <dd>${esc(was) === esc(now)
        ? esc(now)
        : `<span class="mono">${esc(was)}</span> → <strong>${esc(now)}</strong>`}</dd>
    </div>`).join('')}
  </dl>`;
}

function ladderPreviewIsCurrent() {
  if (!S.ladderPreview || !S.ladderForm || !S.resume?.ok) return false;
  return S.ladderPreview.fingerprint === ladderFingerprint();
}

function ladderFingerprint() {
  const r = S.resume;
  return JSON.stringify({
    to: S.ladderForm?.to ?? null,
    reason: String(S.ladderForm?.reason ?? '').trim(),
    seq: (r?.changes?.length ?? 0) + 1,
    root: r?.root ?? null,
    count: r?.count ?? 0,
  });
}

async function onLadderPreview() {
  const r = S.resume;
  if (!r?.ok || !S.ladderForm) return;
  S.busy = 'ladder-preview';
  S.ladderPreviewError = null;
  S.ladderPreview = null;
  renderLadderPreview();
  try {
    const out = await api('/api/ladder/preview', {
      from: r.stage,
      to: S.ladderForm.to,
      reason: String(S.ladderForm.reason ?? '').trim(),
    });
    const localDigest = ladderChangeDigest(out.change);
    S.ladderPreview = {
      ...out,
      localDigest,
      matches: localDigest === out.digest,
      fingerprint: ladderFingerprint(),
    };
  } catch (e) {
    S.ladderPreviewError = e.message;
  } finally {
    S.busy = null;
    renderLadderPreview();
    renderLadderKeyStatus();
  }
}

function renderLadderPreview() {
  const el = $('#ladder-preview-panel');
  if (!el) return;
  if (S.busy === 'ladder-preview') {
    el.innerHTML = `<p class="hint">${spinner} Re-reading the signed records and building the exact change…</p>`;
    return;
  }
  if (S.ladderPreviewError) {
    el.innerHTML = `<div class="callout callout--danger"><strong>No preview.</strong> ${esc(S.ladderPreviewError)}</div>`;
    return;
  }
  if (!S.ladderPreview || !ladderPreviewIsCurrent()) {
    el.innerHTML = '<p class="hint">Nothing is signed yet. Preview the exact change first - the digest, the records it binds and what the new stage would allow.</p>';
    return;
  }

  const pv = S.ladderPreview;
  const c = pv.change;
  const anchored = S.resume.anchor?.available
    && BigInt(S.resume.anchor.root) === BigInt(c.evidenceRoot)
    && S.resume.anchor.count === c.evidenceCount;

  el.innerHTML = `<div class="card-head">
      <h2 class="card-title">What you are about to sign</h2>
      <span class="chip ${pv.matches ? 'chip--approved' : 'chip--danger'}">${pv.matches ? 'digest match' : 'digest mismatch'}</span>
    </div>
    ${pv.matches ? '' : '<div class="callout callout--danger"><strong>Refusing to sign.</strong> The browser and the server computed different digests from the same change. That is a bug, not a warning.</div>'}

    <p class="label" style="margin-top:var(--space-3)">Digest · the fingerprint of exactly what you sign</p>
    <p class="digest" style="margin-top:var(--space-2)">${esc(pv.digest)}</p>
    <p class="hint" style="margin-top:var(--space-2)">The browser recomputed this from the change itself: <span class="mono">${esc(short(pv.localDigest, 12, 10))}</span> — ${pv.matches ? 'identical.' : 'DIFFERENT. Do not sign.'}</p>

    <pre class="code-card" style="margin-top:var(--space-4)"><code><span class="k">move</span>     <span class="v">${esc(c.from)} → ${esc(c.to)}</span>
<span class="k">seq</span>      <span class="v">${esc(c.seq)}</span>
<span class="k">reason</span>   <span class="v">${esc(c.reason)}</span>
<span class="k">binds</span>    <span class="a">${esc(c.evidenceCount)} records</span>
<span class="k">root</span>     <span class="a">${esc(c.evidenceRoot)}</span>
<span class="k">owner</span>    <span class="v">${esc(short(c.owner, 14, 10))}</span></code></pre>

    ${pv.earned ? '' : `<div class="callout callout--warn" style="margin-top:var(--space-4)">
      <strong>The evidence has not earned this step.</strong>
      <span style="display:block;margin-top:var(--space-1)">${pv.suggestion
        ? `The records support ${esc(pv.suggestion.to)} (${esc(pv.suggestion.reason)}), not ${esc(c.to)}.`
        : 'The records support no step at all right now.'} You are overriding the suggestion, which is your right - the ladder only suggests.</span>
    </div>`}

    ${anchored ? '' : `<div class="callout callout--warn" style="margin-top:var(--space-4)">
      <strong>This fingerprint is not on chain yet.</strong>
      <span style="display:block;margin-top:var(--space-1)">The change still binds it, and the signatures still hold. But anchoring first means a third party can check the fingerprint against Starknet later.</span>
    </div>`}

    <p class="label" style="margin-top:var(--space-4)">What changes</p>
    ${profileDiffHtml(pv.before, pv.after)}`;
}

function renderLadderKeyStatus() {
  const el = $('#ladder-key-status');
  const btn = $('#ladder-sign-btn');
  if (!el) return;

  const signer = signerFor('ladder');
  const check = signerCheck('ladder');
  let kind = 'muted';
  let text = 'No key entered.';
  if (signer) {
    if (check?.error) {
      kind = 'error';
      text = check.error;
    } else if (check?.matches) {
      kind = 'ok';
      text = `This key derives to the owner on chain: ${short(check.derived, 12, 8)}`;
    } else {
      kind = 'error';
      text = `This key is not the owner of this account (derived ${short(check?.derived, 10, 6)}). The server would reject it too.`;
    }
  }
  el.className = `key-status is-${kind}`;
  el.textContent = text;

  if (btn) {
    const ready = !!signer && !!check?.matches && ladderPreviewIsCurrent()
      && S.ladderPreview?.matches === true && S.busy !== 'ladder-apply';
    btn.disabled = !ready;
    btn.title = ready ? '' : 'Preview the change and enter the matching owner key first.';
    btn.innerHTML = S.busy === 'ladder-apply' ? `${spinner} Signing…` : 'Sign the ladder change';
  }
}

function readResumeKey() {
  const input = $('#resume-key');
  setSigner('ladder', input?.value.trim() ?? '', S.resume?.owner);
  renderLadderKeyStatus();
}

// Every signing screen goes through these three. The screen never holds a key;
// it holds a Signer (web/signers.js) and asks whether it is the right one.
function setSigner(slot, key, chainOwner) {
  S.signers[slot] = signerForInput(key, chainOwner);
}

function signerFor(slot) {
  return S.signers[slot]?.signer ?? null;
}

function signerCheck(slot) {
  return S.signers[slot]?.check ?? null;
}

async function onLadderSign() {
  const signer = signerFor('ladder');
  if (!S.ladderPreview || !signer) return;
  if (!ladderPreviewIsCurrent()) {
    S.ladderPreview = null;
    S.ladderPreviewError = 'The change or the records moved after the preview. Preview it again before signing.';
    renderLadderPreview();
    renderLadderKeyStatus();
    return;
  }
  if (!signerCheck('ladder')?.matches) {
    showActionError('The key in this tab does not match the owner key on chain. The server would reject the signature.');
    return;
  }
  const localDigest = ladderChangeDigest(S.ladderPreview.change);
  if (localDigest !== S.ladderPreview.digest) {
    showActionError('The browser and the server computed different digests. Refusing to sign.');
    return;
  }
  if (!S.mandate?.chainId || !S.mandate?.gate) {
    showActionError('The live account is not loaded. Reload the mandate before signing.');
    return;
  }

  S.busy = 'ladder-apply';
  showActionError(null);
  renderLadderKeyStatus();
  try {
    const signature = await signer.signMandateAction({
      chainId: S.mandate.chainId,
      accountAddress: S.mandate.gate,
      kind: 'ladder-change',
      digest: localDigest,
      note: ladderNote(S.ladderPreview.change),
    });
    const out = await api('/api/ladder/apply', {
      change: S.ladderPreview.change,
      signature,
    });
    S.resume = out.resume;
    // A pasted key is forgotten the moment it has signed. A connected wallet
    // holds no key material, so its slot stays armed for the next change.
    if (signer !== S.wallet?.signer) S.signers.ladder = null;
    S.ladderPreview = null;
    S.ladderPreviewError = null;
    S.ladderForm = null;
    S.anchorResult = null;
    S.anchorError = null;
    // The résumé just changed under us - an anchor plan drawn against the old
    // snapshot no longer binds what this screen shows. Drop it; re-planned lazily.
    S.anchorPlan = null;
    S.anchorPlanError = null;
    S.flash = {
      kind: 'ok',
      text: `Step ${out.applied} recorded. The signature verified against the owner key on chain, and the change binds the evidence that exists.`,
    };
    S.busy = null;
    render();
  } catch (e) {
    S.busy = null;
    renderLadderKeyStatus();
    showActionError(e.message);
  }
}

// ------------------------------------------------------- witness attestation

// The witness flow is the ladder flow's twin: preview (the server builds the
// exact attestation) -> local digest recomputation -> owner signature -> apply.
// The fingerprint invalidates the preview the moment the form or the signed
// records move, exactly like ladderFingerprint does for the ladder.

function witnessFingerprint() {
  const r = S.resume;
  return JSON.stringify({
    witness: String(S.witnessForm?.witness ?? '').trim().toLowerCase(),
    reason: String(S.witnessForm?.reason ?? '').trim(),
    seq: (r?.witnessHistory?.length ?? 0) + 1,
    count: r?.count ?? 0,
    root: r?.root ?? null,
  });
}

function witnessPreviewIsCurrent() {
  if (!S.witnessPreview || !S.witnessForm || !S.resume?.ok) return false;
  return S.witnessPreview.fingerprint === witnessFingerprint();
}

function invalidateWitnessPreview() {
  if (S.witnessPreview || S.witnessPreviewError) {
    S.witnessPreview = null;
    S.witnessPreviewError = null;
    renderWitnessPreview();
    renderWitnessKeyStatus();
  }
}

async function onWitnessPreview() {
  const r = S.resume;
  if (!r?.ok || !S.witnessForm) return;
  S.busy = 'witness-preview';
  S.witnessPreviewError = null;
  S.witnessPreview = null;
  renderWitnessPreview();
  try {
    const out = await api('/api/witness/preview', {
      witness: String(S.witnessForm.witness ?? '').trim(),
      reason: String(S.witnessForm.reason ?? '').trim(),
    });
    const localDigest = witnessAttestationDigest(out.attestation);
    S.witnessPreview = {
      ...out,
      localDigest,
      matches: localDigest === out.digest,
      fingerprint: witnessFingerprint(),
    };
  } catch (e) {
    S.witnessPreviewError = e.message;
  } finally {
    S.busy = null;
    renderWitnessPreview();
    renderWitnessKeyStatus();
  }
}

function renderWitnessPreview() {
  const el = $('#witness-preview-panel');
  if (!el) return;
  if (S.busy === 'witness-preview') {
    el.innerHTML = `<p class="hint">${spinner} Re-reading the signed records and building the exact attestation…</p>`;
    return;
  }
  if (S.witnessPreviewError) {
    el.innerHTML = `<div class="callout callout--danger"><strong>No preview.</strong> ${esc(S.witnessPreviewError)}</div>`;
    return;
  }
  if (!S.witnessPreview || !witnessPreviewIsCurrent()) {
    el.innerHTML = '<p class="hint">Nothing is signed yet. Preview the exact attestation first - the digest, the key it vouches for and the moment it takes effect.</p>';
    return;
  }

  const pv = S.witnessPreview;
  const a = pv.attestation;
  el.innerHTML = `<div class="card-head">
      <h2 class="card-title">What you are about to sign</h2>
      <span class="chip ${pv.matches ? 'chip--approved' : 'chip--danger'}">${pv.matches ? 'digest match' : 'digest mismatch'}</span>
    </div>
    ${pv.matches ? '' : '<div class="callout callout--danger"><strong>Refusing to sign.</strong> The browser and the server computed different digests from the same attestation. That is a bug, not a warning.</div>'}

    <p class="label" style="margin-top:var(--space-3)">Digest · the fingerprint of exactly what you sign</p>
    <p class="digest" style="margin-top:var(--space-2)">${esc(pv.digest)}</p>
    <p class="hint" style="margin-top:var(--space-2)">The browser recomputed this from the attestation itself: <span class="mono">${esc(short(pv.localDigest, 12, 10))}</span> — ${pv.matches ? 'identical.' : 'DIFFERENT. Do not sign.'}</p>

    <pre class="code-card" style="margin-top:var(--space-4)"><code><span class="k">vouch</span>    <span class="v">${esc(short(a.witness, 14, 10))}</span>
<span class="k">agent</span>    <span class="v">${esc(short(a.agentId, 14, 10))}</span>
<span class="k">seq</span>      <span class="v">${esc(a.seq)}</span>
<span class="k">replaces</span> <span class="v">${a.supersedes ? esc(short(a.supersedes, 14, 10)) : 'nothing - the first attested key'}</span>
<span class="k">from</span>     <span class="a">${esc(when(a.validFrom))}</span>
<span class="k">reason</span>   <span class="v">${esc(a.reason)}</span>
<span class="k">owner</span>    <span class="v">${esc(short(a.owner, 14, 10))}</span></code></pre>

    <p class="hint" style="margin-top:var(--space-3)">The form supplied the key and the reason. Everything else - the sequence number, the key this replaces, the timestamps, the owner - was filled in by the server from the signed state, so the attestation says what IS, not what the form claims. Signing it says: from that moment, this key speaks for the app.</p>`;
}

function renderWitnessKeyStatus() {
  const el = $('#witness-key-status');
  const btn = $('#witness-sign-btn');
  if (!el) return;

  const signer = signerFor('witness');
  const check = signerCheck('witness');
  const isWallet = !!signer && signer === S.wallet?.signer;
  let kind = 'muted';
  let text = 'No key entered.';
  if (signer) {
    if (check?.error) {
      kind = 'error';
      text = check.error;
    } else if (check?.matches) {
      kind = 'ok';
      text = isWallet
        ? `Connected wallet (${S.wallet?.info?.name ?? 'wallet'}) - the chain says its key is this account's owner.`
        : `This key derives to the owner on chain: ${short(check.derived, 12, 8)}`;
    } else {
      kind = 'error';
      text = isWallet
        ? 'The connected wallet does not hold the owner key on chain. The server would reject its signature.'
        : `This key is not the owner of this account (derived ${short(check?.derived, 10, 6)}). The server would reject it too.`;
    }
  }
  el.className = `key-status is-${kind}`;
  el.textContent = text;

  if (btn) {
    const ready = !!signer && !!check?.matches && witnessPreviewIsCurrent()
      && S.witnessPreview?.matches === true && S.busy !== 'witness-apply';
    btn.disabled = !ready;
    btn.title = ready ? '' : 'Preview the attestation and enter the matching owner key first.';
    btn.innerHTML = S.busy === 'witness-apply' ? `${spinner} Signing…` : 'Sign the attestation';
  }
}

function readWitnessKey() {
  const input = $('#witness-owner-key');
  setSigner('witness', input?.value.trim() ?? '', S.resume?.owner);
  renderWitnessKeyStatus();
}

function witnessNote(att) {
  return `Vouch for the app witness key ${short(att.witness, 12, 8)} for agent ${short(att.agentId, 12, 8)}: ${att.reason}`;
}

// showActionError is hard-wired to the ladder card's #action-error; the witness
// card refuses in its own voice, in its own box.
function showWitnessActionError(message) {
  const el = $('#witness-action-error');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = `<div class="callout callout--danger"><strong>Refused.</strong> ${esc(message)}</div>`;
}

async function onWitnessSign() {
  const signer = signerFor('witness');
  if (!S.witnessPreview || !signer) return;
  if (!witnessPreviewIsCurrent()) {
    S.witnessPreview = null;
    S.witnessPreviewError = 'The attestation or the records moved after the preview. Preview it again before signing.';
    renderWitnessPreview();
    renderWitnessKeyStatus();
    return;
  }
  if (!signerCheck('witness')?.matches) {
    showWitnessActionError('The key in this tab does not match the owner key on chain. The server would reject the signature.');
    return;
  }
  const localDigest = witnessAttestationDigest(S.witnessPreview.attestation);
  if (localDigest !== S.witnessPreview.digest) {
    showWitnessActionError('The browser and the server computed different digests. Refusing to sign.');
    return;
  }
  if (!S.mandate?.chainId || !S.mandate?.gate) {
    showWitnessActionError('The live account is not loaded. Reload the mandate before signing.');
    return;
  }

  S.busy = 'witness-apply';
  showWitnessActionError(null);
  renderWitnessKeyStatus();
  try {
    const signature = await signer.signMandateAction({
      chainId: S.mandate.chainId,
      accountAddress: S.mandate.gate,
      kind: 'witness-attestation',
      digest: localDigest,
      note: witnessNote(S.witnessPreview.attestation),
    });
    const out = await api('/api/witness/attest', {
      attestation: S.witnessPreview.attestation,
      signature,
    });
    S.resume = out.resume;
    // A pasted key is forgotten the moment it has signed; a connected wallet
    // holds no key material, so its slot stays armed.
    if (signer !== S.wallet?.signer) S.signers.witness = null;
    S.witnessPreview = null;
    S.witnessPreviewError = null;
    S.witnessForm = null;
    // The résumé just changed under us - an anchor plan drawn against the old
    // snapshot is dropped and re-planned lazily (same rule as the ladder
    // apply). The anchor RESULT stays: an attestation cannot change the
    // evidence root or count that result recorded.
    S.anchorPlan = null;
    S.anchorPlanError = null;
    S.flash = {
      kind: 'ok',
      text: `Attestation ${out.applied} recorded. The signature verified against the owner key on chain, and every signed record is still covered by the witness history.`,
    };
    S.busy = null;
    render();
  } catch (e) {
    S.busy = null;
    renderWitnessKeyStatus();
    showWitnessActionError(e.message);
  }
}

// ------------------------------------------------------------------ actions

async function refreshAll() {
  const btn = $('#refresh');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${spinner} Reading…`;
  }
  S.busy = 'refresh';
  await Promise.allSettled([
    loadMandate(true),
    loadProposals(true),
    S.route === 'audit' ? loadAudit(true) : Promise.resolve(),
    S.route === 'resume' ? loadResume(true) : Promise.resolve(),
    S.route === 'mandate' ? loadUpgradeStatus(true) : Promise.resolve(),
  ]);
  // A submission left at BROADCAST gets one honest look at its receipt.
  await settleBroadcastSubmissions();
  S.busy = null;
  if (S.route === 'approvals') {
    S.signers.approvals = null;
    S.signers.tx = null;
    S.preview = null;
    S.plan = null;
    S.planError = null;
  }
  if (S.route === 'mandate') {
    // A refresh re-reads the chain, so a plan priced against the old nonce is
    // stale by definition - and its confirmation was per priced plan. The
    // pasted key is a secret this tab forgets on every re-read, house rule.
    S.signers.upgrade = null;
    S.upgradePlan = null;
    S.upgradePlanError = null;
    S.upgradeAck = false;
    S.upgradeError = null;
  }
  if (S.route === 'resume') {
    // A refresh re-reads the records, so anything previewed against the old
    // snapshot is stale by definition. Forget the key too.
    S.signers.ladder = null;
    S.signers.anchor = null;
    S.signers.witness = null;
    S.ladderPreview = null;
    S.ladderPreviewError = null;
    S.witnessPreview = null;
    S.witnessPreviewError = null;
    S.anchorResult = null;
    S.anchorError = null;
    S.anchorPlan = null;
    S.anchorPlanError = null;
    // A pasted key is a secret this tab deliberately forgets on refresh. A
    // connected wallet holds no key material, so its slots re-arm exactly as
    // they stay armed after a sign - otherwise "Read again" would silently
    // force a wallet re-prompt before the owner's next signature. (The anchor
    // slot is pasted-key-only; the wallet anchor path runs through planMode.)
    if (S.wallet?.signer) {
      const owner = S.mandate?.ownerPublicKey ?? null;
      S.signers.ladder = { signer: S.wallet.signer, check: S.wallet.signer.checkAgainst(owner) };
      S.signers.witness = { signer: S.wallet.signer, check: S.wallet.signer.checkAgainst(owner) };
    }
  }
  render();
  if (S.route === 'approvals') loadPlanIfNeeded();
  if (S.route === 'resume') loadAnchorPlanIfNeeded();
}

async function onAsk(event) {
  event.preventDefault();
  const recipient = $('#ask-recipient')?.value.trim() ?? '';
  const amount = $('#ask-amount')?.value.trim() ?? '';
  const btn = $('#ask-btn');
  const result = $('#ask-result');
  S.decision = null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `${spinner} Asking…`;
  }
  if (result) result.innerHTML = '';
  try {
    const out = await api('/api/requests', { recipient, amount });
    S.decision = { ...out, at: Date.now() };
    if (out.proposal) {
      S.selected = out.proposal.id;
      initForm(out.proposal);
      await loadProposals(true);
    }
    render();
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Ask the engine';
    }
    if (result) {
      result.innerHTML = `<div class="callout callout--danger">${esc(e.message)}</div>`;
    }
  }
}

function currentResolution() {
  if (!S.form) throw new Error('no proposal is selected');
  if (S.form.type === 'execute-once') return { type: 'execute-once' };
  if (S.form.type === 'decline') return { type: 'decline' };
  const token = S.mandate?.mandate?.token;
  if (!token) {
    throw new Error('the live mandate is not loaded - read the chain again before signing');
  }
  if (S.form.kind === 'raise-per-call-cap') {
    const cap = String(S.form.cap ?? '').trim();
    if (!/^\d+$/.test(cap) || BigInt(cap) <= 0n) {
      throw new Error('the new per-call cap must be a positive whole number');
    }
    return { type: 'amend', amendment: { kind: 'raise-per-call-cap', token, maxPerCall: cap } };
  }
  if (S.form.kind === 'raise-window-cap') {
    const win = String(S.form.windowCap ?? '').trim();
    if (!/^\d+$/.test(win) || BigInt(win) <= 0n) {
      throw new Error('the new window cap must be a positive whole number');
    }
    return { type: 'amend', amendment: { kind: 'raise-window-cap', token, maxPerWindow: win } };
  }
  const recipient = String(S.form.recipient ?? '').trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(recipient)) {
    throw new Error('the recipient must be a 0x-prefixed hex address');
  }
  return { type: 'amend', amendment: { kind: 'allow-recipient', token, recipient } };
}

function shortAddress(address) {
  const a = String(address ?? '');
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// What the owner reads in their wallet before confirming. It describes the same
// resolution the digest binds; the server never trusts this text for policy.
function resolutionNote(proposal, resolution) {
  if (resolution.type === 'execute-once') {
    const ctx = proposal.request?.context ?? {};
    const amount = ctx.amount != null ? String(ctx.amount) : 'the requested amount';
    const recipient = ctx.recipient ? shortAddress(ctx.recipient) : 'the recipient';
    return `Approve once: ${amount} to ${recipient}.`;
  }
  if (resolution.type === 'decline') {
    return 'Decline this request. The block stands; nothing goes on-chain.';
  }
  const amendment = resolution.amendment ?? {};
  if (amendment.kind === 'raise-per-call-cap') {
    return `Amend the mandate: raise the per-call cap to ${amendment.maxPerCall}.`;
  }
  if (amendment.kind === 'raise-window-cap') {
    return `Amend the mandate: raise the window cap to ${amendment.maxPerWindow}. The per-call cap does not change.`;
  }
  if (amendment.kind === 'allow-recipient') {
    return `Amend the mandate: allow ${shortAddress(amendment.recipient)} to receive payments.`;
  }
  return `Amend the mandate: ${JSON.stringify(amendment)}.`;
}

function ladderNote(change) {
  return `Move the agent from ${change.from} to ${change.to}: ${change.reason}`;
}

function previewIsCurrent() {
  if (!S.preview) return false;
  try {
    return S.preview.fingerprint === JSON.stringify(currentResolution());
  } catch {
    return false;
  }
}

async function onPreview() {
  if (!S.selected) return;
  let resolution;
  try {
    resolution = currentResolution();
  } catch (e) {
    S.previewError = e.message;
    S.preview = null;
    renderPreviewPanel();
    return;
  }
  S.busy = 'preview';
  S.previewError = null;
  S.preview = null;
  renderPreviewPanel();
  try {
    const out = await api('/api/preview', { proposalId: S.selected, resolution });
    const localDigest = resolutionDigest(out.proposal, out.resolution);
    S.preview = {
      ...out,
      localDigest,
      matches: localDigest === out.digest,
      fingerprint: JSON.stringify(out.resolution),
    };
  } catch (e) {
    S.previewError = e.message;
  } finally {
    S.busy = null;
    renderPreviewPanel();
    renderKeyStatus();
  }
}

function renderPreviewPanel() {
  const el = $('#preview-panel');
  if (!el) return;
  if (S.busy === 'preview') {
    el.innerHTML = `<p class="hint">${spinner} Reading the live mandate and building the exact call…</p>`;
    return;
  }
  if (S.previewError) {
    el.innerHTML = `<div class="callout callout--danger"><strong>No preview.</strong> ${esc(S.previewError)}</div>`;
    return;
  }
  if (!S.preview || !previewIsCurrent()) {
    el.innerHTML = `<p class="hint">Nothing is signed yet. Preview the exact effect first — the digest, every call and every side effect will be shown before the key field.</p>`;
    return;
  }

  const pv = S.preview;
  const calls = pv.calls ?? [];
  el.innerHTML = `<div class="card-head">
      <h2 class="card-title">What you are about to sign</h2>
      <span class="chip ${pv.matches ? 'chip--approved' : 'chip--danger'}">${pv.matches ? 'digest match' : 'digest mismatch'}</span>
    </div>
    ${pv.matches ? '' : '<div class="callout callout--danger"><strong>Refusing to sign.</strong> The browser and the server computed different digests from the same proposal and decision. This is a bug, not a warning.</div>'}
    <p class="label" style="margin-top:var(--space-3)">Digest · the fingerprint of exactly what you sign</p>
    <p class="digest" style="margin-top:var(--space-2)">${esc(pv.digest)}</p>
    <p class="hint" style="margin-top:var(--space-2)">The browser recomputed this from the proposal and your decision: <span class="mono">${esc(short(pv.localDigest, 12, 10))}</span> — ${pv.matches ? 'identical.' : 'DIFFERENT. Do not sign.'}</p>

    ${calls.length === 0
      ? '<p class="hint" style="margin-top:var(--space-4)">No transaction. The block stands; the agent gains nothing.</p>'
      : `${calls.map((c) => `<pre class="code-card"><code><span class="k">to</span>       <span class="v">${esc(c.to)}</span>
<span class="k">entry</span>    <span class="v">${esc(c.entrypoint)}</span>
<span class="k">calldata</span> <span class="a">[${c.calldata.map(esc).join(', ')}]</span></code></pre>`).join('')}`}

    <p class="label" style="margin-top:var(--space-4)">Side effects</p>
    <ul class="effects">
      ${(pv.sideEffects ?? []).map((s) => `<li class="${String(s).startsWith('WARNING') ? 'is-warn' : ''}">${esc(s)}</li>`).join('')}
    </ul>`;
}

function renderKeyStatus() {
  const el = $('#key-status');
  const btn = $('#sign-btn');
  if (!el) return;

  const signer = signerFor('approvals');
  const check = signerCheck('approvals');
  let kind = 'muted';
  let text = 'No wallet connected and no key entered.';
  if (signer && signer.kind !== 'pasted-key') {
    // A native wallet: connect() already read its key FROM THE CHAIN and
    // refused a wallet that is not the owner, so a match here is real.
    if (check?.matches) {
      kind = 'ok';
      text = `Wallet connected: ${signer.walletName} (${short(signer.address, 10, 6)}). ` +
        'The wallet signs in its own window; the server verifies against the owner key on chain.';
    } else {
      kind = 'error';
      text = check?.error ?? 'This wallet is not the owner of this account.';
    }
  } else if (signer) {
    if (check?.error) {
      kind = 'error';
      text = check.error;
    } else if (check?.matches) {
      kind = 'ok';
      text = `This key derives to the owner on chain: ${short(check.derived, 12, 8)}`;
    } else {
      kind = 'error';
      text = `This key is not the owner of this account (derived ${short(check?.derived, 10, 6)}). The server would reject it too.`;
    }
  }
  el.className = `key-status is-${kind}`;
  el.textContent = text;

  if (btn) {
    const ready = !!signer && !!check?.matches && previewIsCurrent()
      && S.preview?.matches === true && S.busy !== 'resolve';
    btn.disabled = !ready;
    btn.title = ready ? '' : 'Preview the effect, then connect the owner wallet or enter the owner key.';
    btn.innerHTML = S.busy === 'resolve' ? `${spinner} Signing…` : 'Sign resolution';
  }
}

// The wallet connect card: detection first, then one button per wallet found.
// Every state is rendered from S.wallet; refusals arrive as plain-word errors
// from connectWallet and are shown verbatim - never swallowed.
function renderWalletCard() {
  const box = $('#wallet-box');
  if (!box) return;
  const w = S.wallet;
  const buttons = (wallets) => wallets.map((wl) =>
    `<button class="btn" type="button" data-wallet-connect="${esc(wl.id)}">Connect ${esc(wl.name)}</button>`).join('');

  if (w?.connecting) {
    box.innerHTML = `<div class="key-status is-muted">${spinner} Waiting for the wallet — confirm the connection in its window.</div>`;
    return;
  }
  if (w?.error) {
    const wallets = detectWallets(window);
    box.innerHTML = `<div class="key-status is-error">${esc(w.error)}</div>
      <div class="form-actions" style="margin-top:var(--space-2)">${buttons(wallets)}</div>`;
    return;
  }
  if (w?.info) {
    box.innerHTML = `<div class="key-status is-ok">Connected: ${esc(w.info.name)} · ${short(w.info.address, 10, 6)} — the chain says its key is this account's owner.</div>
      <div class="form-actions" style="margin-top:var(--space-2)">
        <button class="btn btn--quiet" type="button" data-wallet-disconnect="1">Disconnect wallet</button>
      </div>`;
    return;
  }
  const wallets = detectWallets(window);
  if (wallets.length === 0) {
    box.innerHTML = '<div class="key-status is-muted">No Starknet wallet found in this browser. ' +
      'Install Argent X or Braavos and reload — or use the key field below.</div>';
    return;
  }
  box.innerHTML = `<p class="hint">Sign with your own wallet: the console never sees a key, the wallet shows you the exact action, and the server verifies the signature against the owner key on the chain. Until the ownership handover (track 2, phase 6), a wallet that does not hold this account's key is refused — loudly.</p>
    <div class="form-actions" style="margin-top:var(--space-2)">${buttons(wallets)}</div>`;
}

async function onWalletConnect(walletId) {
  if (S.wallet?.connecting) return;
  S.wallet = { connecting: true };
  renderWalletCard();
  renderAnchorPanel(); // the résumé shows its own connecting state
  try {
    const owner = S.mandate?.ownerPublicKey ?? null;
    const { signer, info } = await connectWallet({
      win: window,
      expectedChainId: S.mandate?.chainId,
      ownerPublicKey: owner,
      walletId,
    });
    S.wallet = { info, signer };
    S.signers.approvals = { signer, check: signer.checkAgainst(owner) };
    // On the résumé, the same connected wallet is the signer for the owner's
    // two controls there (ladder changes and witness attestations). Since the
    // phase-6 handover the pasted owner key is historical, so without this the
    // résumé's signing cards could never sign live. Route-guarded: each
    // screen's signer slots belong to that screen.
    if (S.route === 'resume') {
      S.signers.ladder = { signer, check: signer.checkAgainst(owner) };
      S.signers.witness = { signer, check: signer.checkAgainst(owner) };
    }
    const input = $('#owner-key');
    if (input) input.value = '';
    S.flash = null;
    renderWalletCard();
    renderKeyStatus();
    renderLadderKeyStatus();
    renderWitnessKeyStatus();
    // A connected wallet flips the final-transaction mode from "this tab signs"
    // to "the wallet authorizes, the server relays" - the plan shape differs,
    // so any loaded plan is dropped and re-fetched. Same for the anchor.
    invalidatePlan();
    invalidateAnchorPlan();
  } catch (e) {
    S.wallet = { error: String(e?.message ?? e) };
    renderWalletCard();
    renderKeyStatus();
    renderAnchorPanel();
  }
}

function readKey() {
  const input = $('#owner-key');
  const raw = input?.value.trim() ?? '';
  // Typing a key takes over from a connected wallet: one signer per slot, and
  // the last deliberate action wins.
  if (raw && S.wallet?.info) S.wallet = null;
  setSigner('approvals', raw, S.mandate?.ownerPublicKey);
  renderKeyStatus();
  renderWalletCard();
}

async function onSign() {
  if (!S.selected || !signerFor('approvals') || !S.preview) return;
  let resolution;
  try {
    resolution = currentResolution();
  } catch (e) {
    showActionError(e.message);
    return;
  }
  if (!previewIsCurrent()) {
    S.preview = null;
    S.previewError = 'The decision changed after the preview. Preview it again before signing.';
    renderPreviewPanel();
    renderKeyStatus();
    return;
  }
  const signer = signerFor('approvals');
  if (!signerCheck('approvals')?.matches) {
    showActionError('The key in this tab does not match the owner key on chain. The server would reject the signature.');
    return;
  }
  const localDigest = resolutionDigest(S.preview.proposal, resolution);
  if (localDigest !== S.preview.digest) {
    showActionError('The browser and the server computed different digests. Refusing to sign.');
    return;
  }
  if (!S.mandate?.chainId || !S.mandate?.gate) {
    showActionError('The live account is not loaded. Reload the mandate before signing.');
    return;
  }

  S.busy = 'resolve';
  showActionError(null);
  renderKeyStatus();
  try {
    const signature = await signer.signMandateAction({
      chainId: S.mandate.chainId,
      accountAddress: S.mandate.gate,
      kind: 'resolution',
      digest: localDigest,
      note: resolutionNote(S.preview.proposal, resolution),
    });
    await api('/api/resolve', {
      proposalId: S.selected,
      resolution,
      signature,
    });
    const id = S.selected;
    if (signer.kind === 'pasted-key') {
      // Deliberate-confirmation hygiene: a pasted key is forgotten the moment
      // it was used; the next decision needs it entered again.
      S.signers.approvals = null;
    }
    // A connected wallet deliberately SURVIVES the resolution: the same decision
    // continues into the final transaction, which the wallet signs as a SNIP-9
    // authorization (renderSubmitPanel's wallet mode). No key material lives in
    // this tab, and the wallet re-prompts for every signature - the popup IS the
    // deliberate confirmation, for this and every following resolution.
    S.preview = null;
    S.previewError = null;
    S.plan = null;
    S.planError = null;
    S.flash = {
      kind: 'ok',
      text: 'Resolution recorded. The signature verified against the owner key on chain.',
    };
    await loadProposals(true);
    S.selected = id;
    S.busy = null;
    render();
    loadPlanIfNeeded();
  } catch (e) {
    S.busy = null;
    renderKeyStatus();
    showActionError(e.message);
  }
}

function showActionError(message) {
  const el = $('#action-error');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = `<div class="callout callout--danger"><strong>Refused.</strong> ${esc(message)}</div>`;
}

// ------------------------------------------------------------------ on-chain submission

// Two shapes of "put it on-chain", one per signer:
//   - a connected WALLET authorizes a SNIP-9 OutsideExecution (the exact calls
//     + a one-shot nonce + an expiry window); the server re-verifies everything
//     against the chain and hands the wire call back UNRELAYED — the wallet
//     then sends it as its OWN transaction (OBS-31). Plan: /api/outside/plan.
//   - a PASTED KEY signs the transaction itself in this tab; the server only
//     carries the signed bytes. Plan: /api/tx/plan.
// The plan shapes differ, so a mode change must always re-plan.
function planMode() {
  return S.wallet?.signer ? 'outside' : 'tx';
}

function invalidatePlan() {
  S.plan = null;
  S.planError = null;
  loadPlanIfNeeded();
}

function loadPlanIfNeeded() {
  const p = S.proposals?.find((x) => x.id === S.selected);
  if (!p) return;
  if (!['APPROVED_ONCE', 'AMENDED'].includes(p.status)) return;
  if (finalSubmissionFor(p.id)) return;
  const mode = planMode();
  if (S.plan?.proposalId === p.id && (S.plan.kind ?? 'tx') === mode) {
    renderSubmitPanel();
    return;
  }
  if (S.planLoading) return;
  if (S.planError && S.planError.proposalId === p.id) {
    renderSubmitPanel();
    return;
  }

  S.planLoading = true;
  S.planError = null;
  renderSubmitPanel();
  // The relay plan: the same calls the old plan showed, PLUS what the signer
  // will sign over - for a key: nonce, fee bounds, sender, chain id (the
  // estimate comes from a dry-run that signs nothing); for a wallet: the
  // chain-named controller, a one-shot nonce verified unused on chain, and the
  // execution window.
  api(mode === 'outside' ? '/api/outside/plan' : '/api/tx/plan', { proposalId: p.id })
    .then((out) => {
      S.plan = { proposalId: p.id, kind: out.kind ?? 'tx', ...out };
    })
    .catch((e) => {
      S.planError = { proposalId: p.id, message: e.message };
    })
    .finally(() => {
      S.planLoading = false;
      renderSubmitPanel();
    });
}

function renderSubmitPanel() {
  const el = $('#submit-panel');
  if (!el) return;
  const p = S.proposals?.find((x) => x.id === S.selected);
  if (!p) return;

  const sub = finalSubmissionFor(p.id) ?? submissionFor(p.id);
  if (sub && sub.status === 'BROADCAST') {
    el.innerHTML = S.busy === 'receipt'
      ? `<p class="hint">${spinner} Signed and relayed — waiting for the chain to confirm tx ${esc(sub.tx_hash)}… (${fmtNum(S.receiptTries)} reads so far)</p>`
      : submissionHtml(sub);
    return;
  }
  if (sub && sub.status !== 'ERROR') {
    el.innerHTML = submissionHtml(sub);
    return;
  }

  if (S.planLoading) {
    el.innerHTML = `<p class="hint">${spinner} Re-reading the live mandate and pricing the exact transaction…</p>`;
    return;
  }
  if (S.planError?.proposalId === p.id) {
    el.innerHTML = `<div class="callout callout--danger"><strong>Cannot submit this approval.</strong> ${esc(S.planError.message)}</div>
      <div class="form-actions" style="margin-top:var(--space-2)">
        <button class="btn" type="button" data-action="replan">Try again</button>
        ${planMode() === 'outside' ? '<button class="btn btn--quiet" type="button" data-action="tx-use-key">Disconnect the wallet and use a pasted key</button>' : ''}
      </div>`;
    return;
  }
  if (!S.plan || S.plan.proposalId !== p.id) {
    el.innerHTML = '<p class="hint">Checking the live mandate…</p>';
    return;
  }

  if ((S.plan.kind ?? 'tx') === 'outside') {
    renderOutsidePanel(el, sub);
    return;
  }

  const calls = S.plan.calls ?? [];
  const rb = S.plan.resourceBounds ?? {};
  const bound = (b) => `max ${fmtInt(b?.max_amount)} × ${fmtInt(b?.max_price_per_unit)} per unit`;
  // Recovery path: a wallet extension may be present but not connected (e.g.
  // the page was reloaded mid-flow). Connecting flips this panel to the wallet
  // mode - after the phase-6 handover it is the ONLY mode that still works.
  const wls = detectWallets(window);
  const walletRow = wls.length === 0 ? '' : `
    <div class="field" style="margin-top:var(--space-4)">
      <p class="label">Or let your own wallet sign this</p>
      <div class="form-actions" style="margin-top:var(--space-2)">${wls.map((wl) => `<button class="btn" type="button" data-wallet-connect="${esc(wl.id)}">Connect ${esc(wl.name)}</button>`).join('')}</div>
      <p class="hint">The wallet signs an authorization for these exact calls and the server relays it — no key ever touches this page.</p>
    </div>`;
  el.innerHTML = `
    ${sub && sub.status === 'ERROR' ? `<div class="callout callout--danger" style="margin-bottom:var(--space-3)"><strong>The previous attempt did not complete.</strong> ${esc(sub.message ?? '')}</div>` : ''}
    ${calls.map((c) => `<pre class="code-card"><code><span class="k">to</span>       <span class="v">${esc(c.to)}</span>
<span class="k">entry</span>    <span class="v">${esc(c.entrypoint)}</span>
<span class="k">calldata</span> <span class="a">[${c.calldata.map(esc).join(', ')}]</span></code></pre>`).join('')}
    <ul class="effects">
      ${(S.plan.sideEffects ?? []).map((s) => `<li class="${String(s).startsWith('WARNING') ? 'is-warn' : ''}">${esc(s)}</li>`).join('')}
    </ul>

    <p class="label" style="margin-top:var(--space-4)">The transaction this tab will sign</p>
    <pre class="code-card"><code><span class="k">from</span>      <span class="v">${esc(S.plan.sender)} (the GateAccount)</span>
<span class="k">chain</span>     <span class="v">${esc(S.plan.chainId)}</span>
<span class="k">nonce</span>     <span class="v">${esc(S.plan.nonce)}</span>
<span class="k">l1_gas</span>    <span class="a">${bound(rb.l1_gas)}</span>
<span class="k">l2_gas</span>    <span class="a">${bound(rb.l2_gas)}</span>
<span class="k">l1_data</span>   <span class="a">${bound(rb.l1_data_gas)}</span></code></pre>
    <p class="hint" style="margin-top:var(--space-2)">${esc(S.plan.estimateSource ?? 'Priced by the harness dry-run')} — padded, and unused gas is refunded. Your signature covers these exact numbers, so what was priced is what can go to the chain.</p>
    ${walletRow}
    <div class="field" style="margin-top:var(--space-4)">
      <label for="tx-key">Owner private key (testnet) — signs the transaction in this tab</label>
      <input class="input" id="tx-key" type="password" autocomplete="off"
             spellcheck="false" placeholder="0x…" data-1p-ignore data-lpignore="true">
    </div>
    <div id="tx-key-status" class="key-status is-muted">No key entered.</div>
    <div class="form-actions">
      <button class="btn btn--primary" type="button" id="tx-sign-btn" data-action="submit" disabled>Sign and send</button>
      <button class="btn btn--quiet" type="button" data-action="forget-tx-key">Forget key</button>
    </div>
    <p class="hint" style="margin-top:var(--space-3)">This tab builds the Starknet transaction and signs it with your key; the server receives the signed bytes, re-checks them against the chain (this account, this chain, the owner key it reads from the chain) and carries them to the node verbatim. It never builds a transaction, so it cannot substitute one.</p>`;

  const txKeyInput = $('#tx-key');
  if (txKeyInput) txKeyInput.addEventListener('input', readTxKey);
  renderTxKeyStatus();
}

// The wallet variant of the submit panel: the wallet signs a SNIP-9
// authorization for these exact calls (visible in the wallet's own window);
// the server re-verifies everything against the chain and hands the wire call
// back UNRELAYED; the wallet sends it as its OWN transaction (OBS-31). Plain
// words first, the signed fields one glance away.
function renderOutsidePanel(el, sub) {
  const plan = S.plan;
  const w = S.wallet?.signer ?? null;
  // The client-side mirror of the server's control 1, in plain words: the
  // connected wallet must BE the controller the chain names on this gate.
  const isController = !!w && norm(w.address) === norm(plan.controller);
  const wallets = detectWallets(window);

  let statusHtml;
  if (!w) {
    statusHtml = `<div class="key-status is-muted">No wallet connected.${wallets.length
      ? ' Connect yours below — it signs the authorization; this page never sees a key.'
      : ' Install Argent X or Braavos and reload — or use a pasted key.'}</div>
      ${wallets.length ? `<div class="form-actions" style="margin-top:var(--space-2)">${wallets.map((wl) => `<button class="btn" type="button" data-wallet-connect="${esc(wl.id)}">Connect ${esc(wl.name)}</button>`).join('')}</div>` : ''}`;
  } else if (!isController) {
    statusHtml = `<div class="key-status is-error">Wrong wallet: ${esc(w.walletName ?? 'the wallet')} (${esc(short(w.address, 10, 6))}) is NOT the controller this gate names on chain (${esc(short(plan.controller, 10, 6))}). Only the controller's signature can authorize this gate — the server would refuse it too.</div>
      <div class="form-actions" style="margin-top:var(--space-2)"><button class="btn btn--quiet" type="button" data-wallet-disconnect="1">Disconnect wallet</button></div>`;
  } else {
    statusHtml = `<div class="key-status is-ok">${esc(w.walletName ?? 'Wallet')} · ${esc(short(w.address, 10, 6))} — the chain names this wallet as the gate's controller. Its signature can authorize this.</div>
      <div class="form-actions" style="margin-top:var(--space-2)"><button class="btn btn--quiet" type="button" data-action="tx-use-key">Disconnect and use a pasted key</button></div>`;
  }

  const ready = isController && S.busy !== 'submit' && S.busy !== 'receipt';
  el.innerHTML = `
    ${sub && sub.status === 'ERROR' ? `<div class="callout callout--danger" style="margin-bottom:var(--space-3)"><strong>The previous attempt did not complete.</strong> ${esc(sub.message ?? '')}</div>` : ''}
    ${(plan.calls ?? []).map((c) => `<pre class="code-card"><code><span class="k">to</span>       <span class="v">${esc(c.to)}</span>
<span class="k">entry</span>    <span class="v">${esc(c.selector)}</span>
<span class="k">calldata</span> <span class="a">[${(c.calldata ?? []).map(esc).join(', ')}]</span></code></pre>`).join('')}
    <ul class="effects">
      ${(plan.sideEffects ?? []).map((s) => `<li class="${String(s).startsWith('WARNING') ? 'is-warn' : ''}">${esc(s)}</li>`).join('')}
    </ul>

    <p class="label" style="margin-top:var(--space-4)">The authorization your wallet will sign</p>
    <pre class="code-card"><code><span class="k">chain</span>      <span class="v">${esc(plan.chainId)}</span>
<span class="k">caller</span>     <span class="v">${esc(plan.caller)} — anyone may carry it to the chain; your wallet will</span>
<span class="k">nonce</span>      <span class="v">${esc(plan.nonce)} — one-shot; the chain burns it on use, so this can never replay</span>
<span class="k">valid</span>      <span class="v">from ${esc(fmtUnix(plan.executeAfter))} until ${esc(fmtUnix(plan.executeBefore))}</span>
<span class="k">gate</span>       <span class="v">${esc(plan.gate)}</span>
<span class="k">controller</span> <span class="v">${esc(plan.controller)}${plan.controllerPublicKey ? ` (key ${esc(short(plan.controllerPublicKey, 12, 8))}, read from the chain)` : ''}</span>
<span class="k">relayer</span>    <span class="v">${esc(plan.relayer ?? 'the server')} — gas only, no authority over your mandate; this flow does not use it — your wallet sends the authorization itself</span></code></pre>
    ${plan.note ? `<p class="hint" style="margin-top:var(--space-2)">${esc(plan.note)}</p>` : ''}

    <div style="margin-top:var(--space-4)">${statusHtml}</div>
    <div class="form-actions">
      <button class="btn btn--primary" type="button" id="tx-sign-btn" data-action="submit"${ready ? '' : ' disabled'}>${S.busy === 'submit' ? `${spinner} Waiting for the wallet…` : 'Sign in wallet and send'}</button>
    </div>
    <p class="hint" style="margin-top:var(--space-3)">Your wallet signs an authorization for these exact calls — this page never sees a key. The server re-checks everything against the chain (the calls re-derived from the LIVE mandate, the signature against the controller's chain-read key, the nonce unused, the window open) and hands the wire call back unrelayed — your wallet sends it as its OWN transaction and pays its own gas; nobody carries it for you. The record is written only from the chain's copy of that transaction and its receipt — and only complete when the chain also says the nonce is burned.</p>`;
}

function renderTxKeyStatus() {
  const el = $('#tx-key-status');
  const btn = $('#tx-sign-btn');
  if (!el) return;

  const signer = signerFor('tx');
  const check = signerCheck('tx');
  let kind = 'muted';
  let text = 'No key entered.';
  if (signer) {
    if (check?.error) {
      kind = 'error';
      text = check.error;
    } else if (check?.matches) {
      kind = 'ok';
      text = `This key derives to the owner on chain: ${short(check.derived, 12, 8)}`;
    } else {
      kind = 'error';
      text = `This key is not the owner of this account (derived ${short(check?.derived, 10, 6)}). The relay would reject it too.`;
    }
  }
  el.className = `key-status is-${kind}`;
  el.textContent = text;

  if (btn) {
    const ready = !!signer && !!check?.matches && !!S.plan
      && S.busy !== 'submit' && S.busy !== 'receipt';
    btn.disabled = !ready;
    btn.title = ready ? '' : 'Enter the matching owner key first — the transaction is signed in this tab.';
    btn.innerHTML = S.busy === 'submit' ? `${spinner} Signing…` : 'Sign and send';
  }
}

function readTxKey() {
  const input = $('#tx-key');
  setSigner('tx', input?.value.trim() ?? '', S.mandate?.ownerPublicKey);
  renderTxKeyStatus();
}

async function onSubmit() {
  if (!S.selected || S.busy === 'submit' || S.busy === 'receipt') return;
  const plan = S.plan;
  if (!plan || plan.proposalId !== S.selected) return;
  if ((plan.kind ?? 'tx') === 'outside') {
    await onSubmitOutside(plan);
    return;
  }
  const signer = signerFor('tx');
  if (!signerCheck('tx')?.matches || !signer) {
    showActionError('Enter the owner key first. The transaction is signed in this tab, and the relay checks the signature against the owner key on chain.');
    return;
  }
  S.busy = 'submit';
  S.receiptTries = 0;
  showActionError(null);
  renderSubmitPanel();
  try {
    // Build and sign locally. The signature covers the plan's exact calls,
    // nonce, fee bounds, sender and chain id - the numbers shown above.
    const built = buildInvokeTx({
      sender: plan.sender,
      calls: plan.calls,
      nonce: plan.nonce,
      resourceBounds: plan.resourceBounds,
      chainId: plan.chainIdFelt,
      tip: 0,
    });
    const { body } = signer.signInvoke(built, built.body);
    const out = await api('/api/broadcast', {
      transaction: body,
      proposalId: plan.proposalId,
    });
    const txHash = out.result.transaction_hash;
    S.signers.tx = null;
    await loadProposals(true);

    // The node must answer with the hash THIS tab signed. Anything else means
    // the relay carried a different transaction - say so loudly and stop.
    if (norm(txHash) !== norm(built.hash)) {
      S.busy = null;
      S.flash = {
        kind: 'danger',
        text: `The node reported tx ${txHash}, but this tab signed ${built.hash}. That is not the transaction you signed - treat the relay as hostile and check the chain before doing anything else.`,
      };
      render();
      return;
    }

    S.busy = 'receipt';
    S.flash = {
      kind: 'ok',
      text: `Signed in this tab and relayed. tx ${txHash} — waiting for the chain to confirm…`,
    };
    render();
    const receipt = await pollReceipt(txHash, {
      onTick: (i) => { S.receiptTries = i; renderSubmitPanel(); },
    });
    await loadProposals(true);
    S.busy = null;
    if (receipt?.execution_status === 'SUCCEEDED') {
      S.flash = { kind: 'ok', text: `Executed on chain. tx ${txHash} — signed in your browser, carried by the server, confirmed by Starknet.` };
    } else if (receipt?.execution_status === 'REVERTED') {
      S.flash = { kind: 'danger', text: `The transaction reverted: ${receipt.revert_reason ?? 'no reason returned'}` };
    } else {
      S.flash = {
        kind: 'danger',
        text: `Relayed (tx ${txHash}) but the chain had not confirmed within two minutes. The record honestly says BROADCAST; "Read again" keeps looking for the receipt.`,
      };
    }
    render();
  } catch (e) {
    S.busy = null;
    renderSubmitPanel();
    showActionError(e.message);
  }
}

// ------------------------------------------------------------------ owner actions
// The upgrade card on the mandate screen (how v0.4 gets installed). Same trust
// split as the submit panel - the plan comes from the server's live reads, the
// transaction is built and signed IN THIS TAB, the relay only carries bytes -
// but this is an OWNER action, not a proposal: no engine verdict and no
// resolution digest, just the state file's recorded pending class checked
// against the chain's current one. And one honest sentence the card must never
// hide: while the gate still runs v0.3, a wallet's signing rehearsal of
// `upgrade` fails at signing time (the self-only guard, OBS-32), so THIS
// install is the last owner action that needs the one-time pasted key.

function renderUpgradePanel() {
  const box = $('#upgrade-box');
  const readout = $('#upgrade-readout');
  if (!box) return;

  if (S.upgradeError) {
    if (readout) readout.textContent = 'chain read failed';
    box.innerHTML = `<div class="callout callout--danger"><strong>The chain did not answer.</strong> ${esc(S.upgradeError)}</div>
      <div class="form-actions" style="margin-top:var(--space-2)">
        <button class="btn" type="button" data-action="upgrade-retry">Try again</button>
      </div>`;
    return;
  }
  if (!S.upgrade) {
    if (readout) readout.textContent = 'reading…';
    box.innerHTML = `<p class="hint">${spinner} Reading the gate's class hash from the chain…</p>`;
    return;
  }

  const u = S.upgrade;
  const facts = `<dl class="facts">
    <div class="fact"><dt>Version (record)</dt><dd>${esc(u.recordedVersion ?? 'unknown')}</dd></div>
    <div class="fact"><dt>Class on chain</dt><dd><div class="addr-row"><span class="addr">${esc(u.currentClassHash)}</span>${copyBtn(u.currentClassHash, 'current class hash')}</div>
      <p class="hint">Read from the chain for this gate - the chain is the authority, the file is the record.</p></dd></div>
    ${u.pending ? `<div class="fact"><dt>Declared, waiting</dt><dd><div class="addr-row"><span class="addr">${esc(u.pending.class_hash)}</span>${copyBtn(u.pending.class_hash, 'pending class hash')}</div>
      <p class="hint">${esc(u.pending.version ?? '')}${u.pending.explorer_tx ? ` · <a href="${esc(u.pending.explorer_tx)}">the declare transaction</a>` : ''}</p></dd></div>` : ''}
  </dl>
  ${S.upgradeTx ? `<p class="hint" style="margin-top:var(--space-2)">Upgrade tx <span class="mono">${esc(S.upgradeTx.hash)}</span> — ${esc(S.upgradeTx.status)}.</p>` : ''}`;

  if (!u.pending) {
    if (readout) readout.textContent = 'nothing pending';
    box.innerHTML = `${facts}
      <p class="hint" style="margin-top:var(--space-3)">No upgrade is recorded as waiting. When a new class is declared, it appears here with its class hash - and installing it stays your decision: an owner-signed transaction, priced and signed in this tab.</p>`;
    return;
  }

  if (u.alreadyApplied) {
    if (readout) readout.textContent = 'up to date';
    box.innerHTML = `${facts}
      <div class="callout callout--ok" style="margin-top:var(--space-3)"><strong>The chain itself says the gate now runs the declared class.</strong> Nothing to install. The record file's version line is updated after this is verified from the chain, not before.</div>`;
    return;
  }

  if (readout) readout.textContent = 'upgrade waiting';
  const plan = S.upgradePlan;
  let flow;
  if (S.upgradeBusy === 'receipt') {
    flow = `<p class="hint" style="margin-top:var(--space-3)">${spinner} Signed and relayed — waiting for the chain to confirm ${esc(S.upgradeTx?.hash ?? 'the transaction')}… (${fmtNum(S.upgradeReceiptTries)} reads so far)</p>`;
  } else if (S.upgradePlanLoading) {
    flow = `<p class="hint" style="margin-top:var(--space-3)">${spinner} Re-reading the chain and pricing the exact transaction…</p>`;
  } else if (S.upgradePlanError) {
    flow = `<div class="callout callout--danger" style="margin-top:var(--space-3)"><strong>Cannot price the upgrade.</strong> ${esc(S.upgradePlanError)}</div>
      <div class="form-actions" style="margin-top:var(--space-2)">
        <button class="btn" type="button" data-action="upgrade-plan">Try again</button>
      </div>`;
  } else if (plan) {
    const rb = plan.resourceBounds ?? {};
    const bound = (b) => `max ${fmtInt(b?.max_amount)} × ${fmtInt(b?.max_price_per_unit)} per unit`;
    flow = `
      <div class="callout callout--danger" style="margin-top:var(--space-3)"><strong>This replaces the gate's code.</strong> The mandate, sessions, allowlist, balances and history live in the account's state and survive an in-place upgrade (pinned by contract tests t34/t40) — but read the plan below like it is the most important thing you sign, because from now on it is the code every check runs.</div>
      ${(plan.calls ?? []).map((c) => `<pre class="code-card"><code><span class="k">to</span>       <span class="v">${esc(c.to)}</span>
<span class="k">entry</span>    <span class="v">${esc(c.entrypoint)}</span>
<span class="k">calldata</span> <span class="a">[${c.calldata.map(esc).join(', ')}]</span></code></pre>`).join('')}
      <ul class="effects">
        ${(plan.sideEffects ?? []).map((s) => `<li>${esc(s)}</li>`).join('')}
      </ul>
      <p class="label" style="margin-top:var(--space-4)">The transaction this tab will sign</p>
      <pre class="code-card"><code><span class="k">from</span>      <span class="v">${esc(plan.sender)} (the GateAccount)</span>
<span class="k">chain</span>     <span class="v">${esc(plan.chainId)}</span>
<span class="k">nonce</span>     <span class="v">${esc(plan.nonce)}</span>
<span class="k">l1_gas</span>    <span class="a">${bound(rb.l1_gas)}</span>
<span class="k">l2_gas</span>    <span class="a">${bound(rb.l2_gas)}</span>
<span class="k">l1_data</span>   <span class="a">${bound(rb.l1_data_gas)}</span></code></pre>
      <p class="hint" style="margin-top:var(--space-2)">${esc(plan.estimateSource ?? 'Priced by the harness dry-run')} — padded, and unused gas is refunded. Your signature covers these exact numbers.</p>
      ${S.upgradeAck
        ? `<div class="callout callout--ok" style="margin-top:var(--space-4)"><strong>Confirmed.</strong> You enabled signing for THIS priced plan. Re-pricing resets the confirmation.</div>`
        : `<div class="form-actions" style="margin-top:var(--space-4)">
             <button class="btn" type="button" data-action="upgrade-ack">I have read the plan — enable signing</button>
           </div>`}
      ${S.upgradeError ? `<div class="callout callout--danger" style="margin-top:var(--space-3)">${esc(S.upgradeError)}</div>` : ''}
      <div class="field" style="margin-top:var(--space-4)">
        <label for="upgrade-key">Owner private key (testnet) — signs the transaction in this tab</label>
        <input class="input" id="upgrade-key" type="password" autocomplete="off"
               spellcheck="false" placeholder="0x…" data-1p-ignore data-lpignore="true">
      </div>
      <div id="upgrade-key-status" class="key-status is-muted">No key entered.</div>
      <div class="form-actions">
        <button class="btn btn--primary" type="button" id="upgrade-send-btn" data-action="upgrade-send" disabled>Sign and send</button>
        <button class="btn btn--quiet" type="button" data-action="upgrade-replan">Re-price</button>
        <button class="btn btn--quiet" type="button" data-action="forget-upgrade-key">Forget key</button>
      </div>
      <p class="hint" style="margin-top:var(--space-3)">Why a pasted key and not the wallet: the gate still runs v0.3, whose admin guard is self-only, so a wallet's signing rehearsal of this very call would fail — that contradiction is exactly what this upgrade removes. This tab builds the transaction and signs it with your key; the server carries the signed bytes after re-checking them against the chain, and the key is forgotten the moment it signed. After this upgrade, owner actions sign from the wallet — no export.</p>`;
  } else {
    flow = `<p class="hint" style="margin-top:var(--space-3)">${esc(u.pending.install_path ?? 'Install path: an owner-signed invoke through this console.')}</p>
      <div class="form-actions" style="margin-top:var(--space-2)">
        <button class="btn btn--primary" type="button" data-action="upgrade-plan">Price the upgrade</button>
      </div>`;
  }
  box.innerHTML = facts + flow;

  // Re-bind what lives inside the box (the submit panel does the same after
  // every innerHTML write).
  $('#upgrade-key')?.addEventListener('input', readUpgradeKey);
  renderUpgradeKeyStatus();
}

function readUpgradeKey() {
  const input = $('#upgrade-key');
  setSigner('upgrade', input?.value.trim() ?? '', S.mandate?.ownerPublicKey);
  renderUpgradeKeyStatus();
}

function renderUpgradeKeyStatus() {
  const el = $('#upgrade-key-status');
  const btn = $('#upgrade-send-btn');
  if (!el) return;

  const signer = signerFor('upgrade');
  const check = signerCheck('upgrade');
  let kind = 'muted';
  let text = 'No key entered.';
  if (signer) {
    if (check?.error) {
      kind = 'error';
      text = check.error;
    } else if (check?.matches) {
      kind = 'ok';
      text = `This key derives to the owner on chain: ${short(check.derived, 12, 8)}`;
    } else {
      kind = 'error';
      text = `This key is not the owner of this account (derived ${short(check?.derived, 10, 6)}). The relay would reject it too.`;
    }
  }
  el.className = `key-status is-${kind}`;
  el.textContent = text;

  if (btn) {
    const ready = !!signer && !!check?.matches && !!S.upgradeAck && !!S.upgradePlan
      && !S.upgradeBusy;
    btn.disabled = !ready;
    btn.title = ready ? '' : 'Confirm the plan and enter the matching owner key first — the transaction is signed in this tab.';
    btn.innerHTML = S.upgradeBusy === 'submit' ? `${spinner} Signing…` : 'Sign and send';
  }
}

async function onUpgradePlan() {
  if (S.upgradePlanLoading || S.upgradeBusy) return;
  S.upgradePlanLoading = true;
  S.upgradePlanError = null;
  S.upgradeError = null;
  renderUpgradePanel();
  try {
    S.upgradePlan = await api('/api/owner/plan', { action: 'upgrade' });
  } catch (e) {
    S.upgradePlanError = e.message;
  } finally {
    S.upgradePlanLoading = false;
    renderUpgradePanel();
  }
}

async function onUpgradeSend() {
  const plan = S.upgradePlan;
  if (!plan || S.upgradeBusy === 'submit' || S.upgradeBusy === 'receipt') return;
  const signer = signerFor('upgrade');
  if (!S.upgradeAck || !signer || !signerCheck('upgrade')?.matches) {
    S.upgradeError = 'Confirm the plan and enter the matching owner key first. The transaction is signed in this tab, and the relay checks the signature against the owner key on chain.';
    renderUpgradePanel();
    return;
  }
  S.upgradeBusy = 'submit';
  S.upgradeReceiptTries = 0;
  S.upgradeError = null;
  renderUpgradePanel();
  try {
    // Build and sign locally. The signature covers the plan's exact call,
    // nonce, fee bounds, sender and chain id - the numbers shown above.
    const built = buildInvokeTx({
      sender: plan.sender,
      calls: plan.calls,
      nonce: plan.nonce,
      resourceBounds: plan.resourceBounds,
      chainId: plan.chainIdFelt,
      tip: 0,
    });
    const { body } = signer.signInvoke(built, built.body);
    const out = await api('/api/broadcast', { transaction: body, action: 'upgrade' });
    const txHash = out.result.transaction_hash;
    S.signers.upgrade = null; // the pasted key is forgotten the moment it signed
    S.upgradeTx = { hash: txHash, status: 'BROADCAST' };

    // The node must answer with the hash THIS tab signed - the same promise
    // the submit panel makes. Anything else means the relay carried a
    // different transaction: say so loudly and stop.
    if (norm(txHash) !== norm(built.hash)) {
      S.upgradeBusy = null;
      S.flash = {
        kind: 'danger',
        text: `The node reported tx ${txHash}, but this tab signed ${built.hash}. That is not the transaction you signed - treat the relay as hostile and check the chain before doing anything else.`,
      };
      render();
      return;
    }

    S.upgradeBusy = 'receipt';
    S.flash = {
      kind: 'ok',
      text: `Signed in this tab and relayed. tx ${txHash} — waiting for the chain to confirm the upgrade…`,
    };
    render();
    const receipt = await pollReceipt(txHash, {
      onTick: (i) => { S.upgradeReceiptTries = i; renderUpgradePanel(); },
    });
    S.upgradeBusy = null;
    if (receipt?.execution_status === 'SUCCEEDED') {
      S.upgradeTx = { hash: txHash, status: 'SUCCEEDED' };
      S.flash = {
        kind: 'ok',
        text: `The upgrade executed on chain. tx ${txHash} — signed in your browser, carried by the server, confirmed by Starknet. Re-reading the gate's class and the whole mandate, to show from the chain that the state survived.`,
      };
      await Promise.allSettled([loadUpgradeStatus(true), loadMandate(true)]);
    } else if (receipt?.execution_status === 'REVERTED') {
      S.upgradeTx = { hash: txHash, status: 'REVERTED' };
      S.flash = { kind: 'danger', text: `The upgrade transaction reverted: ${receipt.revert_reason ?? 'no reason returned'}` };
      await loadUpgradeStatus(true);
    } else {
      S.flash = {
        kind: 'danger',
        text: `Relayed (tx ${txHash}) but the chain had not confirmed within two minutes. The record honestly says BROADCAST; "Read again" keeps looking for the receipt.`,
      };
    }
    render();
  } catch (e) {
    S.upgradeBusy = null;
    S.upgradeError = e.message;
    renderUpgradePanel();
  }
}

// The wallet path (OBS-31): authorizeCalls asks the EXTENSION to sign the
// SNIP-9 typed data (the user confirms in the wallet's own window - the
// deliberate act); the server re-verifies it and hands the wire call back
// UNRELAYED; the wallet sends execute_from_outside_v2 as its OWN transaction
// (Ready X's simulation can model that, unlike a third-party relay of a
// controller-bound self-call); the server then records ONLY what the chain
// says about that transaction. The integrity chain: the plan came from the
// server's live reads, the envelope is built from exactly that plan, the wire
// is re-verified server-side before the wallet sees it, and the outcome comes
// only from a receipt.
async function onSubmitOutside(plan) {
  const w = S.wallet?.signer;
  if (!w) {
    showActionError('The wallet is not connected any more - connect it again to sign this.');
    invalidatePlan();
    return;
  }
  // Plain-words mirror of the server's control 1 (signer == the chain-named
  // controller). The server refuses too; saying it here saves a pointless popup.
  if (norm(w.address) !== norm(plan.controller)) {
    showActionError(`Wrong wallet: ${w.walletName ?? 'the wallet'} (${short(w.address, 10, 6)}) is not ` +
      `the controller this gate names on chain (${short(plan.controller, 10, 6)}). ` +
      'Only the controller\'s signature can authorize this gate.');
    return;
  }
  S.busy = 'submit';
  S.receiptTries = 0;
  showActionError(null);
  renderSubmitPanel();
  try {
    const authorization = await w.authorizeCalls({
      chainId: plan.chainId,
      caller: plan.caller,
      nonce: plan.nonce,
      executeAfter: plan.executeAfter,
      executeBefore: plan.executeBefore,
      calls: plan.calls,
    });
    // The server re-verifies the authorization (the same guard and four
    // controls as the relay) and hands the wire call back UNRELAYED (OBS-31):
    // the wallet's signing simulation cannot model a controller-bound
    // self-call carried by a third party, but it models the wallet's OWN
    // transaction calling execute_from_outside_v2 exactly right.
    const wire = await api('/api/outside/wire', {
      proposalId: plan.proposalId,
      authorization,
    });
    const txHash = await w.executeCalls([{
      contractAddress: wire.to, entrypoint: wire.entrypoint, calldata: wire.calldata,
    }]);
    const out = await api('/api/outside/record', {
      proposalId: plan.proposalId,
      txHash,
    });
    if (!out.recorded) {
      throw new Error('the console could not record the transaction your wallet sent');
    }
    await loadProposals(true);

    S.busy = 'receipt';
    S.flash = {
      kind: 'ok',
      text: `Signed in your wallet and sent by your wallet. tx ${txHash} — waiting for the chain to confirm…`,
    };
    render();
    const receipt = await pollReceipt(txHash, {
      onTick: (i) => { S.receiptTries = i; renderSubmitPanel(); },
    });
    await loadProposals(true);
    S.busy = null;
    if (receipt?.execution_status === 'SUCCEEDED') {
      S.flash = {
        kind: 'ok',
        text: `Executed on chain. tx ${txHash} — authorized and carried by your own wallet, confirmed by Starknet.`,
      };
    } else if (receipt?.execution_status === 'REVERTED') {
      S.flash = { kind: 'danger', text: `The transaction reverted: ${receipt.revert_reason ?? 'no reason returned'}` };
    } else {
      S.flash = {
        kind: 'danger',
        text: `Relayed (tx ${txHash}) but the chain had not confirmed within two minutes. The record honestly says BROADCAST; "Read again" keeps looking for the receipt.`,
      };
    }
    render();
  } catch (e) {
    S.busy = null;
    const message = String(e?.message ?? e);
    showActionError(message);
    // A stale window or a burned nonce means the PLAN went stale (or the
    // authorization was already used): drop it so the next render re-plans
    // with a fresh nonce and window. Any other refusal (a cancelled popup, a
    // server guard) keeps the plan - retrying signs the same valid plan again.
    if (/window|nonce/i.test(message)) {
      invalidatePlan();
    } else {
      renderSubmitPanel();
    }
  }
}

// ------------------------------------------------------------------ bindings

function bindScreen() {
  if (S.route === 'mandate') {
    renderUpgradePanel();
    loadUpgradeStatus();
  }
  if (S.route === 'proposals') {
    $('#ask-form')?.addEventListener('submit', onAsk);
  }
  if (S.route === 'approvals') {
    bindApprovals();
  }
  if (S.route === 'resume') {
    bindResume();
  }
}

function bindResume() {
  $('#ladder-to')?.addEventListener('change', (e) => {
    S.ladderForm.to = e.target.value;
    invalidateLadderPreview();
  });
  $('#ladder-reason')?.addEventListener('input', (e) => {
    S.ladderForm.reason = e.target.value;
    invalidateLadderPreview();
  });
  $('#ladder-preview-btn')?.addEventListener('click', onLadderPreview);
  $('#ladder-sign-btn')?.addEventListener('click', onLadderSign);
  $('#ladder-forget-btn')?.addEventListener('click', () => {
    S.signers.ladder = null;
    const input = $('#resume-key');
    if (input) input.value = '';
    renderLadderKeyStatus();
  });

  const keyInput = $('#resume-key');
  if (keyInput) keyInput.addEventListener('input', readResumeKey);

  $('#witness-new-key')?.addEventListener('input', (e) => {
    S.witnessForm.witness = e.target.value;
    invalidateWitnessPreview();
  });
  $('#witness-reason')?.addEventListener('input', (e) => {
    S.witnessForm.reason = e.target.value;
    invalidateWitnessPreview();
  });
  $('#witness-preview-btn')?.addEventListener('click', onWitnessPreview);
  $('#witness-sign-btn')?.addEventListener('click', onWitnessSign);
  $('#witness-forget-btn')?.addEventListener('click', () => {
    S.signers.witness = null;
    const input = $('#witness-owner-key');
    if (input) input.value = '';
    renderWitnessKeyStatus();
  });
  const witnessKeyInput = $('#witness-owner-key');
  if (witnessKeyInput) witnessKeyInput.addEventListener('input', readWitnessKey);

  renderAnchorPanel();
  renderLadderPreview();
  renderLadderKeyStatus();
  renderWitnessPreview();
  renderWitnessKeyStatus();
}

function invalidateLadderPreview() {
  if (S.ladderPreview || S.ladderPreviewError) {
    S.ladderPreview = null;
    S.ladderPreviewError = null;
    renderLadderPreview();
    renderLadderKeyStatus();
  }
}

function bindApprovals() {
  syncAmendVisibility();

  for (const radio of $$('input[name="resolution"]')) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      S.form.type = radio.value;
      syncAmendVisibility();
      invalidatePreview();
    });
  }

  $('#amend-kind')?.addEventListener('change', (e) => {
    S.form.kind = e.target.value;
    syncAmendVisibility();
    invalidatePreview();
  });
  $('#amend-cap')?.addEventListener('input', (e) => {
    S.form.cap = e.target.value;
    invalidatePreview();
  });
  $('#amend-window')?.addEventListener('input', (e) => {
    S.form.windowCap = e.target.value;
    invalidatePreview();
  });
  $('#amend-recipient')?.addEventListener('input', (e) => {
    S.form.recipient = e.target.value;
    invalidatePreview();
  });

  $('#preview-btn')?.addEventListener('click', onPreview);
  $('#sign-btn')?.addEventListener('click', onSign);
  $('#forget-btn')?.addEventListener('click', () => {
    S.signers.approvals = null;
    S.wallet = null;
    const input = $('#owner-key');
    if (input) input.value = '';
    renderKeyStatus();
    renderWalletCard();
  });

  const keyInput = $('#owner-key');
  if (keyInput) keyInput.addEventListener('input', readKey);

  renderPreviewPanel();
  renderKeyStatus();
  renderWalletCard();
  renderSubmitPanel();
}

function syncAmendVisibility() {
  const fields = $('#amend-fields');
  if (!fields) return;
  fields.hidden = S.form.type !== 'amend';
  const kind = $('#amend-kind')?.value ?? S.form.kind;
  const which = kind === 'raise-per-call-cap' ? 'raise'
    : kind === 'raise-window-cap' ? 'window' : 'allow';
  for (const el of $$('[data-amend]')) {
    el.hidden = el.dataset.amend !== which;
  }
}

function invalidatePreview() {
  if (S.preview || S.previewError) {
    S.preview = null;
    S.previewError = null;
    renderPreviewPanel();
    renderKeyStatus();
  }
}

// ------------------------------------------------------------------ delegated clicks

document.addEventListener('click', async (event) => {
  // Wallet card buttons live in a re-rendered box, so they are delegated here
  // instead of bound per render.
  const wconnect = event.target.closest('[data-wallet-connect]');
  if (wconnect) {
    await onWalletConnect(wconnect.dataset.walletConnect);
    return;
  }
  const wdisconnect = event.target.closest('[data-wallet-disconnect]');
  if (wdisconnect) {
    const walletSigner = S.wallet?.signer ?? null;
    S.wallet = null;
    S.signers.approvals = null;
    // The résumé's owner slots are filled from the wallet on connect; on
    // disconnect only what the wallet filled is released - a pasted key
    // survives, the same "last deliberate action wins" rule the slots use.
    if (S.signers.ladder?.signer === walletSigner) S.signers.ladder = null;
    if (S.signers.witness?.signer === walletSigner) S.signers.witness = null;
    S.anchorPlan = null;
    S.anchorPlanError = null;
    renderWalletCard();
    renderKeyStatus();
    renderLadderKeyStatus();
    renderWitnessKeyStatus();
    renderAnchorPanel();
    // The submit mode may have flipped wallet -> pasted key; the plan shapes
    // differ, so re-plan (a no-op unless an executable proposal is selected).
    invalidatePlan();
    return;
  }

  const copy = event.target.closest('[data-copy]');
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      copy.textContent = 'Copied';
      copy.dataset.state = 'success';
      setTimeout(() => {
        copy.textContent = 'Copy';
        delete copy.dataset.state;
      }, 1400);
    } catch {
      copy.textContent = 'Copy failed';
      copy.dataset.state = 'error';
    }
    return;
  }

  const fill = event.target.closest('[data-fill-recipient]');
  if (fill) {
    const input = $('#ask-recipient');
    if (input) input.value = fill.dataset.fillRecipient;
    return;
  }

  const review = event.target.closest('[data-review]');
  if (review) {
    S.selected = review.dataset.review;
    S.form = null;
    S.preview = null;
    S.plan = null;
    S.planError = null;
    if (location.hash !== '#/approvals') location.hash = '#/approvals';
    else {
      render({ focus: true });
      ensureRouteData();
    }
    return;
  }

  const select = event.target.closest('[data-select]');
  if (select) {
    S.selected = select.dataset.select;
    S.preview = null;
    S.previewError = null;
    S.plan = null;
    S.planError = null;
    S.flash = null;
    render();
    loadPlanIfNeeded();
    return;
  }

  const action = event.target.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'refresh' || action.dataset.action === 'retry') {
    await refreshAll();
  } else if (action.dataset.action === 'submit') {
    await onSubmit();
  } else if (action.dataset.action === 'anchor') {
    await onAnchor();
  } else if (action.dataset.action === 'anchor-retry') {
    S.anchorError = null;
    renderAnchorPanel();
  } else if (action.dataset.action === 'anchor-replan') {
    invalidateAnchorPlan();
  } else if (action.dataset.action === 'anchor-wallet-off') {
    // Explicit fallback: disconnect the wallet (the one thing that chooses the
    // anchor mode) and show the pasted-key panel again. The wallet also fills
    // the ladder and witness slots on connect, so what it filled is released
    // here too - a pasted key in either slot survives.
    const walletSigner = S.wallet?.signer ?? null;
    S.wallet = null;
    if (S.signers.ladder?.signer === walletSigner) S.signers.ladder = null;
    if (S.signers.witness?.signer === walletSigner) S.signers.witness = null;
    S.anchorPlan = null;
    S.anchorPlanError = null;
    renderAnchorPanel();
    renderLadderKeyStatus();
    renderWitnessKeyStatus();
  } else if (action.dataset.action === 'tx-use-key') {
    // Explicit fallback: disconnect the wallet (the one thing that chooses the
    // submit mode) and re-plan in pasted-key mode.
    S.wallet = null;
    S.signers.approvals = null;
    renderWalletCard();
    renderKeyStatus();
    invalidatePlan();
  } else if (action.dataset.action === 'replan') {
    invalidatePlan();
  } else if (action.dataset.action === 'forget-tx-key') {
    S.signers.tx = null;
    const input = $('#tx-key');
    if (input) input.value = '';
    renderTxKeyStatus();
  } else if (action.dataset.action === 'forget-anchor-key') {
    S.signers.anchor = null;
    const input = $('#anchor-key');
    if (input) input.value = '';
    renderAnchorKeyStatus();
    const btn = $('#anchor-send-btn');
    if (btn && btn.dataset.anchored !== 'true') btn.disabled = true;
  } else if (action.dataset.action === 'upgrade-plan') {
    await onUpgradePlan();
  } else if (action.dataset.action === 'upgrade-ack') {
    // The loud confirmation: an explicit button, per priced plan. Re-pricing
    // or refreshing resets it - it is never a sticky checkbox.
    S.upgradeAck = true;
    S.upgradeError = null;
    renderUpgradePanel();
  } else if (action.dataset.action === 'upgrade-replan') {
    S.upgradePlan = null;
    S.upgradePlanError = null;
    S.upgradeAck = false;
    renderUpgradePanel();
  } else if (action.dataset.action === 'upgrade-retry') {
    S.upgradeError = null;
    renderUpgradePanel();
    loadUpgradeStatus(true);
  } else if (action.dataset.action === 'upgrade-send') {
    await onUpgradeSend();
  } else if (action.dataset.action === 'forget-upgrade-key') {
    S.signers.upgrade = null;
    const input = $('#upgrade-key');
    if (input) input.value = '';
    renderUpgradeKeyStatus();
  } else if (action.dataset.action === 'dismiss-flash') {
    S.flash = null;
    $('#flash')?.remove();
  }
});

// ------------------------------------------------------------------ start

$('#skip-link')?.addEventListener('click', () => {
  const view = $('#view');
  if (!view) return;
  view.focus({ preventScroll: true });
});

$('#refresh')?.addEventListener('click', () => { refreshAll(); });

window.addEventListener('hashchange', navigate);

S.route = routeFromHash();
render();
// The status bar reads the mandate on every screen, so it loads unconditionally.
// ensureRouteData then loads whatever THIS route needs - without it, opening the
// console straight on #/audit or #/resume would show a skeleton forever.
// Anything the chain already confirmed but this tab never saw (a BROADCAST left
// over from a closed tab) settles from its receipt on load.
Promise.allSettled([loadMandate(), loadProposals()])
  .then(() => settleBroadcastSubmissions())
  .then(() => render());
ensureRouteData();
setInterval(renderStatus, 1000);
