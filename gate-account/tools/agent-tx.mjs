// Stage 2: submit an agent transaction signed with the GateAccount 4-element session
// signature [session_pubkey, r, s, valid_until] to Starknet Sepolia.
//
// No wallet produces this signature, so we implement a custom SignerInterface: instead of
// signing the transaction hash, it signs OUR session hash, exactly mirroring
// compute_session_hash in src/lib.cairo:
//
//   poseidon_hash_span([
//     'GateAccount session v1', account, chain_id, nonce, valid_until,
//     (to, selector, poseidon_hash_span(calldata))...   // per call
//   ])
//
// The session path never looks at the tx hash, so the standard starknet.js Account can
// build/estimate/broadcast the v3 invoke while our signer supplies the session signature.
//
// Modes:
//   node agent-tx.mjs --hash-only   print the session hash for the canonical vector
//                                   (cross-checked against Cairo in snforge, test t17)
//   node agent-tx.mjs --predict <address> <amount>
//                                   print what the chain WOULD do (live policy read,
//                                   nothing submitted)
//   node agent-tx.mjs --in-policy   transfer 5 tokens to the listed merchant (must pass)
//   node agent-tx.mjs --over-cap    transfer 50 (above the per-call cap; must be rejected)
//   node agent-tx.mjs --stranger    transfer 5 to an UNLISTED recipient (must be rejected)
//   node agent-tx.mjs --send <address> <amount>
//                                   try ANY transfer yourself. The script predicts the
//                                   outcome from the on-chain policy first, then submits
//                                   and shows what the network actually did.
// All predictions are read LIVE from the chain (get_spending_policy /
// is_recipient_allowed) - the owner can amend the mandate between runs.
//
// TESTNET KEYS ONLY - everything live is read from ../.sepolia/state.json
// (the owner-tx.mjs pattern), so repointing the console/tools after a migration
// is a ONE-FILE change. The ONLY hardcoded addresses left are the frozen t17
// vector fixtures below.
import { readFileSync } from 'node:fs';
import * as sn from 'starknet';

const state = JSON.parse(
  readFileSync(new URL('../.sepolia/state.json', import.meta.url), 'utf8'));

const RPC = state.rpc_endpoints_verified.cartridge.url;

// LIVE targets - since the v0.3 migration these are the NEW gate/token.
const GATE = state.contracts.gate_account.address;
const TOKEN = state.contracts.token.address;
const MERCHANT = state.keys.merchant.address;
const STRANGER = state.keys.stranger.address;

const SESSION_PRIV = state.keys.agent_session.session_private_key;
const SESSION_PUB = state.keys.agent_session.session_public_key;
const SESSION_VALID_UNTIL = BigInt(state.mandate.session.valid_until); // registered on-chain

// --- frozen t17 vector fixtures (NEVER repoint these) ---------------------------
// The canonical session-hash vector is a HASH-MATHS pin shared with snforge t17
// (gate-account/tests/lib.cairo): Cairo asserts poseidon_hash_span produces the
// identical felt 0x75179a2c...be9d9 for exactly these values. Like the SNIP-9
// vector (tools/snip9-vector.mjs / t35), it deliberately uses the SEPOLIA v0.2
// FIXTURE addresses - a vector must never change when the gate is redeployed,
// or the cross-language pin silently re-baselines.
const VECTOR_GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const VECTOR_TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const VECTOR_MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';

// --- session hash: mirror of compute_session_hash (src/lib.cairo) --------------
// Cairo poseidon_hash_span == starknet.js computePoseidonHashOnElements (verified
// against snforge test t17 on a fixed vector before any live submission).
function sessionHash({ account, chainId, nonce, validUntil, calls }) {
  const fields = [
    BigInt(sn.shortString.encodeShortString('GateAccount session v1')),
    BigInt(account),
    BigInt(chainId),
    BigInt(nonce),
    BigInt(validUntil),
  ];
  for (const c of calls) {
    const wire = sn.CallData.compile(c.calldata).map((x) => BigInt(x));
    fields.push(
      BigInt(c.contractAddress),
      BigInt(sn.hash.getSelector(c.entrypoint)),
      BigInt(sn.hash.computePoseidonHashOnElements(wire)),
    );
  }
  return sn.hash.computePoseidonHashOnElements(fields);
}

// --- custom signer: signs the session hash, not the tx hash --------------------
class SessionSigner extends sn.Signer {
  constructor(pk, sessionParams) {
    super(pk);
    this.sessionParams = sessionParams; // { validUntil }
  }

  async getPubKey() {
    return SESSION_PUB;
  }

  async signTransaction(transactions, details) {
    const msgHash = sessionHash({
      account: details.walletAddress,
      chainId: details.chainId,
      nonce: details.nonce,
      validUntil: this.sessionParams.validUntil,
      calls: transactions,
    });
    // computePoseidonHashOnElements already returns a 0x-prefixed hex string.
    const raw = await this.signRaw(msgHash);
    // v7 signRaw may return {r,s} (bigint) or a flat array - normalise.
    const r = typeof raw === 'object' && !Array.isArray(raw) ? raw.r : raw[0];
    const s = typeof raw === 'object' && !Array.isArray(raw) ? raw.s : raw[1];
    // The 4-element signature GateAccount's __validate__ expects.
    return [SESSION_PUB, '0x' + BigInt(r).toString(16), '0x' + BigInt(s).toString(16),
      '0x' + this.sessionParams.validUntil.toString(16)];
  }
}

// --- canonical transfer call (ERC-20 wire layout: [recipient, amount_low, amount_high])
function transferCall(recipient, amount) {
  return {
    contractAddress: TOKEN,
    entrypoint: 'transfer',
    calldata: [recipient, BigInt(amount).toString(), '0'],
  };
}

// --- live prediction: read the policy FROM THE CHAIN, never from memory -----------
// The mandate can change (the Layer C demo raises the per-call cap via an owner
// amendment), so a hardcoded "cap is 10" prediction would become a lie. This mirrors
// the contract's check order: recipient allowlist -> per-call cap -> window cap.
async function predictOutcome(provider, to, amount) {
  const u256 = (low, high) => BigInt(low) + (BigInt(high) << 128n);
  const policy = await provider.callContract({
    contractAddress: GATE, entrypoint: 'get_spending_policy', calldata: [SESSION_PUB, TOKEN],
  });
  const flag = await provider.callContract({
    contractAddress: GATE, entrypoint: 'is_recipient_allowed', calldata: [SESSION_PUB, TOKEN, to],
  });
  const amt = BigInt(amount);
  const maxPerCall = u256(policy[0], policy[1]);
  const maxPerWindow = u256(policy[2], policy[3]);
  const windowSeconds = BigInt(policy[4]);
  const spentRaw = u256(policy[5], policy[6]);
  const windowStart = BigInt(policy[7]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const spent = now >= windowStart + windowSeconds ? 0n : spentRaw; // rollover, like the chain
  const allowed = BigInt(flag[0]) === 1n;

  if (!allowed) return `REJECT (recipient not on the on-chain allowlist)`;
  if (amt > maxPerCall) return `REJECT (per-call cap on-chain is ${maxPerCall})`;
  if (spent + amt > maxPerWindow) {
    return `REJECT (window cap ${maxPerWindow}, spent this window ${spent})`;
  }
  return `ACCEPT (inside policy: per-call cap ${maxPerCall}, window cap ${maxPerWindow}, spent ${spent})`;
}

const CANONICAL_VECTOR = {
  account: VECTOR_GATE,
  chainId: '0x534e5f5345504f4c4941',
  nonce: 4,
  validUntil: SESSION_VALID_UNTIL,
  // Built on the frozen fixtures, NOT the live transferCall helper: the vector
  // pins hash maths against snforge t17 and must survive gate/token redeployments.
  calls: [{
    contractAddress: VECTOR_TOKEN,
    entrypoint: 'transfer',
    calldata: [VECTOR_MERCHANT, '5', '0'],
  }],
};

// Shared <address> <amount> validation for --send / --predict.
function parseSendArgs(argv) {
  const to = argv[3];
  const amount = argv[4];
  if (!to || !/^0x[0-9a-fA-F]{40,64}$/.test(to) || amount === undefined || !/^\d+$/.test(amount)) {
    return null;
  }
  return { to, amount };
}

async function main() {
  const mode = process.argv[2];

  if (mode === '--hash-only') {
    const h = sessionHash(CANONICAL_VECTOR);
    console.log('session hash (canonical vector) =', h);
    console.log('poseidon_hash_span([1,2]) sanity =',
      sn.hash.computePoseidonHashOnElements([1n, 2n]));
    return;
  }

  if (mode === '--predict') {
    // What WOULD the chain do? Reads the live policy, submits nothing.
    const parsed = parseSendArgs(process.argv);
    if (!parsed) {
      console.error('usage: node agent-tx.mjs --predict <0x-recipient-address> <whole-number-amount>');
      process.exit(2);
    }
    const provider = new sn.RpcProvider({ nodeUrl: RPC });
    console.log('predicted outcome (read live from the chain):',
      await predictOutcome(provider, parsed.to, parsed.amount));
    return;
  }

  // Scenario calls are fixed targets/amounts; the EXPECTED outcome for each is read
  // live from the chain below (the policy can be amended between runs - the Layer C
  // demo does exactly that).
  const scenarios = {
    '--in-policy': { call: transferCall(MERCHANT, 5) },
    '--over-cap': { call: transferCall(MERCHANT, 50) },
    '--stranger': { call: transferCall(STRANGER, 5) },
  };

  let sc = scenarios[mode];
  if (mode === '--send') {
    // Free-form mode: pick any recipient and amount. Prediction comes from the
    // mandate as it lives on-chain RIGHT NOW (predictOutcome), never from memory.
    const parsed = parseSendArgs(process.argv);
    if (!parsed) {
      console.error('usage: node agent-tx.mjs --send <0x-recipient-address> <whole-number-amount>');
      console.error(`  the only allowlisted merchant is ${MERCHANT}`);
      process.exit(2);
    }
    sc = { call: transferCall(parsed.to, parsed.amount) };
  }
  if (!sc) {
    console.error('usage: node agent-tx.mjs [--hash-only|--predict <to> <amount>|--in-policy|--over-cap|--stranger|--send <to> <amount>]');
    process.exit(2);
  }

  const provider = new sn.RpcProvider({ nodeUrl: RPC });
  sc.expect = await predictOutcome(provider, sc.call.calldata[0], sc.call.calldata[1]);
  const signer = new SessionSigner(SESSION_PRIV, { validUntil: SESSION_VALID_UNTIL });
  // starknet.js v10: Account takes a single options object.
  const account = new sn.Account({
    provider,
    address: GATE,
    signer,
    cairoVersion: '1',
  });

  const nonce = await provider.getNonceForAddress(GATE);
  console.log(`nonce = ${nonce}, expected outcome: ${sc.expect}`);

  // Show the exact hash we are signing, so the log is self-contained evidence.
  const h = sessionHash({
    account: GATE, chainId: await provider.getChainId(), nonce: BigInt(nonce),
    validUntil: SESSION_VALID_UNTIL, calls: [sc.call],
  });
  console.log('signing session hash =', h);

  try {
    // starknet.js estimates with SKIP_VALIDATE, so the estimate never prices in our
    // __validate__ (poseidon hash + ECDSA over the session hash ~= 1.5M L2 gas). The first
    // live attempt proved this: ACCEPTED_ON_L2 / REVERTED with "Insufficient max L2Gas"
    // (bound 2,440,828 vs actual 3,929,102). Pad the bounds generously; unused gas is
    // refunded, the bound is only a maximum.
    const est = await account.estimateInvokeFee([sc.call], { nonce });
    // The estimate response may contain BigInts (v10) - stringify everything before
    // feeding it back, or the RPC JSON serializer throws.
    const pad = (v, mult) =>
      '0x' + Math.ceil(Number(v) * mult).toString(16);
    const hex = (v) => '0x' + BigInt(v).toString(16);
    const rb = est.resourceBounds;
    const resourceBounds = {
      l2_gas: {
        max_amount: pad(rb.l2_gas.max_amount, 3),
        max_price_per_unit: hex(rb.l2_gas.max_price_per_unit),
      },
      l1_gas: {
        max_amount: hex(rb.l1_gas.max_amount),
        max_price_per_unit: hex(rb.l1_gas.max_price_per_unit),
      },
      l1_data_gas: {
        max_amount: pad(rb.l1_data_gas.max_amount, 2),
        max_price_per_unit: hex(rb.l1_data_gas.max_price_per_unit),
      },
    };
    console.log('padded resource bounds =', JSON.stringify(resourceBounds));

    const tx = await account.execute([sc.call], { nonce, resourceBounds });
    console.log('submitted, tx hash =', tx.transaction_hash);
    const receipt = await provider.waitForTransaction(tx.transaction_hash, {
      retryInterval: 5000,
    });
    console.log('final status =', receipt.finality_status,
      '| execution =', receipt.execution_status ?? '(n/a)');
    if (receipt.execution_status === 'REVERTED') {
      console.log('revert reason =', receipt.revert_reason);
    }
  } catch (e) {
    console.log('ERROR (expected for the reject scenarios):');
    console.log(String(e?.message ?? e).slice(0, 1200));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
