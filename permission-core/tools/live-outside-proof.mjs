// Phase 5 LIVE PROOF: the wallet signs a SNIP-9 authorization, this server
// relays it as an EXTERNAL submitter (the gas-only deployer key), and nothing
// is recorded as done until the receipt comes back AND the chain says the
// one-shot nonce is burned.
//
// It drives the REAL console server (createConsoleServer with its DEFAULT
// injectables - so every chain read, the relayer and the receipt reader hit
// live Sepolia) on an ephemeral port with a throwaway proposal store, so it
// never touches the demo store. The "wallet" is the phase-5 mock controller
// account (mandate.mock_wallet): a standard OZ account holding the owner key,
// exactly the shape a real Argent X presents. Signing with the owner key bound
// to the controller's address is what a real wallet does with its own key.
//
// Flow (each hop verified against the chain, never trusted from memory):
//   over-cap ask  -> PENDING proposal
//   owner signs execute-once -> APPROVED_ONCE
//   /api/outside/plan -> controller + fresh unused nonce read from chain
//   mock wallet signs the SNIP-9 typed data (wallet-snip12-src9)
//   /api/outside/submit -> server re-verifies, packs the wire FLAT, relays via
//                          the deployer key, records BROADCAST only
//   /api/tx/receipt -> final status + nonce-consumed, read back from chain
//   merchant balance delta == the approved amount
//
// TESTNET KEYS ONLY - everything comes from ../../gate-account/.sepolia/state.json.
// OBS-19: judge this run by the PROOF_RESULT line and the receipt file, not the
// exit code (starknet.js WARN tip lines on stderr can fake a nonzero exit).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sn from 'starknet';

import { createConsoleServer } from '../web/server.mjs';
import { resolutionDigest, signResolution } from '../src/proposals.mjs';
import { outsideExecutionTypedData, signTypedData } from '../web/typed-data.js';

const STATE_PATH = new URL('../../gate-account/.sepolia/state.json', import.meta.url);
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
const REC_PATH = new URL('../.data/phase5-outside-proof.json', import.meta.url);

const RPC = state.rpc_endpoints_verified.cartridge.url;
const OWNER_PRIV = state.keys.owner.private_key;
const MERCHANT = state.keys.merchant.address;
const TOKEN = state.contracts.token.address;
const CONTROLLER = state.mandate.mock_wallet.address; // the mock wallet account
const GATE = state.contracts.gate_account.address;
const OVER_CAP_AMOUNT = '50'; // > live per-call cap 30 -> the engine asks the owner

const hex = (v) => '0x' + BigInt(v).toString(16);
function result(obj) {
  console.log('PROOF_RESULT ' + JSON.stringify(obj, (_, v) =>
    typeof v === 'bigint' ? hex(v) : v));
}

const provider = new sn.RpcProvider({ nodeUrl: RPC });
const balanceOf = async (who) => {
  const r = await provider.callContract({
    contractAddress: TOKEN, entrypoint: 'balance_of', calldata: [who],
  });
  return BigInt(r[0]) + (BigInt(r[1] ?? 0) << 128n);
};
const controllerOnChain = async () => {
  const r = await provider.callContract({
    contractAddress: GATE, entrypoint: 'get_wallet_controller', calldata: [],
  });
  return r[0];
};

async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

async function main() {
  // ---- preflight: the chain must already name the mock wallet as controller
  const chainController = await controllerOnChain();
  if (BigInt(chainController) !== BigInt(CONTROLLER)) {
    throw new Error(`chain controller ${chainController} != recorded mock wallet ` +
      `${CONTROLLER} - run wallet-controller.mjs --register first`);
  }
  const merchantBefore = await balanceOf(MERCHANT);
  console.log(`preflight: controller=${chainController} merchantBefore=${merchantBefore}`);

  // ---- start the REAL server with default (live-network) injectables
  const dir = mkdtempSync(join(tmpdir(), 'phase5-proof-'));
  const server = createConsoleServer({
    storePath: join(dir, 'proposals.json'),
    submissionsPath: join(dir, 'submissions.json'),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  console.log(`proof server on 127.0.0.1:${port} (ephemeral store ${dir})`);

  try {
    // 1. an over-cap ask becomes a PENDING proposal
    const ask = await api(port, 'POST', '/api/requests',
      { recipient: MERCHANT, amount: OVER_CAP_AMOUNT });
    if (ask.status !== 200) throw new Error(`ask failed ${ask.status}: ${ask.text}`);
    const proposal0 = ask.json.proposal;
    if (!proposal0) {
      throw new Error(`amount ${OVER_CAP_AMOUNT} did not create a proposal ` +
        `(verdict ${ask.json.decision?.verdict}) - is the live cap still below it?`);
    }
    console.log(`proposal ${proposal0.id} created (verdict ${ask.json.decision.verdict})`);

    // 2. the owner signs execute-once -> APPROVED_ONCE
    const resolution = { type: 'execute-once' };
    const digest = resolutionDigest(proposal0, resolution);
    const resolved = await api(port, 'POST', '/api/resolve', {
      proposalId: proposal0.id, resolution, signature: signResolution(digest, OWNER_PRIV),
    });
    if (resolved.status !== 200) throw new Error(`resolve failed ${resolved.status}: ${resolved.text}`);
    const proposal = resolved.json.proposal;
    console.log(`proposal resolved -> ${proposal.status}`);

    // 3. plan the outside execution (controller + fresh nonce read from chain)
    const planRes = await api(port, 'POST', '/api/outside/plan', { proposalId: proposal.id });
    if (planRes.status !== 200) throw new Error(`plan failed ${planRes.status}: ${planRes.text}`);
    const plan = planRes.json;
    console.log(`plan: controller=${plan.controller} nonce=${plan.nonce} ` +
      `relayer=${plan.relayer} calls=${plan.calls.length}`);
    if (BigInt(plan.controller) !== BigInt(CONTROLLER)) {
      throw new Error(`plan controller ${plan.controller} != mock wallet ${CONTROLLER}`);
    }

    // 4. the mock wallet signs the SNIP-9 typed data (owner key, bound to the
    //    controller address - exactly what a native wallet does with its own key)
    const typedData = outsideExecutionTypedData({
      chainId: plan.chainId,
      caller: plan.caller,
      nonce: plan.nonce,
      executeAfter: plan.executeAfter,
      executeBefore: plan.executeBefore,
      calls: plan.calls,
    });
    const { r, s } = signTypedData(typedData, CONTROLLER, OWNER_PRIV);
    const authorization = {
      scheme: 'wallet-snip12-src9', r, s, typedData, signerAddress: CONTROLLER,
    };

    // 5. submit: the server re-verifies, packs flat, relays via the deployer key
    const sub = await api(port, 'POST', '/api/outside/submit',
      { proposalId: proposal.id, authorization });
    if (sub.status !== 200) throw new Error(`submit failed ${sub.status}: ${sub.text}`);
    if (!sub.json.relayed) throw new Error(`submit not relayed: ${sub.text}`);
    const txHash = sub.json.txHash;
    console.log(`relayed execute_from_outside_v2: tx=${txHash} ` +
      `(relayer ${sub.json.submission.relayer}, status ${sub.json.submission.status})`);

    // 6. poll the receipt until final; the server reads back the nonce burn
    let receipt = null;
    let submission = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const rec = await api(port, 'GET', `/api/tx/receipt?hash=${encodeURIComponent(txHash)}`);
      if (rec.status === 200 && rec.json.final) {
        receipt = rec.json.receipt;
        submission = rec.json.submission;
        break;
      }
      await new Promise((r2) => setTimeout(r2, 5000));
    }
    if (!receipt) throw new Error('receipt never became final within 120s');
    console.log(`receipt: ${receipt.finality_status} / ${receipt.execution_status}` +
      `${receipt.revert_reason ? ` revert=${receipt.revert_reason}` : ''}`);
    if (receipt.execution_status !== 'SUCCEEDED') {
      throw new Error(`outside execution ${receipt.execution_status}: ` +
        `${receipt.revert_reason ?? 'no reason given'}`);
    }

    // 7. read the consequences back from the chain
    const merchantAfter = await balanceOf(MERCHANT);
    const nonceState = await provider.callContract({
      contractAddress: GATE, entrypoint: 'is_valid_outside_execution_nonce',
      calldata: [plan.nonce],
    });
    const nonceConsumed = BigInt(nonceState[0]) === 0n;
    const delta = merchantAfter - merchantBefore;

    const ok = delta === BigInt(OVER_CAP_AMOUNT)
      && nonceConsumed
      && submission?.status === 'SUCCEEDED'
      && submission?.nonce_consumed === true;

    const record = {
      when: new Date().toISOString(),
      thesis: 'Phase 5: the wallet signs a SNIP-9 authorization; the server ' +
        'relays it as an external submitter (gas-only deployer key); the record ' +
        'is written only after the receipt is final AND the chain says the nonce ' +
        'is burned. Controller is a separate account (the mock wallet), not the ' +
        'gate itself - the phase-6 shape with a real Argent X.',
      controller: plan.controller,
      controller_is_mock_wallet: BigInt(plan.controller) === BigInt(CONTROLLER),
      relayer: submission?.relayer ?? null,
      relayer_is_deployer: (submission?.relayer ?? '') === state.keys.deployer.address,
      proposal_id: proposal.id,
      resolution: 'execute-once',
      amount: OVER_CAP_AMOUNT,
      scheme: 'wallet-snip12-src9',
      tx: txHash,
      receipt_status: receipt.execution_status,
      receipt_finality: receipt.finality_status,
      merchant_before: hex(merchantBefore),
      merchant_after: hex(merchantAfter),
      merchant_delta: hex(delta),
      nonce: plan.nonce,
      nonce_consumed_on_chain: nonceConsumed,
      submission_status: submission?.status ?? null,
      submission_nonce_consumed: submission?.nonce_consumed ?? null,
      digest: submission?.digest ?? null,
      all_checks_passed: ok,
    };
    writeFileSync(REC_PATH, JSON.stringify(record, null, 2) + '\n');
    result(record);
    if (!ok) {
      console.error('PROOF INCOMPLETE: a read-back did not match - see PROOF_RESULT');
      process.exitCode = 1;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e).slice(0, 2000));
  result({ status: 'ERROR', message: String(e?.message ?? e).slice(0, 500) });
  process.exit(1);
});
