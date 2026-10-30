// Live-alignment test: the engine must predict the CHAIN, not just agree with itself.
//
// Reads the user's real mandate off Starknet Sepolia (mandate-reader), then replays
// the exact three agent requests from Stage 2 (STAGE2-agent-tx.md) and asserts the
// engine's verdicts match what the network actually did on 2026-10-24:
//
//   transfer 5  -> merchant  : chain SUCCEEDED (2026-10-24)  -> engine must ALLOW
//   transfer cap+1 -> merchant : the gate's over-cap rule AT THE LIVE CAP. The
//     2026-10-24 revert of 50 units (tx 0x58b47001...) happened under cap 25;
//     the owner amendment of 2026-10-27 (tx 0x62c0bd18..., step 10, OBS-33)
//     raised the cap to 100 - so 50 units is ALLOWED on today's chain and the
//     pin follows the chain as it is, not as it was (asserted both ways below)
//   transfer 5  -> stranger  : chain REVERTED "recipient not allowed" on
//     2026-10-24 - until the owner amended the mandate FROM THE WALLET on
//     2026-10-28 (tx 0x419f306a..., allow_recipient, OBS-35). The pin follows
//     the chain as it is, checked directly against is_recipient_allowed, so a
//     drifted RECORD can never masquerade as a chain change.
//
// Also asserts the live counters are coherent (callsUsed <= maxCalls,
// spentInWindow <= maxPerWindow). It deliberately does NOT pin exact counter
// values: an owner amendment RESTARTS the spending window (v0.2 contract, the
// side effect the console warns about), so spent_in_window legitimately returns
// to 0 after any set_spending_policy - the 2026-10-24 console amendment did
// exactly that (tx 0x1492ec9c...).
//
// If the network is unreachable the test SKIPS loudly (never a silent pass, OBS-08).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine } from '../src/engine.mjs';
import { spendingGate } from '../src/gates/spending.mjs';
import { readLiveMandate, call } from '../src/mandate-reader.mjs';

const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const STRANGER = '0x16cb41ec11efcc9129d858ae07449f4f1a31d7d292269a5e7c40cd4d33db371';

test('live: engine verdicts match the three real Sepolia outcomes', async (t) => {
  let policy;
  try {
    policy = await readLiveMandate();
  } catch (e) {
    t.skip(`could not reach Sepolia or read the mandate: ${e.message}`);
    return;
  }

  const engine = createEngine();
  engine.registerGate(spendingGate);
  const req = (recipient, amount) => ({
    user: 'user:sepolia:gate_owner',
    agent: `agent:session:${policy.sessionPublicKey}`,
    action: 'spend:transfer',
    resource: `token:${policy.token}`,
    context: { recipient, amount, token: policy.token },
  });
  const decide = (recipient, amount) =>
    engine.decide(req(recipient, amount), { spend: policy });

  // 1. The transfer that SUCCEEDED on-chain (tx 0x59e507bb...).
  const ok = decide(MERCHANT, 5);
  assert.equal(ok.verdict, 'ALLOW',
    `chain allowed transfer(merchant,5) but engine said ${ok.verdict}: ${ok.reason}`);

  // 2. The over-cap rule, at the LIVE cap: the owner amended it on chain on
  //    2026-10-27 (tx 0x62c0bd18..., cap 30 -> 100), so "over cap" is not a
  //    fixed amount any more - it is whatever the chain says right now, plus
  //    one. The gate's panic string is pinned by the snforge suite; the engine
  //    must reproduce it for the live cap exactly as the chain would.
  const overCap = decide(MERCHANT, policy.maxPerCall + 1n);
  assert.equal(overCap.verdict, 'DENY');
  assert.equal(overCap.reason, 'GateAccount: amount over per-call cap');

  // 2b. The historical revert itself, re-decided against TODAY's chain: 50
  //    units reverted on 2026-10-24 because the cap then was below 50. The
  //    same request now must verdict the way the chain would verdict it now -
  //    allowed iff the live cap covers it. The engine predicts the chain as it
  //    is, never as it was; an amendment flipping a verdict is the mandate
  //    working, not drift.
  const fifty = decide(MERCHANT, 50);
  assert.equal(fifty.verdict, policy.maxPerCall >= 50n ? 'ALLOW' : 'DENY',
    `transfer(merchant,50) must follow the LIVE cap (${policy.maxPerCall}), ` +
    `engine said ${fifty.verdict}: ${fifty.reason}`);

  // 3. The transfer the chain REVERTED with "recipient not allowed" on
  //    2026-10-24 (tx 0x566f35c9...) - until the owner's wallet amendment of
  //    2026-10-28 (tx 0x419f306a..., allow_recipient, OBS-35) added the
  //    stranger to the on-chain allowlist. Read the chain DIRECTLY (not through
  //    the record's candidate list) and pin the engine to what the chain says
  //    right now: an amendment flipping a verdict is the mandate working, not
  //    drift - the same doctrine as 2b's cap pin.
  const state = JSON.parse(readFileSync(
    new URL('../../gate-account/.sepolia/state.json', import.meta.url), 'utf8'));
  // The direct chain read follows the state file's verified endpoint, exactly
  // like readLiveMandate does (2026-10-30: the module default is Cartridge,
  // which is discontinued - HTTP 410; the record is the source of truth).
  const [strangerFlag] = await call(
    state.contracts.gate_account.address,
    state.selectors.is_recipient_allowed,
    [policy.sessionPublicKey, policy.token, STRANGER],
    { rpcUrl: state.rpc_endpoints_verified.cartridge.url },
  );
  const strangerAllowed = BigInt(strangerFlag) === 1n;
  const stranger = decide(STRANGER, 5);
  if (strangerAllowed) {
    assert.equal(stranger.verdict, policy.maxPerCall >= 5n ? 'ALLOW' : 'DENY',
      `the chain allows the stranger now, so the engine must follow the live cap ` +
      `(${policy.maxPerCall}); engine said ${stranger.verdict}: ${stranger.reason}`);
  } else {
    assert.equal(stranger.verdict, 'DENY');
    assert.equal(stranger.reason, 'GateAccount: recipient not allowed');
  }

  // The live counters must be internally coherent. Exact values are NOT pinned:
  // amendments restart the spending window (see header), and since the v0.3
  // migration (2026-10-25) the gate is a FRESH deploy - calls_used legitimately
  // reads 0 until the first session call lands on the new gate (the phase-4
  // outside-execution proof was owner-level and deliberately does not touch the
  // session counters). The old "callsUsed >= 1" floor encoded the OLD gate's
  // stage-2 history and was removed when state.json was repointed to v0.3.
  assert.ok(policy.callsUsed <= policy.maxCalls, 'callsUsed exceeds maxCalls on-chain?');
  assert.ok(policy.spentInWindow <= policy.maxPerWindow, 'spentInWindow exceeds the window cap on-chain?');
  assert.ok(policy.allowedRecipients.includes(MERCHANT),
    'the on-chain allowlist must still contain the registered merchant');
  // Drift alarm for the RECORD's candidate list (the reader can only check
  // candidates the record names - the chain has no enumeration view): the
  // stranger's membership in the reader's answer must equal the chain's own
  // is_recipient_allowed read above. If this fails after an owner amendment,
  // update state.json's merchant_allowlist.allowed - the amendment tx is the
  // evidence, and the record must follow the chain (OBS-33's lesson, again).
  assert.equal(
    policy.allowedRecipients.some((r) => BigInt(r) === BigInt(STRANGER)),
    strangerAllowed,
    'the record\'s allowlist candidates drifted from the chain - update ' +
    'state.json merchant_allowlist.allowed to match the owner\'s amendment');

  console.log('    live mandate:', JSON.stringify({
    callsUsed: policy.callsUsed, maxCalls: policy.maxCalls,
    spent: policy.spentInWindow.toString(), perCall: policy.maxPerCall.toString(),
    perWindow: policy.maxPerWindow.toString(),
    allowedRecipients: policy.allowedRecipients.length,
  }));
});
