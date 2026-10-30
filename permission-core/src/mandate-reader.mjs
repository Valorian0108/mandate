// Reads the user's LIVE mandate off Starknet Sepolia and turns it into the policy
// snapshot the spending gate evaluates against. Zero dependencies - plain JSON-RPC
// over fetch to the keyless Cartridge endpoint (verified working in Stage 2).
//
// What is read from the chain (authoritative):
//   get_session_data(session)          -> validUntil, maxCalls, callsUsed, entrypoints COUNT
//   get_spending_policy(session,token) -> caps, window, spentInWindow, windowStart
//   is_recipient_allowed(...)          -> true/false per candidate recipient
//
// One honest limitation: the v0.2 contract has no view that ENUMERATES the whitelist
// (it is a per-recipient map), so the candidate list comes from the registration
// record (.sepolia/state.json - in the product, from the events the app indexes when
// the owner registers merchants). To keep that record from drifting from the chain
// (OBS-08's lesson), the reader cross-checks the recorded selector count against the
// chain's allowed_entrypoints_len and throws if they disagree.

import { readFileSync } from 'node:fs';

// The discontinued default. Cartridge killed this public endpoint on 2026-10-30
// (HTTP 410 "starknet sepolia is discontinued and no longer served"); it stays
// only so call() has a loud-failing fallback when no rpcUrl is injected.
// readLiveMandate passes the live URL from the state file, and the evidence of
// the 410 is recorded in that file's rpc_endpoints_verified.dead list.
const RPC = 'https://api.cartridge.gg/x/starknet/sepolia';

let rpcId = 0;

// The JSON-RPC wire carries felts as hex strings. Callers hand them over in
// mixed shapes - state.json records hex strings, web/tx-signer.js's
// selectorFromName returns BigInt - and JSON.stringify THROWS on BigInt (and
// silently turns undefined into null inside arrays). Normalise every felt
// position here so the wire shape is this module's job alone, and anything
// that is not a felt fails loudly. This seam was live: the server's get_owner
// fallback - the ONLY key path on a real Ready X controller - died on "Do not
// know how to serialize a BigInt" (found on the 2026-10-26 live pass).
const felt = (v) => '0x' + BigInt(v).toString(16);

// timeoutMs is a loud-failure control, not a convenience (OBS-35): the owner's
// "Read again" once spun forever because a silent node met a fetch with no
// deadline. A dead chain must surface as an error the UI can show, never as an
// endless spinner. rpcUrl is injectable so tests can prove exactly that.
export async function call(contract, selector, calldata, { rpcUrl = RPC, timeoutMs = 20_000 } = {}) {
  let json;
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'starknet_call',
        params: {
          request: {
            contract_address: felt(contract),
            entry_point_selector: felt(selector),
            calldata: (calldata ?? []).map(felt),
          },
          block_id: 'latest',
        },
      }),
    });
    json = await res.json();
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`the chain node did not answer within ${timeoutMs / 1000}s - ` +
        'the read failed loudly instead of hanging');
    }
    throw e;
  }
  if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
  return json.result;
}

const u256 = (low, high) => BigInt(low) + (BigInt(high) << 128n);

// statePath defaults to the gate-account run's state file.
export async function readLiveMandate(statePath) {
  const path = statePath ??
    new URL('../../gate-account/.sepolia/state.json', import.meta.url);
  const state = JSON.parse(readFileSync(path, 'utf8'));

  // Follow the run's own record for which node to read from (the OBS-40
  // candidate-list precedent): the verified endpoint lives in the state file,
  // under its historical `cartridge` key, and the module default above is a
  // discontinued endpoint that must never be used silently. Missing record =
  // loud failure, not a guess.
  const rpcUrl = state.rpc_endpoints_verified?.cartridge?.url;
  if (!rpcUrl) {
    throw new Error('state file has no rpc_endpoints_verified.cartridge.url - ' +
      'refusing to read the chain through a hardcoded endpoint');
  }
  const opts = { rpcUrl };

  const GATE = state.contracts.gate_account.address;
  const TOKEN = state.contracts.token.address;
  const SESSION = state.keys.agent_session.session_public_key;
  const sel = state.selectors;

  // Candidate recipients = the ones the owner registered (see the limitation note).
  const candidates = state.mandate.merchant_allowlist.allowed;
  // Selectors recorded at registration; count-checked against the chain below.
  const recordedSelectors = state.mandate.session.allowed_entrypoints
    .map((name) => sel[name]);

  const [sessionRaw, policyRaw] = await Promise.all([
    call(GATE, sel.get_session_data, [SESSION], opts),
    call(GATE, sel.get_spending_policy, [SESSION, TOKEN], opts),
  ]);
  const allowedFlags = await Promise.all(
    candidates.map((r) => call(GATE, sel.is_recipient_allowed, [SESSION, TOKEN, r], opts)),
  );

  const [validUntil, maxCalls, callsUsed, entrypointsLen] = sessionRaw.map(BigInt);
  if (Number(entrypointsLen) !== recordedSelectors.length) {
    throw new Error(
      `registration record says ${recordedSelectors.length} whitelisted selectors but the ` +
      `chain says ${entrypointsLen} - the record drifted from the chain, refusing to guess`,
    );
  }
  if (policyRaw.length !== 8) {
    throw new Error(`get_spending_policy returned ${policyRaw.length} felts, expected 8 ` +
      '(is the policy missing? a missing policy returns zeros but still 8 felts)');
  }

  return {
    sessionPublicKey: SESSION,
    validUntil: Number(validUntil),
    maxCalls: Number(maxCalls),
    callsUsed: Number(callsUsed),
    allowedEntrypointsLen: Number(entrypointsLen),
    allowedSelectors: recordedSelectors,
    token: TOKEN,
    maxPerCall: u256(policyRaw[0], policyRaw[1]),
    maxPerWindow: u256(policyRaw[2], policyRaw[3]),
    windowSeconds: Number(BigInt(policyRaw[4])),
    spentInWindow: u256(policyRaw[5], policyRaw[6]),
    windowStart: Number(BigInt(policyRaw[7])),
    allowedRecipients: candidates.filter((_, i) => BigInt(allowedFlags[i][0]) === 1n),
  };
}
