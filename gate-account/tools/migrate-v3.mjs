// GateAccount v0.3 migration — the live Sepolia redeploy.
//
// WHY A REDEPLOY (recorded plan correction): the v0.2 class has NO upgrade entry
// point, so "upgrade in place" was impossible. v0.3 is deployed fresh with the
// SAME owner key, then the mandate is re-registered on it. v0.3 adds owner-gated
// `upgrade` (UpgradeableComponent), so this is the LAST redeploy — from here on,
// upgrades are ordinary owner-signed actions (proven by snforge t34).
//
// Steps (each is a separate run, each verifies its own result on-chain before
// recording it; nothing is trusted from memory):
//
//   node migrate-v3.mjs --class-hash 0x.. --predict
//       Compute the deploy_account address (salt 'GATE_V3', calldata [owner_pub],
//       deployer 0) and record it. Idempotent.
//   --fund            deployer sends 2 STRK to the predicted address
//   --deploy-account  deploy_account signed by the OWNER key (exercises
//                     __validate_deploy__ on the live network), then reads back
//                     class hash + owner key
//   --deploy-token    fresh ERC20Mock instance (already-declared class reused),
//                     holder = new gate, supply 1_000_000, balance read back
//   --mandate         ONE owner tx on the new gate re-registering the mandate with
//                     the values read LIVE from the old gate (session, policy caps,
//                     merchant allowlist) plus set_wallet_controller(self) — the
//                     pasted-key SNIP-9 shape. All four read back.
//   --anchor          owner tx re-anchoring the Layer D evidence root under the new
//                     anchorer slot, read back
//   --outside         the proof: owner key signs a SNIP-9 OutsideExecution typed
//                     data (hash bound to the NEW GATE address = registered
//                     controller) and the DEPLOYER account — a third party with a
//                     different key — submits execute_from_outside_v2. Balances,
//                     nonce consumption read back.
//   --verify          full read-back of the new gate's live state, PASS/FAIL lines
//
// TESTNET KEYS ONLY — everything comes from ../.sepolia/state.json.
import { readFileSync, writeFileSync } from 'node:fs';
import * as sn from 'starknet';
import {
  getMessageHash, outsideExecutionTypedData, signTypedData,
} from '../../permission-core/web/typed-data.js';

const state = JSON.parse(
  readFileSync(new URL('../.sepolia/state.json', import.meta.url), 'utf8'));
const MIG_PATH = new URL('../.sepolia/migration-v3.json', import.meta.url);

const RPC = state.rpc_endpoints_verified.cartridge.url;
const STRK = state.strk_token_sepolia.address;
// state.json now points contracts.* at the v0.3 gate; the migration source is
// pinned to the v0.2 history block so re-runs (esp. --verify's old-vs-new
// policy comparison) still read the ORIGINAL gate. Fallback keeps this file
// runnable against a pre-migration state.json.
const OLD_GATE = state.contracts.gate_account.previous_v02?.address
  ?? state.contracts.gate_account.address;
const OLD_TOKEN = state.contracts.token.previous_v02?.address
  ?? state.contracts.token.address;
const ERC20_CLASS = state.classes.ERC20Mock.class_hash;
const EVIDENCE = state.contracts.evidence_registry.address;
const OWNER_PRIV = state.keys.owner.private_key;
const OWNER_PUB = state.keys.owner.public_key;
const SESSION_PUB = state.keys.agent_session.session_public_key;
const MERCHANT = state.keys.merchant.address;
const STRANGER = state.keys.stranger.address;
const DEPLOYER_ADDR = state.keys.deployer.address;
const DEPLOYER_PRIV = state.keys.deployer.private_key;

const GATE_SALT = sn.shortString.encodeShortString('GATE_V3');
const TOKEN_SALT = sn.shortString.encodeShortString('MOCK_V3');
const FUND_AMOUNT = 2n * 10n ** 18n; // 2 STRK
const TOKEN_SUPPLY_LOW = '1000000';
const SEL_TRANSFER = sn.hash.getSelector('transfer');

// SNIP-9 v2 detection is library-native, never hand-derived. The interface ID
// 0x1d1144bb...89872 is a SPEC CONSTANT (SNIP-9 spec NOTE: computed with the
// Cairo v2.5.0-era Call struct) — it is NOT the XOR of the two current selectors
// (that derivation was wrong and failed the first verify run). starknet.js
// hardcodes the same constant internally; the supported way to ask is
// Account.getSnip9Version() -> sn.OutsideExecutionVersion ('2' means V2).
// The contract side registers the OZ-imported ISRC9_V2_ID (snforge t18 pins it).

const hex = (v) => '0x' + BigInt(v).toString(16);

function loadMig() {
  try {
    return JSON.parse(readFileSync(MIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveMig(mig) {
  writeFileSync(MIG_PATH, JSON.stringify(mig, null, 2) + '\n');
}

function result(obj) {
  console.log('MIGRATE_RESULT ' + JSON.stringify(obj, (_, v) =>
    typeof v === 'bigint' ? hex(v) : v));
}

// OBS-10 lesson: any account that signs its own tx hash (owner gate, deployer)
// needs the estimate's NATIVE BigInt bounds — hex strings crash the local
// v3-hash computation. Pad l2 x3, l1_data x2; unused gas refunds.
function padBounds(est) {
  const rb = est.resourceBounds;
  rb.l2_gas.max_amount = BigInt(rb.l2_gas.max_amount) * 3n;
  rb.l1_data_gas.max_amount = BigInt(rb.l1_data_gas.max_amount) * 2n;
  return rb;
}

function makeAccount(provider, address, privateKey) {
  return new sn.Account({
    provider, address, signer: new sn.Signer(privateKey), cairoVersion: '1',
  });
}

async function waitOk(provider, txHash, label) {
  const receipt = await provider.waitForTransaction(txHash, { retryInterval: 5000 });
  if (receipt.execution_status === 'REVERTED') {
    throw new Error(`${label} REVERTED: ${receipt.revert_reason}`);
  }
  console.log(`${label}: ${receipt.finality_status} / ${receipt.execution_status} tx=${txHash}`);
  return receipt;
}

async function ownerExecute(provider, gateAddress, calls, label) {
  // The owner path of GateAccount: 2-felt ECDSA signature over the v3 tx hash,
  // exactly what owner-tx.mjs does — same padding, same checks.
  const account = makeAccount(provider, gateAddress, OWNER_PRIV);
  const derived = (await new sn.Signer(OWNER_PRIV).getPubKey()).toLowerCase();
  if (derived !== OWNER_PUB.toLowerCase()) {
    throw new Error(`owner key mismatch: derived ${derived} vs ${OWNER_PUB}`);
  }
  const nonce = await provider.getNonceForAddress(gateAddress);
  const est = await account.estimateInvokeFee(calls, { nonce });
  const resourceBounds = padBounds(est);
  const tx = await account.execute(calls, { nonce, resourceBounds });
  await waitOk(provider, tx.transaction_hash, label);
  return tx.transaction_hash;
}

async function call(provider, contractAddress, entrypoint, calldata) {
  return provider.callContract({ contractAddress, entrypoint, calldata });
}

// ---------------------------------------------------------------- steps

function predict(mig, classHash) {
  if (!classHash) throw new Error('--predict needs --class-hash 0x..');
  const address = sn.hash.calculateContractAddressFromHash(
    GATE_SALT, classHash, [OWNER_PUB], 0);
  mig.v03_class_hash = classHash;
  mig.gate_salt = GATE_SALT;
  mig.predicted_address = address;
  saveMig(mig);
  result({ step: 'predict', class_hash: classHash, predicted_address: address });
}

async function fund(provider, mig) {
  const to = mig.predicted_address;
  if (!to) throw new Error('run --predict first');
  const deployer = makeAccount(provider, DEPLOYER_ADDR, DEPLOYER_PRIV);
  const nonce = await provider.getNonceForAddress(DEPLOYER_ADDR);
  const calls = [{
    contractAddress: STRK, entrypoint: 'transfer',
    calldata: [to, FUND_AMOUNT.toString(), '0'],
  }];
  const est = await deployer.estimateInvokeFee(calls, { nonce });
  const tx = await deployer.execute(calls, { nonce, resourceBounds: padBounds(est) });
  await waitOk(provider, tx.transaction_hash, 'fund');
  const bal = await call(provider, STRK, 'balance_of', [to]);
  const balance = BigInt(bal[0]) + (BigInt(bal[1]) << 128n);
  if (balance === 0n) throw new Error('funded address shows zero STRK balance');
  mig.fund_tx = tx.transaction_hash;
  mig.funded_strk = balance.toString();
  saveMig(mig);
  result({ step: 'fund', tx: tx.transaction_hash, strk_balance: balance.toString() });
}

async function deployAccountStep(provider, mig) {
  const classHash = mig.v03_class_hash;
  const address = mig.predicted_address;
  if (!classHash || !address) throw new Error('run --predict first');
  if (!mig.fund_tx) throw new Error('run --fund first');

  const gate = makeAccount(provider, address, OWNER_PRIV);
  const payload = {
    classHash, constructorCalldata: [OWNER_PUB], addressSalt: GATE_SALT,
  };
  const est = await gate.estimateAccountDeployFee(payload);
  const tx = await gate.deployAccount(payload, { resourceBounds: padBounds(est) });
  await waitOk(provider, tx.transaction_hash, 'deploy_account');

  // Read back: the chain must say this address runs THIS class and holds THIS key.
  const onChainClass = await provider.getClassHashAt(address);
  if (BigInt(onChainClass) !== BigInt(classHash)) {
    throw new Error(`class hash at address ${onChainClass} != declared ${classHash}`);
  }
  const pub = await call(provider, address, 'get_public_key', []);
  if (BigInt(pub[0]) !== BigInt(OWNER_PUB)) {
    throw new Error(`on-chain owner key ${pub[0]} != ${OWNER_PUB}`);
  }
  mig.gate_address = address;
  mig.deploy_account_tx = tx.transaction_hash;
  saveMig(mig);
  result({
    step: 'deploy_account', tx: tx.transaction_hash, address,
    class_hash_verified: onChainClass, owner_key_verified: pub[0],
  });
}

async function deployToken(provider, mig) {
  const gate = mig.gate_address;
  if (!gate) throw new Error('run --deploy-account first');
  const deployer = makeAccount(provider, DEPLOYER_ADDR, DEPLOYER_PRIV);
  const nonce = await provider.getNonceForAddress(DEPLOYER_ADDR);
  const payload = {
    classHash: ERC20_CLASS,
    salt: TOKEN_SALT,
    constructorCalldata: [gate, TOKEN_SUPPLY_LOW, '0'],
  };
  const est = await deployer.estimateDeployFee(payload, { nonce });
  const res = await deployer.deployContract(payload, {
    nonce, resourceBounds: padBounds(est),
  });
  await waitOk(provider, res.transaction_hash, 'deploy_token');
  const bal = await call(provider, res.contract_address, 'balance_of', [gate]);
  const balance = BigInt(bal[0]) + (BigInt(bal[1]) << 128n);
  if (balance !== BigInt(TOKEN_SUPPLY_LOW)) {
    throw new Error(`new token supply to gate is ${balance}, expected ${TOKEN_SUPPLY_LOW}`);
  }
  mig.token_address = res.contract_address;
  mig.token_deploy_tx = res.transaction_hash;
  saveMig(mig);
  result({
    step: 'deploy_token', tx: res.transaction_hash, token: res.contract_address,
    gate_balance: balance.toString(),
  });
}

async function mandate(provider, mig) {
  const gate = mig.gate_address;
  const token = mig.token_address;
  if (!gate || !token) throw new Error('run --deploy-token first');

  // Read the CURRENT mandate off the OLD gate — the migration promise is "same
  // rules, new address", so the values come from the chain, not from notes.
  // One ABI limit: get_session_data returns only allowed_entrypoints_LEN (the
  // selectors live in a private map with no getter). So the chain is
  // authoritative for the COUNT, and the recorded mandate (state.json, whose
  // selectors were verified from three independent sources) supplies the names —
  // cross-checked both ways: computed selector == recorded selector, and the
  // number of names == the on-chain count.
  const session = await call(provider, OLD_GATE, 'get_session_data', [SESSION_PUB]);
  const validUntil = session[0];
  const maxCalls = session[1];
  const epLen = Number(session[3]);
  const epNames = state.mandate.session.allowed_entrypoints;
  if (epLen === 0 || epLen !== epNames.length) {
    throw new Error(`old gate reports ${epLen} entrypoints but the recorded mandate lists ${epNames.length}: ${JSON.stringify(session)}`);
  }
  const entrypoints = epNames.map((name) => {
    const sel = sn.hash.getSelector(name);
    const recorded = state.selectors[name];
    if (!recorded || BigInt(sel) !== BigInt(recorded)) {
      throw new Error(`selector for '${name}' computes to ${sel} but state.json records ${recorded}`);
    }
    return sel;
  });
  const policy = await call(provider, OLD_GATE, 'get_spending_policy', [SESSION_PUB, OLD_TOKEN]);
  const [mpcLow, mpcHigh, mpwLow, mpwHigh, windowSeconds] = policy.slice(0, 5);
  const allowed = await call(provider, OLD_GATE, 'is_recipient_allowed',
    [SESSION_PUB, OLD_TOKEN, MERCHANT]);
  if (BigInt(allowed[0]) !== 1n) {
    throw new Error('merchant is not allowlisted on the old gate — refusing to mirror a broken mandate');
  }

  const calls = [
    // add_or_update_session_key(session_key, valid_until u64, max_calls u32, entrypoints Array<felt252>)
    {
      contractAddress: gate, entrypoint: 'add_or_update_session_key',
      calldata: [SESSION_PUB, validUntil, maxCalls, String(epLen), ...entrypoints],
    },
    // set_spending_policy(session_key, token, mpc u256, mpw u256, window u64)
    {
      contractAddress: gate, entrypoint: 'set_spending_policy',
      calldata: [SESSION_PUB, token, mpcLow, mpcHigh, mpwLow, mpwHigh, windowSeconds],
    },
    // allow_recipient(session_key, token, recipient)
    {
      contractAddress: gate, entrypoint: 'allow_recipient',
      calldata: [SESSION_PUB, token, MERCHANT],
    },
    // set_wallet_controller(self) — the pasted-key SNIP-9 shape: the owner key
    // validates through the gate's own owner-only is_valid_signature (snforge t18).
    {
      contractAddress: gate, entrypoint: 'set_wallet_controller',
      calldata: [gate],
    },
  ];

  const tx = await ownerExecute(provider, gate, calls, 'mandate');

  // Read all four back.
  const s2 = await call(provider, gate, 'get_session_data', [SESSION_PUB]);
  const p2 = await call(provider, gate, 'get_spending_policy', [SESSION_PUB, token]);
  const a2 = await call(provider, gate, 'is_recipient_allowed', [SESSION_PUB, token, MERCHANT]);
  const c2 = await call(provider, gate, 'get_wallet_controller', []);
  if (BigInt(s2[0]) !== BigInt(validUntil) || BigInt(s2[1]) !== BigInt(maxCalls)
    || Number(s2[3]) !== epLen) {
    throw new Error(`session read-back mismatch: ${JSON.stringify(s2)}`);
  }
  const want = [mpcLow, mpcHigh, mpwLow, mpwHigh, windowSeconds];
  if (!p2.slice(0, 5).every((v, i) => BigInt(v) === BigInt(want[i]))) {
    throw new Error(`policy read-back mismatch: ${JSON.stringify(p2)}`);
  }
  if (BigInt(a2[0]) !== 1n) throw new Error('merchant not allowlisted on the new gate');
  if (BigInt(c2[0]) !== BigInt(gate)) {
    throw new Error(`wallet controller is ${c2[0]}, expected the gate itself ${gate}`);
  }
  mig.mandate_tx = tx;
  mig.mandate_values = {
    session_valid_until: validUntil, session_max_calls: maxCalls,
    entrypoints, max_per_call: [mpcLow, mpcHigh], max_per_window: [mpwLow, mpwHigh],
    window_seconds: windowSeconds, controller: gate,
  };
  saveMig(mig);
  result({ step: 'mandate', tx, mirrored: mig.mandate_values });
}

async function anchor(provider, mig) {
  const gate = mig.gate_address;
  if (!gate) throw new Error('run --deploy-account first');
  const a = state.layer_d.anchors[0];
  const calls = [{
    contractAddress: EVIDENCE, entrypoint: 'anchor',
    calldata: [a.agent_id, a.root, String(a.count)],
  }];
  const tx = await ownerExecute(provider, gate, calls, 'anchor');
  const back = await call(provider, EVIDENCE, 'get_anchor', [a.agent_id, gate]);
  if (BigInt(back[0]) !== BigInt(a.root) || Number(back[1]) !== a.count) {
    throw new Error(`anchor read-back mismatch: ${JSON.stringify(back)}`);
  }
  mig.anchor_tx = tx;
  saveMig(mig);
  result({ step: 'anchor', tx, root: back[0], count: Number(back[1]) });
}

async function outside(provider, mig) {
  const gate = mig.gate_address;
  const token = mig.token_address;
  if (!gate || !token || !mig.mandate_tx) throw new Error('run --mandate first');

  // The owner signs a SNIP-9 typed data whose hash binds to the CONTROLLER
  // address — which the mandate step registered as the gate itself. This is the
  // exact snforge t18 shape, live: a third party (the deployer, different key,
  // different address) relays what only the owner could authorize.
  const now = Math.floor(Date.now() / 1000);
  const nonce = BigInt(Date.now());
  const typedData = outsideExecutionTypedData({
    chainId: 'SN_SEPOLIA',
    caller: 'ANY_CALLER',
    nonce,
    executeAfter: now - 60,
    executeBefore: now + 3600,
    calls: [{ to: token, selector: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] }],
  });
  const { r, s, digest } = signTypedData(typedData, gate, OWNER_PRIV);
  console.log('outside execution digest =', hex(digest));

  const deployer = makeAccount(provider, DEPLOYER_ADDR, DEPLOYER_PRIV);
  const dNonce = await provider.getNonceForAddress(DEPLOYER_ADDR);
  // Wire layout, packed explicitly. (CallData.compile length-prefixes EVERY nested
  // array — it would wrap each Call struct in an extra length the ABI does not
  // have; the first live attempt failed estimation with exactly that.) OutsideExecution
  // serializes as: caller, nonce, execute_after u64, execute_before u64, then
  // Span<Call> = len + per call (to, selector, calldata_len, calldata...), then
  // Span<felt252> = len + signature.
  const callCalldata = [
    sn.shortString.encodeShortString('ANY_CALLER'),
    hex(nonce), String(now - 60), String(now + 3600),
    '0x1',
    token, SEL_TRANSFER, '0x3', MERCHANT, '0x5', '0x0',
    '0x2', r, s,
  ];
  const calls = [{
    contractAddress: gate, entrypoint: 'execute_from_outside_v2', calldata: callCalldata,
  }];
  const est = await deployer.estimateInvokeFee(calls, { nonce: dNonce });
  const tx = await deployer.execute(calls, { nonce: dNonce, resourceBounds: padBounds(est) });
  await waitOk(provider, tx.transaction_hash, 'execute_from_outside_v2');

  // Read the consequences back.
  const mBal = await call(provider, token, 'balance_of', [MERCHANT]);
  const gBal = await call(provider, token, 'balance_of', [gate]);
  const used = await call(provider, gate, 'is_valid_outside_execution_nonce', [hex(nonce)]);
  if (BigInt(mBal[0]) !== 5n) throw new Error(`merchant balance is ${mBal[0]}, expected 5`);
  if (BigInt(used[0]) !== 0n) throw new Error('nonce was not consumed — replay window open');
  mig.outside = {
    tx: tx.transaction_hash, digest: hex(digest), nonce: hex(nonce),
    relayer: DEPLOYER_ADDR, signature: { r, s },
    merchant_balance_after: mBal[0], gate_balance_after: gBal[0],
    window: { execute_after: now - 60, execute_before: now + 3600 },
  };
  saveMig(mig);
  result({ step: 'outside', ...mig.outside });
}

async function verify(provider, mig) {
  const gate = mig.gate_address;
  const token = mig.token_address;
  if (!gate || !token) throw new Error('nothing deployed yet');
  let failures = 0;
  const check = async (label, fn) => {
    try {
      const ok = await fn();
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
      if (!ok) failures += 1;
    } catch (e) {
      console.log(`FAIL  ${label} — ${String(e?.message ?? e).slice(0, 200)}`);
      failures += 1;
    }
  };

  await check('class at address is the declared v0.3 class', async () =>
    BigInt(await provider.getClassHashAt(gate)) === BigInt(mig.v03_class_hash));
  await check('owner key on-chain is the pasted owner key', async () =>
    BigInt((await call(provider, gate, 'get_public_key', []))[0]) === BigInt(OWNER_PUB));
  await check('SRC-5 advertises ISRC6', async () =>
    (await call(provider, gate, 'supports_interface', [state.verified_on_chain.ISRC6_ID_used]))[0] === '0x1');
  await check('starknet.js detects SNIP-9 V2 via getSnip9Version()', async () => {
    // Library-native probe: an Account addressed at the gate asks
    // supports_interface with starknet.js's own SNIP9_V2_INTERFACE_ID constant
    // and reports OutsideExecutionVersion. No ID is typed here — if the library
    // and the contract ever disagree about what "supports SNIP-9 v2" means,
    // this is the check that catches it. (Signer is never used; the probe only
    // reads.)
    const probe = new sn.Account({
      provider, address: gate, signer: new sn.Signer(DEPLOYER_PRIV), cairoVersion: '1',
    });
    const version = await probe.getSnip9Version();
    console.log(`      getSnip9Version() = ${version} (V2 = ${sn.OutsideExecutionVersion.V2})`);
    return version === sn.OutsideExecutionVersion.V2;
  });
  await check('wallet controller = the gate itself', async () =>
    BigInt((await call(provider, gate, 'get_wallet_controller', []))[0]) === BigInt(gate));
  await check('session registered (valid_until 2000000000, max_calls 10, 1 entrypoint)', async () => {
    // get_session_data returns 4 felts: valid_until, max_calls, calls_used,
    // allowed_entrypoints_len (the selectors themselves have no public getter —
    // the entrypoint whitelist is enforced in __validate__ regardless).
    const s = await call(provider, gate, 'get_session_data', [SESSION_PUB]);
    return Number(s[0]) === 2000000000 && Number(s[1]) === 10 && Number(s[3]) === 1;
  });
  await check('policy mirrored from the old gate (per-call/window)', async () => {
    const oldP = await call(provider, OLD_GATE, 'get_spending_policy', [SESSION_PUB, OLD_TOKEN]);
    const newP = await call(provider, gate, 'get_spending_policy', [SESSION_PUB, token]);
    return [0, 1, 2, 3, 4].every((i) => BigInt(oldP[i]) === BigInt(newP[i]));
  });
  await check('merchant allowlisted, stranger denied (deny by default)', async () => {
    const m = await call(provider, gate, 'is_recipient_allowed', [SESSION_PUB, token, MERCHANT]);
    const st = await call(provider, gate, 'is_recipient_allowed', [SESSION_PUB, token, STRANGER]);
    return BigInt(m[0]) === 1n && BigInt(st[0]) === 0n;
  });
  await check('outside execution landed: merchant holds 5', async () => {
    const b = await call(provider, token, 'balance_of', [MERCHANT]);
    return BigInt(b[0]) >= 5n;
  });
  await check('outside nonce consumed (replay closed)', async () => {
    if (!mig.outside?.nonce) return false;
    const u = await call(provider, gate, 'is_valid_outside_execution_nonce', [mig.outside.nonce]);
    return BigInt(u[0]) === 0n;
  });
  await check('evidence root re-anchored under the new gate', async () => {
    const a = state.layer_d.anchors[0];
    const back = await call(provider, EVIDENCE, 'get_anchor', [a.agent_id, gate]);
    return BigInt(back[0]) === BigInt(a.root) && Number(back[1]) === a.count;
  });

  result({ step: 'verify', failures });
  if (failures > 0) process.exit(1);
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--class-hash');
  const classHash = ci !== -1 ? args[ci + 1] : undefined;
  const mode = args.find((a) => a.startsWith('--') && a !== '--class-hash');
  const mig = loadMig();
  if (classHash) mig.v03_class_hash = classHash;

  if (!mode) {
    console.error('usage: node migrate-v3.mjs [--class-hash 0x..] --predict|--fund|--deploy-account|--deploy-token|--mandate|--anchor|--outside|--verify');
    process.exit(2);
  }

  if (mode === '--predict') {
    predict(mig, mig.v03_class_hash);
    return;
  }

  const provider = new sn.RpcProvider({ nodeUrl: RPC });
  const chainId = await provider.getChainId();
  if (BigInt(chainId) !== BigInt(state.chain_id_hex)) {
    throw new Error(`RPC reports chain ${chainId}, expected ${state.chain_id_hex}`);
  }

  const steps = {
    '--fund': () => fund(provider, mig),
    '--deploy-account': () => deployAccountStep(provider, mig),
    '--deploy-token': () => deployToken(provider, mig),
    '--mandate': () => mandate(provider, mig),
    '--anchor': () => anchor(provider, mig),
    '--outside': () => outside(provider, mig),
    '--verify': () => verify(provider, mig),
  };
  if (!steps[mode]) throw new Error(`unknown mode ${mode}`);
  await steps[mode]();
}

main().catch((e) => {
  console.error(String(e?.message ?? e).slice(0, 2000));
  result({ status: 'ERROR', message: String(e?.message ?? e).slice(0, 500) });
  process.exit(1);
});
