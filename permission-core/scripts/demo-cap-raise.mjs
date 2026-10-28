// THE LIVE CAP-RAISE DEMO - Layer C's proposal flow meeting Layer E's lock on Sepolia.
//
// The story this script tells, with real transactions:
//
//   1. The agent wants to pay a listed merchant an amount ABOVE its per-call cap.
//   2. The engine (reading the LIVE mandate off the chain) says DENY - in the
//      contract's own words.
//   3. A proposal is created: who wants what, and exactly why it is blocked.
//   4. The owner (the user) signs an AMENDMENT with the owner key - and the store
//      verifies that signature against the owner public key read FROM THE CHAIN.
//      The company, the agent, and this script itself cannot forge it.
//   5. The resolved proposal is converted (pure, src/resolutions.mjs) into the exact
//      wire-level call, side effects shown, then submitted as a REAL owner
//      transaction via gate-account/tools/owner-tx.mjs.
//   6. The mandate is re-read from the chain: the cap really changed.
//      Honest note: v0.2's set_spending_policy RESTARTS the spending window -
//      spent_in_window resets to 0. The script asserts and logs this, not hides it.
//   7. The engine now says ALLOW, and the agent's retry - signed with its session
//      key - goes through ON-CHAIN. The lock obeyed the user's signed decision.
//
// Run:  cd "C:\Users\USER\demi the builder\permission-core"
//       node scripts/demo-cap-raise.mjs
//
// TESTNET KEYS ONLY (recorded in gate-account/.sepolia/state.json).
// Re-runnable: each run raises the cap by 10 and sends (old cap + 5), until the
// window cap runs out of headroom - then it says so loudly instead of faking it.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../src/engine.mjs';
import { spendingGate } from '../src/gates/spending.mjs';
import { readLiveMandate } from '../src/mandate-reader.mjs';
import { createProposalStore, signResolution, chainOwnerPublicKey } from '../src/proposals.mjs';
import { resolutionToCalls } from '../src/resolutions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const STATE_PATH = fileURLToPath(new URL('../../gate-account/.sepolia/state.json', import.meta.url));
const OWNER_TX = fileURLToPath(new URL('../../gate-account/tools/owner-tx.mjs', import.meta.url));
const AGENT_TX = fileURLToPath(new URL('../../gate-account/tools/agent-tx.mjs', import.meta.url));
const DATA_DIR = join(ROOT, '.data');

const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
const GATE = state.contracts.gate_account.address;
const SESSION_PUB = state.keys.agent_session.session_public_key;
const OWNER_PRIV = state.keys.owner.private_key; // TESTNET ONLY

let stepNo = 0;
function step(msg) {
  console.log(`\n=== STEP ${++stepNo}: ${msg}`);
}
function check(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`    ok: ${msg}`);
}
const big = (o) => JSON.parse(JSON.stringify(o, (_, v) =>
  typeof v === 'bigint' ? v.toString() : v));

// Spawn a sibling tool, tee its output, return { code, out }.
function runTool(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: dirname(script) });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

function parseOwnerResult(out) {
  const m = out.match(/^OWNER_TX_RESULT (.+)$/m);
  if (!m) throw new Error('owner-tx.mjs printed no OWNER_TX_RESULT line:\n' + out);
  return JSON.parse(m[1]);
}

async function main() {
  console.log('LIVE CAP-RAISE DEMO - proposal flow -> real owner transaction -> agent retry');
  console.log(`gate account: ${GATE} (Sepolia)`);

  // ---------------------------------------------------------------- 1. live mandate
  step('read the LIVE mandate off Sepolia');
  const before = await readLiveMandate(STATE_PATH);
  const merchant = before.allowedRecipients[0];
  check(!!merchant, 'a merchant is on the on-chain allowlist');
  console.log(`    per-call cap ${before.maxPerCall} | window cap ${before.maxPerWindow} | ` +
    `spent ${before.spentInWindow} | calls used ${before.callsUsed}/${before.maxCalls}`);

  // Derive the demo targets from the chain, not from memory.
  const amount = before.maxPerCall + 5n;                       // above the cap -> DENY
  let newCap = before.maxPerCall + 10n;                        // headroom for the amount
  if (newCap > before.maxPerWindow) newCap = before.maxPerWindow;
  if (newCap <= before.maxPerCall || amount > newCap) {
    throw new Error(`the window cap (${before.maxPerWindow}) has no headroom left above the ` +
      `per-call cap (${before.maxPerCall}) - this demo cannot raise the cap further. ` +
      'The owner would need to amend max_per_window itself (or wait for the window reset).');
  }
  check(before.callsUsed < before.maxCalls, 'the agent still has call budget left');
  console.log(`    demo targets: agent asks for ${amount} (cap is ${before.maxPerCall}); ` +
    `amendment will raise the cap to ${newCap}`);

  // ---------------------------------------------------------------- 2. engine denies
  step('the agent asks; the engine (on live data) blocks it');
  const engine = createEngine();
  engine.registerGate(spendingGate);
  const request = {
    user: 'user:demo-owner', agent: 'agent:demo',
    action: 'spend:transfer', resource: `token:${before.token}`,
    // amount is a STRING so the proposal store's JSON stays serialisable; the gate
    // and the wire converter both go through BigInt().
    context: { recipient: merchant, amount: amount.toString(), token: before.token,
      now: Math.floor(Date.now() / 1000) },
  };
  const denied = engine.decide(request, { spend: before });
  check(denied.verdict === 'DENY' && denied.code === 'over-per-call-cap',
    `engine DENIED with the contract's own words: "${denied.reason}"`);

  // ---------------------------------------------------------------- 3. proposal
  step('the block becomes a proposal (append-only file = the audit trail)');
  mkdirSync(DATA_DIR, { recursive: true });
  const store = createProposalStore({
    filePath: join(DATA_DIR, 'demo-proposals.json'),
    getOwnerPublicKey: () => chainOwnerPublicKey({ statePath: STATE_PATH }),
  });
  const proposal = store.create(request, denied,
    'live cap-raise demo: agent retry follows the on-chain amendment');
  console.log(`    proposal ${proposal.id}: ${proposal.request.action} of ${amount} ` +
    `to ${merchant.slice(0, 12)}... - PENDING`);

  // ---------------------------------------------------------------- 4. owner amends
  step('the OWNER signs the amendment - verified against the key read from the chain');
  const resolution = {
    type: 'amend',
    amendment: { kind: 'raise-per-call-cap', token: before.token, maxPerCall: newCap.toString() },
  };
  const digest = store.digestFor(proposal.id, resolution);
  console.log(`    digest the owner signs: ${digest}`);
  const sig = signResolution(digest, OWNER_PRIV);
  const resolved = await store.resolve(proposal.id, resolution, sig);
  check(resolved.status === 'AMENDED', 'proposal is AMENDED (owner signature verified against ' +
    `the on-chain key ${resolved.ownerPublicKeyAtResolution.slice(0, 14)}...)`);

  // ---------------------------------------------------------------- 5. exact calls
  step('convert the resolution to the EXACT on-chain call (pure - shown before signing in the product)');
  const { calls, sideEffects } = resolutionToCalls(resolved, {
    gateAddress: GATE, sessionPublicKey: SESSION_PUB, currentPolicy: before,
  });
  console.log(`    call: ${calls[0].to} :: ${calls[0].entrypoint}`);
  console.log(`    calldata: [${calls[0].calldata.join(', ')}]`);
  for (const s of sideEffects) console.log(`    side effect: ${s}`);

  const callsJson = JSON.stringify(calls);
  step('dry-run the owner transaction (estimate only, nothing submitted)');
  const dry = await runTool(OWNER_TX, ['--calls', callsJson, '--dry-run']);
  const dryResult = parseOwnerResult(dry.out);
  check(dry.code === 0 && dryResult.status === 'DRY_RUN', 'estimate succeeded - wiring is valid');

  step('submit the REAL owner transaction (owner key signs the tx hash)');
  const ownerRun = await runTool(OWNER_TX, ['--calls', callsJson]);
  const ownerResult = parseOwnerResult(ownerRun.out);
  check(ownerResult.status === 'SUCCEEDED',
    `amendment is ON-CHAIN: ${ownerResult.tx_hash}`);

  // ---------------------------------------------------------------- 6. chain changed
  step('re-read the mandate - did the chain actually change?');
  const mid = await readLiveMandate(STATE_PATH);
  check(mid.maxPerCall === newCap, `per-call cap is now ${mid.maxPerCall} (was ${before.maxPerCall})`);
  check(mid.spentInWindow === 0n,
    `spent_in_window reset to ${mid.spentInWindow} - HONEST NOTE: v0.2 set_spending_policy ` +
    `restarts the window (was ${before.spentInWindow}); the side-effect warning above said so`);
  check(mid.windowStart >= before.windowStart, 'window_start moved to the amendment block');
  check(mid.maxPerWindow === before.maxPerWindow && mid.windowSeconds === before.windowSeconds,
    'the fields the amendment did NOT touch are unchanged');

  // ---------------------------------------------------------------- 7. agent retries
  step('the engine (on the NEW live data) allows the same request');
  const retryRequest = { ...request,
    context: { ...request.context, now: Math.floor(Date.now() / 1000) } };
  const allowed = engine.decide(retryRequest, { spend: mid });
  check(allowed.verdict === 'ALLOW', `engine ALLOWED: ${allowed.reason}`);

  step('the agent retries for real - session-key signed transaction to Sepolia');
  const agentRun = await runTool(AGENT_TX, ['--send', merchant, amount.toString()]);
  check(/ACCEPT/.test(agentRun.out), 'the tool predicted ACCEPT from the live policy');
  const agentHash = (agentRun.out.match(/tx hash = (0x[0-9a-fA-F]+)/) ?? [])[1];
  check(!!agentHash, 'agent transaction hash captured');
  check(/execution = SUCCEEDED/.test(agentRun.out) && agentRun.code === 0,
    `agent transfer of ${amount} SUCCEEDED on-chain: ${agentHash}`);

  // ---------------------------------------------------------------- 8. final state
  step('final chain state - the counters moved exactly as expected');
  const after = await readLiveMandate(STATE_PATH);
  check(after.spentInWindow === amount, `spent_in_window is ${after.spentInWindow} (the transfer amount)`);
  check(after.callsUsed === before.callsUsed + 1,
    `call budget used ${before.callsUsed} -> ${after.callsUsed} (only successful calls count)`);
  check(after.maxPerCall === newCap, 'cap still exactly what the owner signed - nothing else moved');

  // ---------------------------------------------------------------- record
  const record = {
    date: new Date().toISOString(),
    network: 'starknet-sepolia',
    proposal_id: proposal.id,
    resolution_digest: digest,
    amendment: resolution.amendment,
    owner_tx_hash: ownerResult.tx_hash,
    agent_tx_hash: agentHash,
    amount_sent: amount.toString(),
    merchant,
    policy_before: big({ maxPerCall: before.maxPerCall, maxPerWindow: before.maxPerWindow,
      spentInWindow: before.spentInWindow, callsUsed: before.callsUsed }),
    policy_after: big({ maxPerCall: after.maxPerCall, maxPerWindow: after.maxPerWindow,
      spentInWindow: after.spentInWindow, callsUsed: after.callsUsed }),
    side_effects_logged: sideEffects,
  };
  const recordPath = join(DATA_DIR, `demo-cap-raise-${Date.now()}.json`);
  writeFileSync(recordPath, JSON.stringify(record, null, 2));

  // state.json stays the single source of truth: append this run.
  state.layer_c_demo = state.layer_c_demo ?? [];
  state.layer_c_demo.push(record);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  console.log('\n============================================================');
  console.log('DEMO COMPLETE - the loop closed on live Starknet Sepolia:');
  console.log(`  agent blocked at ${amount} (cap was ${before.maxPerCall})`);
  console.log(`  owner signed an amendment (digest ${digest.slice(0, 18)}...)`);
  console.log(`  owner tx:    ${ownerResult.tx_hash}`);
  console.log(`  chain now says cap = ${after.maxPerCall}`);
  console.log(`  agent tx:    ${agentHash}  (${amount} to merchant, SUCCEEDED)`);
  console.log(`  record:      ${recordPath}`);
  console.log('============================================================');
}

main().catch((e) => {
  console.error('\nDEMO FAILED:', e?.message ?? e);
  process.exit(1);
});
