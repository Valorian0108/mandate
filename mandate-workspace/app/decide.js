// crypto-surface:start
// The decision machine layer. This whole file is ONE crypto-surface block: it
// is the only module in this app allowed to touch wallets, digests, signatures
// and wire calls, and the only source of the machine-detail HTML the popup and
// the receipt drawer show. app.js stays plain-language and calls these
// functions; the jargon gate (tools/check-jargon.mjs) scans this file too, and
// the fence is what makes that legal.
//
// Everything here is ported from the tested console (permission-core/web/app.js)
// with its guards intact:
//   currentResolution -> resolutionFromChoice   (same shapes, same validations)
//   resolutionNote    -> noteFor                (verbatim: what the owner reads
//                                                in the wallet before confirming)
//   onPreview         -> buildPreview           (POST /api/preview + the local
//                                                digest recompute + matches flag)
//   onSign            -> signResolution         (the same four guards, same order)
//   onSubmitOutside   -> submitViaWallet        (authorize -> wire -> send ->
//                                                record; requires `recorded`)
// The guards are the product: a signature is only ever produced over a digest
// THIS browser computed itself and found identical to the server's, for a
// decision whose fingerprint has not moved since the preview.

import { resolutionDigest } from '/signer.js';
import { connectWallet, detectWallets, short } from '/wallet.js';
import {
  previewResolution, resolveProposal, outsidePlan, outsideWire, outsideRecord,
} from './data.js';

const norm = (a) => String(a ?? '').toLowerCase().replace(/^0x0+/, '0x');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Same shortener the console's resolutionNote used.
function shortAddress(address) {
  const a = String(address ?? '');
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// ---------------------------------------------------------------- wallets

/** Which account apps this browser exposes, for the picker. Never throws. */
export function walletChoices(win = globalThis) {
  try {
    return detectWallets(win).map((w) => ({ id: w.id, name: w.name }));
  } catch {
    return [];
  }
}

/**
 * Connect the owner's wallet through the tested phase-3 gate: the wallet must
 * be on the mandate's chain, and its key - read FROM THE CHAIN by two
 * independent readers, never taken from the extension's word - must BE the
 * owner key the mandate names. Every refusal throws with the machine's reason;
 * vocab.plainError translates it before any screen shows it.
 */
export async function connectOwnerWallet({ mandate, walletId = null }) {
  if (!mandate?.chainId || !mandate?.gate) {
    throw new Error('the live account is not loaded - reload it before confirming');
  }
  if (!mandate?.ownerPublicKey) {
    throw new Error('the owner key on chain is not loaded - refusing to connect blind');
  }
  return connectWallet({
    expectedChainId: mandate.chainId,
    ownerPublicKey: mandate.ownerPublicKey,
    walletId,
  });
}

// ---------------------------------------------------------------- resolution

/**
 * The decision object the server validates and the digest binds. Ported from
 * the console's currentResolution: same three types, same amendment shapes,
 * same positive-whole-number guards. `token` comes from the LIVE mandate, never
 * from the form.
 */
export function resolutionFromChoice({ choice, form, token }) {
  if (choice === 'once') return { type: 'execute-once' };
  if (choice === 'decline') return { type: 'decline' };
  if (!token) {
    throw new Error('the live mandate is not loaded - read the account again before confirming');
  }
  const kind = form?.kind;
  if (kind === 'raise-per-call-cap') {
    const cap = String(form?.cap ?? '').trim();
    if (!/^\d+$/.test(cap) || BigInt(cap) <= 0n) {
      throw new Error('the new per-purchase limit must be a positive whole number');
    }
    return { type: 'amend', amendment: { kind, token, maxPerCall: cap } };
  }
  if (kind === 'raise-window-cap') {
    const win = String(form?.windowCap ?? '').trim();
    if (!/^\d+$/.test(win) || BigInt(win) <= 0n) {
      throw new Error('the new monthly budget must be a positive whole number');
    }
    return { type: 'amend', amendment: { kind, token, maxPerWindow: win } };
  }
  const recipient = String(form?.recipient ?? '').trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(recipient)) {
    throw new Error('this request carries no recipient to approve');
  }
  return { type: 'amend', amendment: { kind: 'allow-recipient', token, recipient } };
}

/**
 * What the owner reads in their wallet before confirming. Verbatim port of the
 * console's resolutionNote: it describes the same resolution the digest binds;
 * the server never trusts this text for policy.
 */
export function noteFor(proposal, resolution) {
  if (resolution.type === 'execute-once') {
    const ctx = proposal?.request?.context ?? {};
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

// ---------------------------------------------------------------- preview

/**
 * The preview plus the browser's OWN digest over the server's proposal +
 * resolution. `matches` false means the two computations disagree - signResolution
 * refuses to continue when they do. `fingerprint` detects the decision moving
 * after the preview (the console's previewIsCurrent rule).
 */
export async function buildPreview(proposalId, resolution) {
  const out = await previewResolution(proposalId, resolution);
  const localDigest = resolutionDigest(out.proposal, out.resolution);
  return {
    ...out,
    localDigest,
    matches: localDigest === out.digest,
    fingerprint: JSON.stringify(out.resolution),
  };
}

export function previewIsCurrent(preview, resolution) {
  if (!preview) return false;
  try {
    return preview.fingerprint === JSON.stringify(resolution);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- stage 1: decide

/**
 * Sign the resolution in the wallet and record it on the server. The same four
 * guards as the console's onSign, in the same order:
 *   1. the decision has not moved since the preview (fingerprint),
 *   2. the connected account app holds the owner key the chain names,
 *   3. the browser's digest equals the server's,
 *   4. the live mandate is loaded (chain + gate present).
 * Only then does the wallet popup open, and only over the local digest.
 */
export async function signResolution({ mandate, signer, preview, resolution, proposalId }) {
  if (!previewIsCurrent(preview, resolution)) {
    throw new Error('the decision changed after the preview - review it again before confirming');
  }
  const check = signer?.checkAgainst?.(mandate?.ownerPublicKey);
  if (!check?.matches) {
    throw new Error('the connected account app does not hold the owner key on chain - ' +
      'the server would reject the signature');
  }
  const localDigest = resolutionDigest(preview.proposal, resolution);
  if (localDigest !== preview.digest) {
    throw new Error('the browser and the server computed different digests - refusing to sign');
  }
  if (!mandate?.chainId || !mandate?.gate) {
    throw new Error('the live account is not loaded - reload it before confirming');
  }
  const signature = await signer.signMandateAction({
    chainId: mandate.chainId,
    accountAddress: mandate.gate,
    kind: 'resolution',
    digest: localDigest,
    note: noteFor(preview.proposal, resolution),
  });
  const out = await resolveProposal(proposalId, resolution, signature);
  return { proposal: out?.proposal ?? null, signature, digest: localDigest };
}

// ---------------------------------------------------------------- stage 2: land it

/** Price the wallet-carried submission: fresh one-shot nonce + window + calls. */
export const planSubmission = (proposalId) => outsidePlan(proposalId);

/** Is the connected account app the controller the gate names on chain? */
export function controllerIs(signer, plan) {
  return norm(signer?.address) === norm(plan?.controller);
}

/**
 * The full outside-execution sequence, ported from the console's
 * onSubmitOutside: SNIP-9 authorization (wallet popup) -> the server re-verifies
 * and returns the wire call UNRELAYED -> the wallet sends it as its OWN
 * transaction (OBS-31) -> the server adopts it read back from the chain.
 * `recorded` is required: an unrecorded send is an error, never a success.
 * onStage receives the machine step names: authorize | wire | send | record.
 */
export async function submitViaWallet({ signer, plan, onStage }) {
  if (!signer) {
    throw new Error('the wallet is not connected any more - connect it again');
  }
  // Plain mirror of the server's control 1 (signer == the chain-named
  // controller). The server refuses too; failing here saves a pointless popup.
  if (!controllerIs(signer, plan)) {
    throw new Error(`wrong wallet: ${signer.walletName ?? 'the wallet'} (${short(signer.address, 10, 6)}) ` +
      `is not the controller this gate names on chain (${short(plan?.controller, 10, 6)}) - ` +
      "only the controller's signature can authorize this gate");
  }
  onStage?.('authorize');
  const authorization = await signer.authorizeCalls({
    chainId: plan.chainId,
    caller: plan.caller,
    nonce: plan.nonce,
    executeAfter: plan.executeAfter,
    executeBefore: plan.executeBefore,
    calls: plan.calls,
  });
  onStage?.('wire');
  const wire = await outsideWire(plan.proposalId, authorization);
  onStage?.('send');
  const txHash = await signer.executeCalls([{
    contractAddress: wire.to, entrypoint: wire.entrypoint, calldata: wire.calldata,
  }]);
  onStage?.('record');
  const out = await outsideRecord(plan.proposalId, txHash);
  if (!out?.recorded) {
    throw new Error('the server could not record the transaction your wallet sent');
  }
  return { txHash, record: out, wire };
}

// ---------------------------------------------------------------- machine html

// The renderers below produce the ONLY machine-detail HTML this app shows: the
// dark strip in the confirmation popup and the receipt drawer's contents. Dark
// instrument-panel styling on purpose (same language as the drawer): it reads
// as "behind the scenes". Every value is escaped; nothing here is trusted.

function mrow(k, v) {
  return `<div class="machine-row"><span class="machine-k">${esc(k)}</span><span class="machine-v">${esc(v)}</span></div>`;
}

function mlabel(text) {
  return `<div class="machine-label">${esc(text)}</div>`;
}

function mstrip(inner, bad = false) {
  return `<div class="machine${bad ? ' machine-bad' : ''}">${inner}</div>`;
}

function callsHtml(calls) {
  if (!Array.isArray(calls) || !calls.length) return '';
  return calls.map((c, i) =>
    mrow(`call ${i + 1} to`, c.to ?? c.contractAddress ?? '') +
    mrow(`call ${i + 1} runs`, c.entrypoint ?? c.selector ?? '') +
    mrow(`call ${i + 1} data`, (c.calldata ?? []).join(' '))).join('');
}

function iso(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return String(unixSeconds ?? '');
  return new Date(n * 1000).toISOString();
}

/** The review strip: the digest both sides computed, the calls, the side effects. */
export function reviewMachineHtml(preview) {
  if (!preview) return '';
  const match = preview.matches
    ? mrow('digest check', `${preview.localDigest} - the browser and the server agree`)
    : mrow('digest check', `MISMATCH - server ${preview.digest} vs browser ${preview.localDigest}`);
  return mstrip(
    mlabel('what you are confirming') +
    mrow('digest', preview.digest ?? '') +
    match +
    mrow('decision', JSON.stringify(preview.resolution ?? null)) +
    (preview.calls?.length ? mlabel('the calls it produces') + callsHtml(preview.calls) : '') +
    (preview.sideEffects ?? []).map((s, i) => mrow(`side effect ${i + 1}`, s)).join('')
  );
}

/** The connected account app, as the chain reports it. */
export function walletMachineHtml(info) {
  if (!info) return '';
  return mstrip(
    mlabel('connected account app') +
    mrow('name', `${info.name} (${info.id})`) +
    mrow('address', info.address ?? '') +
    mrow('on-chain key', info.publicKey ?? '') +
    mrow('key read via', `${info.keyGetter ?? '?'} (${info.keySource ?? '?'})`) +
    mrow('chain', info.chainId ?? '')
  );
}

/** The picker shown when nothing is connected yet. */
export function walletPickerHtml(wallets, selectedId) {
  if (!wallets?.length) {
    return mstrip(mlabel('account apps in this browser') +
      mrow('found', 'none - the confirmation cannot happen in this browser'));
  }
  const btns = wallets.map((w) =>
    `<button class="mpick${selectedId === w.id ? ' is-on' : ''}" type="button" ` +
    `data-action="pick-app" data-id="${esc(w.id)}">${esc(w.name)}</button>`).join('');
  return mstrip(mlabel('confirm with') + `<div class="machine-pick">${btns}</div>`);
}

/** The one-line-ish progress strip: where the sequence is right now. */
export function stageMachineHtml(stage, ctx = {}) {
  const rows = [mrow('step', String(stage))];
  if (ctx.walletInfo) {
    rows.push(mrow('account app', `${ctx.walletInfo.name} · ${short(ctx.walletInfo.address, 10, 6)}`));
  }
  if (ctx.plan) {
    rows.push(
      mrow('controller', `${short(ctx.plan.controller, 10, 6)} · ${ctx.isController ? 'is this account app' : 'MISMATCH'}`),
      mrow('nonce', ctx.plan.nonce ?? ''),
      mrow('valid', `${iso(ctx.plan.executeAfter)} .. ${iso(ctx.plan.executeBefore)}`),
    );
  }
  if (ctx.txHash) rows.push(mrow('sent', ctx.txHash));
  if (ctx.tries) rows.push(mrow('receipt poll', String(ctx.tries)));
  return mstrip(rows.join(''));
}

/** The full plan, for the receipt drawer. `info` is the connected account app. */
export function planMachineHtml(plan, info) {
  if (!plan) return '';
  const who = info
    ? `${info.name} · ${short(info.address, 10, 6)} · ` +
      `${norm(info.address) === norm(plan.controller) ? 'IS the controller' : 'is NOT the controller'}`
    : 'unknown (the page was reloaded since)';
  return mstrip(
    mlabel('the submission plan') +
    mrow('chain', plan.chainId ?? '') +
    mrow('gate', plan.gate ?? '') +
    mrow('controller', plan.controller ?? '') +
    mrow('controller key', plan.controllerPublicKey ?? '') +
    mrow('this account app', who) +
    mrow('caller', plan.caller ?? '') +
    mrow('nonce', plan.nonce ?? '') +
    mrow('execute after', `${plan.executeAfter} (${iso(plan.executeAfter)})`) +
    mrow('execute before', `${plan.executeBefore} (${iso(plan.executeBefore)})`) +
    mrow('plan digest', plan.digest ?? '') +
    callsHtml(plan.calls) +
    (plan.sideEffects ?? []).map((s, i) => mrow(`side effect ${i + 1}`, s)).join('')
  );
}

/**
 * The network's verdict on a receipt, as a plain category word - so screens can
 * branch on the outcome without ever reading (or writing) machine fields.
 */
export function receiptOutcome(receipt) {
  const status = String(receipt?.execution_status ?? '').toUpperCase();
  if (status === 'SUCCEEDED') return 'succeeded';
  if (status === 'REVERTED') return 'reverted';
  return 'pending';
}

/** The machine's own words for a revert, for plainError + the machine strip. */
export function receiptErrorMessage(receipt) {
  return `the transaction reverted: ${receipt?.revert_reason ?? 'no reason returned'}`;
}

/** The confirmation the owner gave, for the receipt drawer. */
export function resolutionMachineHtml(sig) {
  if (!sig) return '';
  return mstrip(
    mlabel('your confirmation') +
    mrow('decision', JSON.stringify(sig.resolution ?? null)) +
    mrow('digest', sig.digest ?? '') +
    mrow('scheme', sig.signature?.scheme ?? '') +
    mrow('confirmed by', sig.signature?.signerAddress ?? '') +
    mrow('r', sig.signature?.r ?? '') +
    mrow('s', sig.signature?.s ?? '')
  );
}

/** The network's own answer, for the receipt drawer. */
export function receiptMachineHtml({ txHash, receipt, record } = {}) {
  const rows = [];
  if (txHash) rows.push(mrow('tx hash', txHash));
  if (receipt) {
    for (const k of ['status', 'execution_status', 'finality_status', 'revert_reason',
      'block_hash', 'block_number', 'actual_fee', 'type']) {
      const v = receipt[k];
      if (v !== undefined && v !== null && v !== '') {
        rows.push(mrow(k, typeof v === 'object' ? JSON.stringify(v) : String(v)));
      }
    }
  }
  if (record?.submission) rows.push(mrow('server record', JSON.stringify(record.submission)));
  if (!rows.length) return '';
  return mstrip(mlabel("the network's own answer") + rows.join(''));
}

/** The raw machine error, under the plain-language one. */
export function errorMachineHtml(message) {
  if (!message) return '';
  return mstrip(mlabel('what the machine said') + mrow('error', message), true);
}
// crypto-surface:end
