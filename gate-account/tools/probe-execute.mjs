// Offline probe: reproduce owner-tx execute() failures WITHOUT broadcasting.
// account.getSignedTransaction runs the same prepareInvoke/sign path as execute but
// never submits - the safest possible repro for anything that spends (OBS-10).
//
// FOUND (2026-10-24, Layer C demo run 1): starknet.js v10 computes the v3 tx hash
// locally on the owner path; encodeResourceBoundsL1 does BigInt shifts directly on
// resourceBounds, so hex-STRING bounds throw "Cannot mix BigInt and other types".
// Variants A-C (string bounds, any tip) fail; D (estimate bounds untouched) and
// E (BigInt-padded in place - the owner-tx.mjs fix) sign fine. The agent/session
// path never computes a tx hash, which is why string bounds worked in Stage 2.
import { readFileSync } from 'node:fs';
import * as sn from 'starknet';

const state = JSON.parse(
  readFileSync(new URL('../.sepolia/state.json', import.meta.url), 'utf8'));
const RPC = state.rpc_endpoints_verified.cartridge.url;
const GATE = state.contracts.gate_account.address;
const OWNER_PRIV = state.keys.owner.private_key;
const SESSION = state.keys.agent_session.session_public_key;
const TOKEN = state.contracts.token.address;

const snCalls = [{
  contractAddress: GATE,
  entrypoint: 'set_spending_policy',
  calldata: [SESSION, TOKEN, '0x14', '0x0', '0x64', '0x0', '0x278d00'],
}];

async function tryVariant(label, detailsExtra, buildBounds) {
  const provider = new sn.RpcProvider({ nodeUrl: RPC });
  const account = new sn.Account({ provider, address: GATE, signer: OWNER_PRIV, cairoVersion: '1' });
  const nonce = await provider.getNonceForAddress(GATE);
  try {
    const est = await account.estimateInvokeFee(snCalls, { nonce, ...detailsExtra });
    const pad = (v, m) => '0x' + Math.ceil(Number(v) * m).toString(16);
    const hex = (v) => '0x' + BigInt(v).toString(16);
    const rb = est.resourceBounds;
    const resourceBounds = buildBounds ? buildBounds(rb, pad, hex) : rb;
    const signed = await account.getSignedTransaction(snCalls,
      { nonce, resourceBounds, ...detailsExtra });
    console.log(`[${label}] OK - signed tx hash:`, signed.hash ?? signed.transaction_hash ?? '(built)');
    return true;
  } catch (e) {
    console.log(`[${label}] THREW:`, e?.message);
    console.log((e?.stack ?? '').split('\n').slice(1, 6).join('\n'));
    return false;
  }
}

const sameBoundsAsOwnerTx = (rb, pad, hex) => ({
  l2_gas: { max_amount: pad(rb.l2_gas.max_amount, 3), max_price_per_unit: hex(rb.l2_gas.max_price_per_unit) },
  l1_gas: { max_amount: hex(rb.l1_gas.max_amount), max_price_per_unit: hex(rb.l1_gas.max_price_per_unit) },
  l1_data_gas: { max_amount: pad(rb.l1_data_gas.max_amount, 2), max_price_per_unit: hex(rb.l1_data_gas.max_price_per_unit) },
});

// Variant A: exactly what owner-tx.mjs does (no tip passed).
const a = await tryVariant('A: no tip', {}, sameBoundsAsOwnerTx);
// Variant B: explicit tip 0 (number).
if (!a) await tryVariant('B: tip 0 number', { tip: 0 }, sameBoundsAsOwnerTx);
// Variant C: explicit tip '0x0' string.
if (!a) await tryVariant('C: tip hex string', { tip: '0x0' }, sameBoundsAsOwnerTx);
// Variant D: pass the estimate's resourceBounds through UNTOUCHED (may contain BigInts).
if (!a) await tryVariant('D: untouched estimate bounds', {}, (rb) => rb);
// Variant E: the owner-tx.mjs FIX - keep estimate types, pad amounts as BigInt.
await tryVariant('E: bigint-padded (owner-tx fix)', {}, (rb) => {
  rb.l2_gas.max_amount = BigInt(rb.l2_gas.max_amount) * 3n;
  rb.l1_data_gas.max_amount = BigInt(rb.l1_data_gas.max_amount) * 2n;
  return rb;
});
