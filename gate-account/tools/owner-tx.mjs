// Owner-signed submitter: executes resolved proposals as REAL owner transactions
// on Starknet Sepolia.
//
// This is the other half of the proposal flow. The agent path (agent-tx.mjs) signs a
// session hash with the session key; THIS path is the ordinary one - the owner key
// signing the transaction hash, exactly what GateAccount's __validate__ checks when
// the signature has 2 elements (standard OpenZeppelin ECDSA, src/lib.cairo line ~240).
//
// Everything authoritative is read from ../.sepolia/state.json (addresses, owner key,
// RPC). Nothing is hardcoded from memory - the ISRC6_ID lesson.
//
// Usage:
//   node owner-tx.mjs --calls '<json>' [--dry-run]
//
//   <json> is the output of permission-core/src/resolutions.mjs:
//     [{"to":"0x..","entrypoint":"set_spending_policy","calldata":["0x..", ...]}]
//
//   --dry-run estimates and prints the exact transaction plan WITHOUT submitting.
//
// Output contract (for scripts): the last line is always
//   OWNER_TX_RESULT {"status":"DRY_RUN|SUCCEEDED|REVERTED|ERROR", ...}
// exit code 0 only for DRY_RUN / SUCCEEDED.
//
// TESTNET KEYS ONLY.
import { readFileSync } from 'node:fs';
import * as sn from 'starknet';

const state = JSON.parse(
  readFileSync(new URL('../.sepolia/state.json', import.meta.url), 'utf8'));
const RPC = state.rpc_endpoints_verified.cartridge.url;
const GATE = state.contracts.gate_account.address;
const OWNER_PRIV = state.keys.owner.private_key;
const OWNER_PUB = state.keys.owner.public_key;

function result(obj) {
  // BigInt-safe: padded resource bounds stay in the estimate's native BigInt type.
  console.log('OWNER_TX_RESULT ' + JSON.stringify(obj, (_, v) =>
    typeof v === 'bigint' ? '0x' + v.toString(16) : v));
}

function parseCalls(arg) {
  let calls;
  try {
    calls = JSON.parse(arg);
  } catch (e) {
    throw new Error(`--calls is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error('--calls must be a non-empty JSON array');
  }
  for (const c of calls) {
    if (!c?.to || !c?.entrypoint || !Array.isArray(c?.calldata)) {
      throw new Error(`each call needs {to, entrypoint, calldata[]}, got ${JSON.stringify(c)}`);
    }
    for (const f of c.calldata) {
      if (typeof f !== 'string' || !/^(0x[0-9a-fA-F]+|\d+)$/.test(f)) {
        throw new Error(`calldata felt must be a hex or decimal string, got ${JSON.stringify(f)}`);
      }
    }
  }
  return calls.map((c) => ({
    contractAddress: c.to,
    entrypoint: c.entrypoint,
    calldata: c.calldata,
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const i = args.indexOf('--calls');
  if (i === -1 || !args[i + 1]) {
    console.error('usage: node owner-tx.mjs --calls \'<json [{to,entrypoint,calldata}]>\' [--dry-run]');
    process.exit(2);
  }

  let snCalls;
  try {
    snCalls = parseCalls(args[i + 1]);
  } catch (e) {
    result({ status: 'ERROR', message: e.message });
    process.exit(1);
  }

  const provider = new sn.RpcProvider({ nodeUrl: RPC });

  // Sanity before spending anything: the key we are about to sign with must derive to
  // the owner public key recorded in state.json (which Stage 1 verified against the
  // chain itself). A wrong key file must fail HERE, not as a reverted transaction.
  const signer = new sn.Signer(OWNER_PRIV);
  const derived = (await signer.getPubKey()).toLowerCase();
  if (derived !== OWNER_PUB.toLowerCase()) {
    result({ status: 'ERROR', message: `owner key mismatch: derived ${derived}, state.json says ${OWNER_PUB}` });
    process.exit(1);
  }

  // starknet.js v10: Account takes ONE options object.
  const account = new sn.Account({ provider, address: GATE, signer, cairoVersion: '1' });

  const nonce = await provider.getNonceForAddress(GATE);
  console.log(`owner tx plan: ${snCalls.length} call(s) from ${GATE}`);
  for (const c of snCalls) {
    console.log(`  -> ${c.contractAddress} :: ${c.entrypoint} [${c.calldata.join(', ')}]`);
  }
  console.log(`nonce = ${nonce}`);

  try {
    // Same lesson as agent-tx.mjs: estimates run with SKIP_VALIDATE, so __validate__'s
    // ECDSA check is not priced in. Pad L2 gas x3, L1 data gas x2; unused gas refunds.
    //
    // BUT pad in BigInt and keep the estimate's own value types: the owner path signs
    // the v3 TX HASH, which starknet.js computes locally - encodeResourceBoundsL1 does
    // BigInt shifts directly on these fields, so hex strings crash with "Cannot mix
    // BigInt and other types". (The agent path never hits this: its session signature
    // does not cover the tx hash, so no local tx-hash computation. A dry-run estimate
    // also does not catch it - estimating does not sign.)
    const est = await account.estimateInvokeFee(snCalls, { nonce });
    const rb = est.resourceBounds;
    rb.l2_gas.max_amount = BigInt(rb.l2_gas.max_amount) * 3n;
    rb.l1_data_gas.max_amount = BigInt(rb.l1_data_gas.max_amount) * 2n;
    const resourceBounds = rb;
    console.log('padded resource bounds =', JSON.stringify(rb, (_, v) =>
      typeof v === 'bigint' ? '0x' + v.toString(16) : v));
    console.log('suggested max fee =', String(est.suggestedMaxFee ?? '(n/a)'));

    if (dryRun) {
      result({ status: 'DRY_RUN', nonce: String(nonce), calls: snCalls.length, resourceBounds });
      return;
    }

    const tx = await account.execute(snCalls, { nonce, resourceBounds });
    console.log('submitted, tx hash =', tx.transaction_hash);
    const receipt = await provider.waitForTransaction(tx.transaction_hash, { retryInterval: 5000 });
    console.log('final status =', receipt.finality_status,
      '| execution =', receipt.execution_status ?? '(n/a)');
    if (receipt.execution_status === 'REVERTED') {
      console.log('revert reason =', receipt.revert_reason);
      result({ status: 'REVERTED', tx_hash: tx.transaction_hash, revert_reason: String(receipt.revert_reason) });
      process.exit(1);
    }
    result({ status: 'SUCCEEDED', tx_hash: tx.transaction_hash, finality: receipt.finality_status });
  } catch (e) {
    console.log('ERROR:');
    console.log(String(e?.message ?? e).slice(0, 1500));
    result({ status: 'ERROR', message: String(e?.message ?? e).slice(0, 500) });
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  result({ status: 'ERROR', message: String(e?.message ?? e).slice(0, 500) });
  process.exit(1);
});
