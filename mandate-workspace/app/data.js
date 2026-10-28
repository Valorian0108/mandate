// The data layer. Every call the app makes, in one place, with honest errors.
//
// This file is the machine layer: it speaks the tested server's own vocabulary
// (proposals, resolutions, submissions, tx hashes) so the screens never have to.
// It is exempt from the jargon gate for identifiers, and it is forbidden from
// rendering anything: no HTML in here, and no string from here may reach a
// screen untranslated (vocab.plainError does the translating).
//
// Endpoints used, all of them existing and tested:
//   GET  /api/health        liveness
//   GET  /api/mandate       the live rules, read from the network
//   GET  /api/proposals     every request + every payment attempt
//   GET  /api/audit         the same, enriched with proof checks
//   POST /api/requests      file an ask, get the decision back
//   POST /api/preview       what a decision would do, before confirming
//   POST /api/resolve       record the owner's decision (needs their signature)
//   POST /api/plan          the exact instructions a decision produces
//   POST /api/tx/plan       price a submission for in-tab signing
//   POST /api/broadcast     relay a finished, signed submission
//   GET  /api/tx/receipt    the network's answer for one submission
//   POST /api/outside/plan  price a wallet-carried decision
//   POST /api/outside/submit relay a wallet-signed decision
//   POST /api/outside/record adopt a wallet-submitted decision from the network

/** One call. Throws Error(serverMessage) on any non-2xx; never invents data. */
export async function call(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? { headers: { accept: 'application/json' } } : {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`failed to fetch ${path}: ${e?.message ?? e}`);
  }
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  if (!res.ok) {
    const msg = json?.error ?? text ?? `HTTP ${res.status}`;
    const err = new Error(String(msg));
    err.status = res.status;
    err.path = path;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------- reads

export const getHealth = () => call('/api/health');
export const getMandate = () => call('/api/mandate');
export const getProposals = () => call('/api/proposals');
export const getAudit = () => call('/api/audit');

// ---------------------------------------------------------------- writes

/** File an ask. The server decides; nothing here guesses the outcome. */
export const fileAsk = (recipient, amount) => call('/api/requests', { recipient, amount });

/** What a decision would do, before the owner confirms it. */
export const previewResolution = (proposalId, resolution) =>
  call('/api/preview', { proposalId, resolution });

/** Record the owner's decision. Requires their signature. */
export const resolveProposal = (proposalId, resolution, signature) =>
  call('/api/resolve', { proposalId, resolution, signature });

/** The exact instructions a resolved decision produces. */
export const planProposal = (proposalId) => call('/api/plan', { proposalId });

/** Price an in-tab signing (nonce + resource bounds come from the server). */
export const txPlan = (proposalId) => call('/api/tx/plan', { proposalId });

/** Relay a finished, signed submission. The server cannot build or sign one. */
export const broadcast = (payload) => call('/api/broadcast', payload);

/** The network's own answer for one submission. */
export const receipt = (txHash) =>
  call(`/api/tx/receipt?txHash=${encodeURIComponent(txHash)}`);

/** Price a wallet-carried decision. */
export const outsidePlan = (proposalId) => call('/api/outside/plan', { proposalId });

/** Relay a wallet-signed decision. */
export const outsideSubmit = (payload) => call('/api/outside/submit', payload);

/** The wire form of a wallet-carried decision: the server re-verifies the
 *  authorization against the chain and returns the call UNRELAYED (OBS-31). */
export const outsideWire = (proposalId, authorization) =>
  call('/api/outside/wire', { proposalId, authorization });

/** Adopt a decision the wallet submitted itself, read back from the network. */
export const outsideRecord = (proposalId, txHash) =>
  call('/api/outside/record', { proposalId, txHash });

// ---------------------------------------------------------------- polling

/**
 * Poll for a final receipt. Copied discipline from the tested console: a dead
 * node must surface as an error, never as an endless spinner.
 */
export async function pollReceipt(txHash, { tries = 30, everyMs = 4000, onTick } = {}) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      last = await receipt(txHash);
    } catch (e) {
      last = { error: String(e?.message ?? e) };
    }
    if (onTick) onTick(i + 1, tries, last);
    const status = String(last?.status ?? last?.finality_status ?? '').toUpperCase();
    if (['SUCCEEDED', 'REVERTED', 'ACCEPTED_ON_L1', 'ACCEPTED_ON_L2'].includes(status)) {
      return last;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, everyMs));
  }
  return last;
}
