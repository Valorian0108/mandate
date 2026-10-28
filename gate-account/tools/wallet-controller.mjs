// Phase 5: the wallet-shaped controller account.
//
// WHY: a native wallet hashes typed data with its OWN address (binding finding,
// OBS-14), and the v0.3 gate verifies SNIP-9 signatures by delegating to
// wallet_controller.is_valid_signature. So for a wallet signature to validate,
// the registered controller must be an ACCOUNT CONTRACT that (a) exposes the
// wallet's key via get_public_key, and (b) validates signatures as ISRC6.
//
// The harness cannot install Argent X, so the honest analog is a second
// instance of the SAME standard OpenZeppelin account class the deployer runs
// (class from state.json keys.deployer.class_hash - probed live before this
// tool existed: get_public_key OK, ISRC6 supported, is_valid_signature returns
// 'VALID' for its own key and NOT-VALID for a wrong key). It is deployed with
// the OWNER public key as constructor arg, so the testnet owner key - the key
// the console's mock wallet signs with - controls it exactly like a real
// wallet's key controls the wallet's account.
//
// Steps (each verifies its own result on-chain before recording; nothing is
// trusted from memory):
//
//   node wallet-controller.mjs --deploy
//       UDC-deploy the wallet account (salt 'MOCK_WALLET', calldata [owner_pub]);
//       read back get_public_key + ISRC6.
//   node wallet-controller.mjs --probe
//       is_valid_signature honesty: owner-key signature -> 'VALID',
//       wrong-key (deployer key) signature -> NOT 'VALID'. This is the check
//       the gate's delegation relies on; a rubber stamp here would make the
//       whole SNIP-9 story theater.
//   node wallet-controller.mjs --register
//       ONE owner tx on the gate: set_wallet_controller(wallet). Read back
//       get_wallet_controller. NOTE: this moves the controller off the phase-4
//       self-controller shape; the phase-4 receipts stay valid on-chain forever
//       and the slot is owner-gated, so phase 6 can point it at real Argent X.
//   node wallet-controller.mjs --verify
//       full read-back sweep, PASS/FAIL lines.
//
// TESTNET KEYS ONLY - everything comes from ../.sepolia/state.json.
import { readFileSync, writeFileSync } from 'node:fs';
import * as sn from 'starknet';
import { sign as starkSign } from '@scure/starknet';

const state = JSON.parse(
  readFileSync(new URL('../.sepolia/state.json', import.meta.url), 'utf8'));
const REC_PATH = new URL('../.sepolia/wallet-controller.json', import.meta.url);

const RPC = state.rpc_endpoints_verified.cartridge.url;
const GATE = state.contracts.gate_account.address;
const WALLET_CLASS = state.keys.deployer.class_hash; // probed live: honest ISRC6 account
const OWNER_PRIV = state.keys.owner.private_key;
const OWNER_PUB = state.keys.owner.public_key;
const WRONG_PRIV = state.keys.deployer.private_key; // for the honesty probe only
const DEPLOYER_ADDR = state.keys.deployer.address;
const DEPLOYER_PRIV = state.keys.deployer.private_key;
const ISRC6_ID = state.verified_on_chain.ISRC6_ID_used;

const WALLET_SALT = sn.shortString.encodeShortString('MOCK_WALLET');
const VALID_FELT = sn.shortString.encodeShortString('VALID');

const hex = (v) => '0x' + BigInt(v).toString(16);

function loadRec() {
  try {
    return JSON.parse(readFileSync(REC_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveRec(rec) {
  writeFileSync(REC_PATH, JSON.stringify(rec, null, 2) + '\n');
}
function result(obj) {
  console.log('WALLET_RESULT ' + JSON.stringify(obj, (_, v) =>
    typeof v === 'bigint' ? hex(v) : v));
}

// OBS-10: keep the estimate's native BigInt bounds; pad generously (unused gas
// refunds). OBS-19: judge runs by receipts, not by PowerShell's exit-code mood.
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

async function call(provider, contractAddress, entrypoint, calldata) {
  return provider.callContract({ contractAddress, entrypoint, calldata });
}

// ---------------------------------------------------------------- steps

async function deploy(provider, rec) {
  const deployer = makeAccount(provider, DEPLOYER_ADDR, DEPLOYER_PRIV);
  const payload = {
    classHash: WALLET_CLASS,
    salt: WALLET_SALT,
    constructorCalldata: [OWNER_PUB],
  };
  const est = await deployer.estimateDeployFee(payload);
  const res = await deployer.deployContract(payload, { resourceBounds: padBounds(est) });
  await waitOk(provider, res.transaction_hash, 'deploy wallet account');

  // Read back: the chain must say this account holds the OWNER key and speaks ISRC6.
  const pub = await call(provider, res.contract_address, 'get_public_key', []);
  if (BigInt(pub[0]) !== BigInt(OWNER_PUB)) {
    throw new Error(`wallet account key ${pub[0]} != owner key ${OWNER_PUB}`);
  }
  const isrc6 = await call(provider, res.contract_address, 'supports_interface', [ISRC6_ID]);
  if (BigInt(isrc6[0]) !== 1n) {
    throw new Error(`wallet account does not support ISRC6 (${isrc6[0]})`);
  }
  rec.wallet_address = res.contract_address;
  rec.wallet_deploy_tx = res.transaction_hash;
  rec.wallet_class = WALLET_CLASS;
  saveRec(rec);
  result({
    step: 'deploy', tx: res.transaction_hash, wallet: res.contract_address,
    public_key_verified: pub[0], isrc6_verified: true,
  });
}

async function probe(provider, rec) {
  const wallet = rec.wallet_address;
  if (!wallet) throw new Error('run --deploy first');

  // The exact delegation property the gate relies on (src/lib.cairo
  // assert_valid_signature requires 'VALID'): the controller validates its own
  // key's signatures and REFUSES everyone else's. Signed over a fixed dummy
  // hash - this probe never touches a real authorization.
  const dummy = '0x1234567890abcdef';
  const good = starkSign(dummy, OWNER_PRIV);
  const bad = starkSign(dummy, WRONG_PRIV);
  const okRes = await call(provider, wallet, 'is_valid_signature',
    [dummy, '0x2', hex(good.r), hex(good.s)]);
  const badRes = await call(provider, wallet, 'is_valid_signature',
    [dummy, '0x2', hex(bad.r), hex(bad.s)]);
  const ok = BigInt(okRes[0]) === BigInt(VALID_FELT);
  const refused = BigInt(badRes[0]) !== BigInt(VALID_FELT);
  if (!ok || !refused) {
    throw new Error(`controller honesty probe failed: own-key -> ${okRes[0]} ` +
      `(expected 'VALID' ${VALID_FELT}), wrong-key -> ${badRes[0]} (expected NOT 'VALID')`);
  }
  rec.honesty_probe = {
    dummy_hash: dummy,
    own_key_verdict: sn.shortString.decodeShortString(okRes[0]),
    wrong_key_verdict_felt: badRes[0],
    probe_note: "own key -> 'VALID'; deployer key -> not 'VALID'. The gate's delegation is real, not a rubber stamp.",
  };
  saveRec(rec);
  result({ step: 'probe', own_key: 'VALID', wrong_key_refused: true });
}

async function register(provider, rec) {
  const wallet = rec.wallet_address;
  if (!wallet) throw new Error('run --deploy first');
  if (!rec.honesty_probe) throw new Error('run --probe first (never register an unprobed controller)');

  // Owner path on the gate: 2-felt ECDSA over the v3 tx hash (owner-tx.mjs pattern).
  const gate = makeAccount(provider, GATE, OWNER_PRIV);
  const derived = (await new sn.Signer(OWNER_PRIV).getPubKey()).toLowerCase();
  if (derived !== OWNER_PUB.toLowerCase()) {
    throw new Error(`owner key mismatch: derived ${derived} vs ${OWNER_PUB}`);
  }
  const calls = [{
    contractAddress: GATE, entrypoint: 'set_wallet_controller', calldata: [wallet],
  }];
  const nonce = await provider.getNonceForAddress(GATE);
  const est = await gate.estimateInvokeFee(calls, { nonce });
  const tx = await gate.execute(calls, { nonce, resourceBounds: padBounds(est) });
  await waitOk(provider, tx.transaction_hash, 'set_wallet_controller');

  const back = await call(provider, GATE, 'get_wallet_controller', []);
  if (BigInt(back[0]) !== BigInt(wallet)) {
    throw new Error(`controller read-back is ${back[0]}, expected ${wallet}`);
  }
  rec.controller_registered_tx = tx.transaction_hash;
  rec.controller_of = GATE;
  saveRec(rec);
  result({ step: 'register', tx: tx.transaction_hash, controller: back[0] });
}

async function verify(provider, rec) {
  const wallet = rec.wallet_address;
  if (!wallet) throw new Error('nothing deployed yet');
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

  await check('wallet account holds the OWNER key (chain read)', async () =>
    BigInt((await call(provider, wallet, 'get_public_key', []))[0]) === BigInt(OWNER_PUB));
  await check('wallet account supports ISRC6', async () =>
    BigInt((await call(provider, wallet, 'supports_interface', [ISRC6_ID]))[0]) === 1n);
  await check('wallet account is the declared standard OZ account class', async () =>
    BigInt(await provider.getClassHashAt(wallet)) === BigInt(WALLET_CLASS));
  await check("is_valid_signature: owner key -> 'VALID'", async () => {
    const s = starkSign('0x1234567890abcdef', OWNER_PRIV);
    const r = await call(provider, wallet, 'is_valid_signature',
      ['0x1234567890abcdef', '0x2', hex(s.r), hex(s.s)]);
    return BigInt(r[0]) === BigInt(VALID_FELT);
  });
  await check('is_valid_signature: wrong key -> NOT VALID', async () => {
    const s = starkSign('0x1234567890abcdef', WRONG_PRIV);
    const r = await call(provider, wallet, 'is_valid_signature',
      ['0x1234567890abcdef', '0x2', hex(s.r), hex(s.s)]);
    return BigInt(r[0]) !== BigInt(VALID_FELT);
  });
  await check('gate wallet_controller = the wallet account', async () =>
    BigInt((await call(provider, GATE, 'get_wallet_controller', []))[0]) === BigInt(wallet));
  await check('gate still advertises SNIP-9 V2 (library probe)', async () => {
    const probeAcct = new sn.Account({
      provider, address: GATE, signer: new sn.Signer(DEPLOYER_PRIV), cairoVersion: '1',
    });
    return (await probeAcct.getSnip9Version()) === sn.OutsideExecutionVersion.V2;
  });

  result({ step: 'verify', failures });
  if (failures > 0) process.exit(1);
}

// ---------------------------------------------------------------- main

async function main() {
  const mode = process.argv.find((a) => a.startsWith('--'));
  if (!mode) {
    console.error('usage: node wallet-controller.mjs --deploy|--probe|--register|--verify');
    process.exit(2);
  }
  const provider = new sn.RpcProvider({ nodeUrl: RPC });
  const chainId = await provider.getChainId();
  if (BigInt(chainId) !== BigInt(state.chain_id_hex)) {
    throw new Error(`RPC reports chain ${chainId}, expected ${state.chain_id_hex}`);
  }
  const rec = loadRec();
  const steps = {
    '--deploy': () => deploy(provider, rec),
    '--probe': () => probe(provider, rec),
    '--register': () => register(provider, rec),
    '--verify': () => verify(provider, rec),
  };
  if (!steps[mode]) throw new Error(`unknown mode ${mode}`);
  await steps[mode]();
}

main().catch((e) => {
  console.error(String(e?.message ?? e).slice(0, 2000));
  result({ status: 'ERROR', message: String(e?.message ?? e).slice(0, 500) });
  process.exit(1);
});
