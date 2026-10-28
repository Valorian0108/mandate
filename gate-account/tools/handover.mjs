// Phase 6: the handover — rotate the GateAccount's owner from the pasted
// testnet key to the USER'S REAL READY X wallet (formerly Argent X), in one
// atomic owner-signed invoke that is the pasted key's last act.
//
// WHY the shape is what it is (all binding findings, recorded in
// track2-wallet-research.md and observations.md):
//
//   * OpenZeppelin v4.0.1 AccountComponent::set_public_key (account.cairo
//     L156/L323-338) demands TWO proofs: assert_only_self (only the gate's own
//     __execute__, i.e. an owner-signed invoke on the gate) and
//     assert_valid_new_owner — the NEW key must sign the raw poseidon hash
//     poseidon('StarkNet Message','accept_ownership', gate, current_owner_pub).
//     Cairo tests t36-t38 pin that hash and both refusals; the JS mirror is
//     tools/accept-ownership-vector.mjs.
//   * A raw hash is NOT reachable through the Wallet Standard (signMessage is
//     SNIP-12 typed data only), so the accept-ownership signature must come
//     from Ready X's (formerly Argent X) EXPORTED PRIVATE KEY, used once
//     locally in --prepare, never stored, never sent anywhere. The keyfile is
//     deleted the moment the signature exists.
//   * The handover itself is ONE invoke carrying TWO calls:
//       [set_public_key(wallet_pub, [r, s]), set_wallet_controller(wallet_addr)]
//     Starknet invoke atomicity means no partial states: either the wallet owns
//     the gate AND is its SNIP-9 controller, or nothing changed. Both calls are
//     caller-gated (owner path), and __validate__ checks the OLD owner key
//     before either executes — so the invoke is signed by the pasted key and
//     both calls land under that one validation.
//   * After this, the pasted key is dead on the gate (t37 proves the replaced
//     key stops validating); the deployer key remains gas-only infrastructure.
//
// Steps (each verifies its own result on-chain before recording; nothing is
// trusted from memory — every constant comes from ../.sepolia/state.json):
//
//   node handover.mjs --check <walletAddress>
//       Is the Ready X (formerly Argent X) account deployed on Sepolia? What
//       key does the chain say it holds? STRK balances (wallet, gate,
//       deployer)? Refuses if the address is the gate, the deployer or the
//       mock wallet.
//   node handover.mjs --fund <walletAddress> <strkAmount>
//       Deployer -> wallet STRK transfer (the wallet needs gas to deploy its
//       account and later to sign), plus a gate top-up if the gate is low: the
//       handover invoke itself is sent BY the gate and pays from its balance.
//   node handover.mjs --prepare <walletAddress> <keyfile>
//       The ONE moment the exported key exists: derive its public key, match it
//       against the chain's copy, compute the accept-ownership hash, sign it
//       locally, run the honesty probe (the wallet account must validate its
//       own key and refuse a stranger — the gate will delegate SNIP-9 checks to
//       it), save {r,s} + facts, DELETE the keyfile. The private key is never
//       written to the prep file and never sent to the server.
//   node handover.mjs --execute
//       The atomic invoke, signed by the pasted owner key (its last act).
//       Dry-run estimate first; padded bounds per OBS-10; receipt-checked per
//       OBS-19; then read back BOTH facts from the chain.
//   node handover.mjs --verify
//       Full sweep incl. the negative control: a signature by the OLD pasted
//       key must NOT validate on the gate anymore.
//
// TESTNET ONLY.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import * as sn from 'starknet';
import { getStarkKey, poseidonHashMany, sign as starkSign } from '@scure/starknet';
import { shortStringEncode } from '../../permission-core/web/typed-data.js';

const state = JSON.parse(
  readFileSync(new URL('../.sepolia/state.json', import.meta.url), 'utf8'));
const PREP_PATH = new URL('../.sepolia/handover-prep.json', import.meta.url);
const REC_PATH = new URL('../.sepolia/handover.json', import.meta.url);

const RPC = state.rpc_endpoints_verified.cartridge.url;
const GATE = state.contracts.gate_account.address;
const STRK = state.strk_token_sepolia.address;
const OWNER_PRIV = state.keys.owner.private_key;
const OWNER_PUB = state.keys.owner.public_key;
const DEPLOYER_ADDR = state.keys.deployer.address;
const DEPLOYER_PRIV = state.keys.deployer.private_key;
const MOCK_WALLET = state.mandate.mock_wallet.address;
const ISRC6_ID = state.verified_on_chain.ISRC6_ID_used;
const VALID_FELT = sn.shortString.encodeShortString('VALID');

// The gate must keep enough STRK to pay for the handover invoke and future
// wallet-signed relays. Below this, --fund tops it up from the deployer.
const MIN_GATE_STRK = 5n * 10n ** 16n; // 0.05 STRK
const GATE_TOPUP_STRK = 10n * 10n ** 16n; // 0.1 STRK
const DUMMY_HASH = '0x1234567890abcdef'; // fixed probe hash; never a real authorization

const hex = (v) => '0x' + BigInt(v).toString(16);
const norm = (a) => '0x' + BigInt(a).toString(16);

function result(obj) {
  console.log('HANDOVER_RESULT ' + JSON.stringify(obj, (_, v) =>
    typeof v === 'bigint' ? hex(v) : v));
}
function loadJson(url) {
  try {
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return null;
  }
}
function saveJson(url, obj) {
  writeFileSync(url, JSON.stringify(obj, null, 2) + '\n');
}

// OBS-10: keep the estimate's native BigInt bounds; pad generously (unused gas
// refunds). OBS-19: judge runs by receipts, not by exit codes.
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

// Decimal STRK ("0.05") -> wei, by string — never through float arithmetic.
function strkToWei(amount) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(amount).trim());
  if (!m) throw new Error(`'${amount}' is not a plain decimal STRK amount`);
  const frac = (m[2] ?? '').padEnd(18, '0');
  if (frac.length > 18) throw new Error('at most 18 decimals');
  return BigInt(m[1]) * 10n ** 18n + BigInt(frac);
}
const u256 = (wei) => [hex(wei & ((1n << 128n) - 1n)), hex(wei >> 128n)];
async function strkBalance(provider, addr) {
  const [low, high] = await call(provider, STRK, 'balance_of', [addr]);
  return (BigInt(high) << 128n) + BigInt(low);
}
const fmtStrk = (wei) => `${Number(wei) / 1e9 / 1e9} STRK`;

// The accept-ownership hash, computed with the SAME primitives the cross-language
// vector pins (t36 == accept-ownership-vector.mjs == this code path).
function acceptOwnershipHash(gate, currentOwnerPub) {
  return poseidonHashMany([
    shortStringEncode('StarkNet Message'),
    shortStringEncode('accept_ownership'),
    BigInt(gate),
    BigInt(currentOwnerPub),
  ]);
}

// Read the gate's CURRENT owner key from the chain — the hash must bind to what
// the chain says, not to what a file remembers. Cross-check the state file.
async function chainGateOwnerPub(provider) {
  const [pub] = await call(provider, GATE, 'get_public_key', []);
  if (norm(pub) !== norm(OWNER_PUB) && loadJson(PREP_PATH) === null) {
    // The gate owner is no longer the pasted key. Either the handover already
    // happened (--verify will confirm) or something moved it — refuse to guess.
    const rec = loadJson(REC_PATH);
    if (!rec?.executed) {
      throw new Error(`the chain says the gate's owner key is ${pub}, but the ` +
        `state file records ${OWNER_PUB} and no handover is recorded — refusing ` +
        'to build on a guess');
    }
  }
  return pub;
}

async function isDeployed(provider, addr) {
  try {
    const classHash = await provider.getClassHashAt(addr);
    return BigInt(classHash) !== 0n ? hex(classHash) : null;
  } catch {
    return null;
  }
}

// The wallet account's owner key + the signature format its is_valid_signature
// expects. Two generations, both read from the CHAIN (never assumed):
//   * OZ-style (our gate, the phase-5 mock): get_public_key; signatures [r, s].
//   * Ready X (formerly Argent X), ArgentAccount v0.4.0 — probed live on the
//     user's wallet 2026-10-26: get_owner + get_owner_type (0 = Starknet);
//     is_valid_signature takes the serialized SignerSignature
//     [signer_type, pubkey, r, s]. A 2-felt array reverts
//     'argent/invalid-signature-length'; a well-formed wrong signature returns
//     0 (the account verifies against its stored owner, not the pubkey carried
//     in the signature).
async function readWalletOwner(provider, addr) {
  const tryCall = async (entrypoint) => {
    try {
      return await call(provider, addr, entrypoint, []);
    } catch {
      return null;
    }
  };
  const oz = await tryCall('get_public_key');
  if (oz) {
    return { pub: oz[0], getter: 'get_public_key', ownerType: null, sigFormat: 'oz-raw' };
  }
  const ownerTypeRes = await tryCall('get_owner_type');
  if (!ownerTypeRes) {
    throw new Error(`cannot read ${addr}'s owner key: the account exposes neither ` +
      'get_public_key (OZ) nor get_owner (Ready X / ArgentAccount)');
  }
  if (BigInt(ownerTypeRes[0]) !== 0n) {
    throw new Error(`${addr}'s owner is signer type ${ownerTypeRes[0]}, not 0 ` +
      '(Starknet). The gate can only hand ownership to a Starknet public key; ' +
      'this wallet cannot be the gate owner.');
  }
  const owner = await tryCall('get_owner');
  if (!owner) {
    throw new Error(`get_owner_type says a Starknet owner exists, but get_owner ` +
      `failed on ${addr}`);
  }
  return {
    pub: owner[0], getter: 'get_owner', ownerType: '0x0', sigFormat: 'argent-signer-v1',
  };
}

// The honesty probe uses the CONCISE signature format: [r, s].
//   * OZ accounts: is_valid_signature(hash, [r, s]) — the only format.
//   * ArgentAccount v0.4.0 (Ready X): parse_signature_array treats a 2-felt
//     array as concise owner-only [owner_r, owner_s] (source: account-0.4.0
//     tag, src/presets/argent_account.cairo). This works ONLY when the account
//     has NO guardian; with a guardian, is_valid_span_signature asserts len==2
//     SignerSignatures and a 2-felt concise array reverts
//     'argent/invalid-signature-length'. A 4-felt concise array
//     [owner_r, owner_s, guardian_r, guardian_s] would be needed, but we do not
//     hold the guardian key — so the probe is skipped loudly (see prepare).
function walletSigArray(_wallet, r, s) {
  return [hex(r), hex(s)];
}

async function walletIsValidSignature(provider, addr, wallet, hash, r, s) {
  const sig = walletSigArray(wallet, r, s);
  const out = await call(provider, addr, 'is_valid_signature',
    [hash, hex(sig.length), ...sig]);
  return out[0];
}

// Does the wallet account have a guardian set? ArgentAccount v0.4.0 exposes
// get_guardian; OZ accounts may not. A guardian changes the signature format
// requirements for is_valid_signature (owner+guardian), which makes the
// owner-only honesty probe impossible without the guardian key.
async function walletHasGuardian(provider, addr) {
  try {
    const [g] = await call(provider, addr, 'get_guardian', []);
    return BigInt(g) !== 0n;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- steps

async function check(provider, addr) {
  if (!addr) throw new Error('usage: node handover.mjs --check <walletAddress>');
  for (const [label, known] of [['the gate itself', GATE], ['the deployer', DEPLOYER_ADDR],
    ['the phase-5 mock wallet', MOCK_WALLET]]) {
    if (norm(addr) === norm(known)) {
      throw new Error(`${addr} is ${label} — the handover needs the user's REAL Ready X (formerly Argent X) address`);
    }
  }
  const facts = { step: 'check', wallet: addr };
  facts.classHash = await isDeployed(provider, addr);
  facts.deployed = facts.classHash !== null;

  facts.strkBalances = {
    wallet: fmtStrk(await strkBalance(provider, addr)),
    gate: fmtStrk(await strkBalance(provider, GATE)),
    deployer: fmtStrk(await strkBalance(provider, DEPLOYER_ADDR)),
  };

  // The owner key + signature format, read through the account's OWN interface
  // (OZ get_public_key or Ready X get_owner). --prepare turns this into a hard
  // check against the exported key.
  try {
    const owner = await readWalletOwner(provider, addr);
    facts.publicKeyFromChain = owner.pub;
    facts.publicKeyGetter = owner.getter;
    facts.ownerType = owner.ownerType;
    facts.signatureFormat = owner.sigFormat;
  } catch (e) {
    facts.publicKeyFromChain = null;
    facts.publicKeyReadError = String(e?.message ?? e).slice(0, 240);
  }
  try {
    const [name] = await call(provider, addr, 'get_name', []);
    facts.accountName = sn.shortString.decodeShortString(name);
  } catch {
    facts.accountName = null;
  }
  try {
    const [v] = await call(provider, addr, 'getVersion', []);
    facts.accountVersion = sn.shortString.decodeShortString(v);
  } catch {
    facts.accountVersion = null;
  }
  try {
    const [g] = await call(provider, addr, 'get_guardian', []);
    facts.guardianPublicKey = BigInt(g) === 0n ? null : g;
    facts.hasGuardian = BigInt(g) !== 0n;
  } catch {
    facts.guardianPublicKey = null;
    facts.hasGuardian = false;
  }
  try {
    const [isrc6] = await call(provider, addr, 'supports_interface', [ISRC6_ID]);
    facts.supportsISRC6 = BigInt(isrc6) === 1n;
  } catch {
    facts.supportsISRC6 = null;
  }

  if (!facts.deployed) {
    console.log('NOT DEPLOYED YET: fund it (--fund), then deploy the account ' +
      'inside Ready X (formerly Argent X) on Sepolia (Settings -> account name ' +
      '-> Deploy account), and run --check again.');
  }
  result(facts);
  if (!facts.deployed) process.exit(1);
}

async function fund(provider, addr, amount) {
  if (!addr || !amount) throw new Error('usage: node handover.mjs --fund <walletAddress> <strkAmount>');
  const deployer = makeAccount(provider, DEPLOYER_ADDR, DEPLOYER_PRIV);
  const wei = strkToWei(amount);
  const deployerBal = await strkBalance(provider, DEPLOYER_ADDR);
  if (deployerBal < wei) {
    throw new Error(`deployer holds ${fmtStrk(deployerBal)}, cannot send ${amount} STRK`);
  }

  const before = await strkBalance(provider, addr);
  const send = async (to, value, label) => {
    const calls = [{
      contractAddress: STRK, entrypoint: 'transfer', calldata: [to, ...u256(value)],
    }];
    const nonce = await provider.getNonceForAddress(DEPLOYER_ADDR);
    const est = await deployer.estimateInvokeFee(calls, { nonce });
    const tx = await deployer.execute(calls, { nonce, resourceBounds: padBounds(est) });
    await waitOk(provider, tx.transaction_hash, label);
    return tx.transaction_hash;
  };

  const walletTx = await send(addr, wei, `fund wallet ${amount} STRK`);
  const afterWallet = await strkBalance(provider, addr);
  if (afterWallet - before !== wei) {
    throw new Error(`wallet balance moved ${fmtStrk(afterWallet - before)}, expected ${amount} STRK`);
  }

  // The handover invoke is sent BY the gate and pays from the gate's balance.
  const gateBefore = await strkBalance(provider, GATE);
  let gateTx = null;
  if (gateBefore < MIN_GATE_STRK) {
    gateTx = await send(GATE, GATE_TOPUP_STRK, 'top up gate gas');
  }
  const gateAfter = await strkBalance(provider, GATE);

  const rec = loadJson(REC_PATH) ?? {};
  rec.funding = {
    ...(rec.funding ?? {}),
    wallet: { address: addr, amount_strk: amount, tx: walletTx, balance_after: fmtStrk(afterWallet) },
    gate: {
      balance_before: fmtStrk(gateBefore), balance_after: fmtStrk(gateAfter),
      topup_tx: gateTx, note: gateTx ? 'topped up from deployer' : 'already above the minimum',
    },
    date: new Date().toISOString(),
  };
  saveJson(REC_PATH, rec);
  result({ step: 'fund', walletTx, gateTopupTx: gateTx, walletBalance: fmtStrk(afterWallet), gateBalance: fmtStrk(gateAfter) });
}

async function prepare(provider, addr, keyfile) {
  if (!addr || !keyfile) {
    throw new Error('usage: node handover.mjs --prepare <walletAddress> <keyfile>\n' +
      'The keyfile is the private key exported from Ready X (formerly Argent X) ' +
      '(Settings -> Export private key), saved as a plain text file. It is read ' +
      'once, used to sign the accept-ownership hash LOCALLY, and deleted. It is ' +
      'never stored anywhere and never sent to any server.');
  }
  if (!existsSync(keyfile)) throw new Error(`no keyfile at ${keyfile}`);
  if (!(await isDeployed(provider, addr))) {
    throw new Error(`${addr} is not deployed on Sepolia — run --fund and deploy the account in Ready X (formerly Argent X) first`);
  }

  const currentOwnerPub = await chainGateOwnerPub(provider);
  if (norm(currentOwnerPub) !== norm(OWNER_PUB)) {
    throw new Error(`the gate's owner is ${currentOwnerPub}, not the pasted key ` +
      `${OWNER_PUB} — the handover has either already happened or the chain ` +
      'disagrees with the record; refusing to prepare a second rotation');
  }

  // Read the exported key, derive, match against the chain's copy of the wallet.
  const raw = readFileSync(keyfile, 'utf8').trim();
  const priv = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(priv)) {
    unlinkSync(keyfile);
    throw new Error('the keyfile does not contain a single hex private key — the file was deleted; export again');
  }
  const walletPub = getStarkKey(priv);
  const wallet = await readWalletOwner(provider, addr);
  if (norm(wallet.pub) !== norm(walletPub)) {
    unlinkSync(keyfile);
    throw new Error(`the exported key derives to ${walletPub}, but the chain says ` +
      `the wallet account's owner (${wallet.getter}) is ${wallet.pub} — wrong key ` +
      'or wrong address; the file was deleted');
  }

  // The accept-ownership signature (raw hash — unreachable via Wallet Standard,
  // which is exactly why this one local signing exists). Pure ECDSA: the gate
  // verifies it with is_valid_stark_signature, not through the wallet account.
  const hash = acceptOwnershipHash(GATE, currentOwnerPub);
  const sig = starkSign(hex(hash), priv);

  // Honesty probe: the gate will delegate SNIP-9 verification to this wallet
  // account's is_valid_signature. It must validate its own key and REFUSE a
  // stranger (the deployer key) — a rubber stamp here would make the whole
  // delegation theater. Uses a fixed dummy hash, never a real authorization.
  //
  // GUARDIAN CAVEAT (ArgentAccount v0.4.0, source account-0.4.0 tag): when a
  // guardian is set, is_valid_signature requires BOTH owner and guardian
  // signatures (concise 4-felt [owner_r, owner_s, guardian_r, guardian_s] or
  // standard 9-felt with count=2). We do not hold the guardian key, so the
  // owner-only probe cannot return VALID. The probe is SKIPPED loudly; the
  // exported key was still verified against get_owner above, and the handover
  // itself (gate set_public_key) verifies the accept-ownership signature with
  // raw ECDSA — it does not go through the wallet's is_valid_signature.
  const hasGuardian = await walletHasGuardian(provider, addr);
  let keyIsValid = false;
  let strangerRefused = false;
  let good = null;
  let bad = null;
  if (hasGuardian) {
    console.log('WARNING: the wallet account has a guardian set. is_valid_signature ' +
      'requires owner+guardian signatures, so the owner-only honesty probe cannot ' +
      'run. SKIPPING the probe (the exported key was verified against get_owner; ' +
      'the handover uses raw ECDSA on the gate, not the wallet\'s is_valid_signature).');
  } else {
    const ownProbeSig = starkSign(DUMMY_HASH, priv);
    const strangerProbeSig = starkSign(DUMMY_HASH, DEPLOYER_PRIV);
    good = await walletIsValidSignature(provider, addr, wallet, DUMMY_HASH,
      ownProbeSig.r, ownProbeSig.s);
    bad = await walletIsValidSignature(provider, addr, wallet, DUMMY_HASH,
      strangerProbeSig.r, strangerProbeSig.s);
    keyIsValid = BigInt(good) === BigInt(VALID_FELT);
    strangerRefused = BigInt(bad) !== BigInt(VALID_FELT);
  }

  // The exported key's job is done. Delete it BEFORE any check can throw us
  // out with the file still on disk.
  unlinkSync(keyfile);

  if (!hasGuardian && (!keyIsValid || !strangerRefused)) {
    throw new Error(`wallet honesty probe failed: own key -> ${good} (expected 'VALID' ` +
      `${VALID_FELT}), stranger key -> ${bad} (expected NOT 'VALID'). The keyfile was deleted.`);
  }

  const prep = {
    createdAt: new Date().toISOString(),
    note: 'Accept-ownership signature for the phase-6 handover, produced LOCALLY '
      + 'from the Ready X (formerly Argent X) exported private key. The private '
      + 'key itself is not in this file, was never sent anywhere, and the keyfile '
      + 'was deleted the moment the signature existed. r/s authorize exactly one '
      + 'act: rotating the gate owner to walletPublicKey (the hash binds gate + '
      + 'current owner).',
    gate: GATE,
    walletAddress: addr,
    walletPublicKey: walletPub,
    walletPublicKeyFromChain: wallet.pub,
    walletOwnerGetter: wallet.getter,
    walletOwnerType: wallet.ownerType,
    walletSignatureFormat: wallet.sigFormat,
    walletHasGuardian: hasGuardian,
    currentOwnerPublicKey: currentOwnerPub,
    acceptOwnershipHash: hex(hash),
    r: hex(sig.r),
    s: hex(sig.s),
    honestyProbe: hasGuardian
      ? {
        skipped: true,
        reason: 'guardian set — is_valid_signature requires owner+guardian signatures; '
          + 'owner-only probe impossible without the guardian key. The exported key '
          + 'was verified against get_owner; the handover uses raw ECDSA on the gate.',
        dummyHash: DUMMY_HASH,
      }
      : {
        dummyHash: DUMMY_HASH,
        ownKeyVerdict: sn.shortString.decodeShortString(good),
        strangerKeyVerdictFelt: bad,
      },
    keyfileDeleted: true,
  };
  saveJson(PREP_PATH, prep);
  console.log('keyfile deleted — the exported key existed only long enough to sign.');
  result({
    step: 'prepare', walletAddress: addr, walletPublicKey: walletPub,
    pubFromChain: wallet.pub, walletOwnerGetter: wallet.getter,
    walletSignatureFormat: wallet.sigFormat, walletHasGuardian: hasGuardian,
    acceptOwnershipHash: hex(hash),
    r: prep.r, s: prep.s,
    probe: hasGuardian
      ? { skipped: true, reason: 'guardian set' }
      : { ownKey: 'VALID', strangerRefused: true },
    keyfileDeleted: true,
  });
}

async function execute(provider) {
  const prep = loadJson(PREP_PATH);
  if (!prep) throw new Error('run --prepare first');
  const rec = loadJson(REC_PATH) ?? {};
  if (rec.executed) {
    throw new Error(`the handover was already executed (tx ${rec.execute.tx}) — ` +
      'refusing to run the pasted key\'s last act twice; run --verify');
  }

  // Nothing may have drifted since --prepare: the gate owner, the wallet key.
  const chainOwner = await chainGateOwnerPub(provider);
  if (norm(chainOwner) !== norm(prep.currentOwnerPublicKey)) {
    throw new Error(`the gate's owner moved since --prepare (${chainOwner} != ` +
      `${prep.currentOwnerPublicKey}) — re-run --prepare with fresh facts`);
  }
  const derived = (await new sn.Signer(OWNER_PRIV).getPubKey()).toLowerCase();
  if (norm(derived) !== norm(prep.currentOwnerPublicKey)) {
    throw new Error(`the pasted key derives to ${derived}, but the gate's owner ` +
      `is ${prep.currentOwnerPublicKey} — the pasted key can no longer sign the handover`);
  }
  if (!(await isDeployed(provider, prep.walletAddress))) {
    throw new Error(`the wallet account ${prep.walletAddress} is not deployed on ` +
      'Sepolia — the controller must be a live account the gate can delegate to');
  }
  const walletNow = await readWalletOwner(provider, prep.walletAddress).catch(() => null);
  if (walletNow && norm(walletNow.pub) !== norm(prep.walletPublicKey)) {
    throw new Error(`the wallet account's owner moved since --prepare (${walletNow.pub} != ` +
      `${prep.walletPublicKey}) — re-run --prepare`);
  }
  if (walletNow && prep.walletOwnerGetter && walletNow.getter !== prep.walletOwnerGetter) {
    throw new Error(`the wallet's owner getter changed since --prepare ` +
      `(${walletNow.getter} != ${prep.walletOwnerGetter}) — re-run --prepare`);
  }

  console.log('The atomic handover invoke (the pasted key signs this, its last act):');
  console.log(`  1. set_public_key(${prep.walletPublicKey}, [r, s])   — the wallet's key becomes the gate's owner`);
  console.log(`  2. set_wallet_controller(${prep.walletAddress})      — the wallet becomes the SNIP-9 controller`);

  const gate = makeAccount(provider, GATE, OWNER_PRIV);
  const calls = [
    {
      contractAddress: GATE, entrypoint: 'set_public_key',
      calldata: [prep.walletPublicKey, '0x2', prep.r, prep.s],
    },
    {
      contractAddress: GATE, entrypoint: 'set_wallet_controller',
      calldata: [prep.walletAddress],
    },
  ];

  // Dry run: the estimate simulates the whole invoke; if either call would
  // revert (bad signature, wrong caller), it fails HERE, before anything lands.
  const nonce = await provider.getNonceForAddress(GATE);
  const est = await gate.estimateInvokeFee(calls, { nonce });
  console.log('estimate (dry run) passed — sending.');
  const tx = await gate.execute(calls, { nonce, resourceBounds: padBounds(est) });
  await waitOk(provider, tx.transaction_hash, 'handover invoke');

  // Read BOTH facts back from the chain — the receipt alone is not the proof.
  const [newOwner] = await call(provider, GATE, 'get_public_key', []);
  const [controller] = await call(provider, GATE, 'get_wallet_controller', []);
  if (norm(newOwner) !== norm(prep.walletPublicKey)) {
    throw new Error(`the chain says the gate's owner is ${newOwner}, expected ${prep.walletPublicKey}`);
  }
  if (norm(controller) !== norm(prep.walletAddress)) {
    throw new Error(`the chain says the controller is ${controller}, expected ${prep.walletAddress}`);
  }

  rec.executed = true;
  rec.execute = {
    date: new Date().toISOString(),
    tx: tx.transaction_hash,
    newOwnerPublicKey: prep.walletPublicKey,
    walletController: prep.walletAddress,
    replacedOwnerPublicKey: prep.currentOwnerPublicKey,
    readBack: { get_public_key: newOwner, get_wallet_controller: controller },
    note: 'One atomic invoke, two calls, signed by the pasted owner key (its last '
      + 'act). The pasted key is recorded as HISTORICAL in state.json — never deleted.',
  };
  saveJson(REC_PATH, rec);
  result({
    step: 'execute', tx: tx.transaction_hash, newOwner: newOwner,
    controller, replacedOwner: prep.currentOwnerPublicKey,
  });
}

async function verify(provider) {
  const prep = loadJson(PREP_PATH);
  const rec = loadJson(REC_PATH);
  if (!prep || !rec?.executed) throw new Error('nothing executed yet — run --prepare then --execute');
  let failures = 0;
  let skips = 0;
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
  const skip = (label, reason) => {
    console.log(`SKIP  ${label} — ${reason}`);
    skips += 1;
  };

  await check("the chain names the WALLET's key as the gate's owner", async () =>
    norm((await call(provider, GATE, 'get_public_key', []))[0]) === norm(prep.walletPublicKey));
  await check('the pasted key is NO LONGER the owner (rotation happened)', async () =>
    norm((await call(provider, GATE, 'get_public_key', []))[0]) !== norm(prep.currentOwnerPublicKey));
  await check('the gate\'s SNIP-9 controller is the wallet account', async () =>
    norm((await call(provider, GATE, 'get_wallet_controller', []))[0]) === norm(prep.walletAddress));
  await check('the wallet account is deployed', async () =>
    (await isDeployed(provider, prep.walletAddress)) !== null);
  const walletForProbe = {
    pub: prep.walletPublicKey,
    sigFormat: prep.walletSignatureFormat ?? 'oz-raw',
  };
  if (prep.walletHasGuardian) {
    skip('the wallet account refuses a stranger signature (delegation is honest)',
      'guardian set — is_valid_signature requires owner+guardian signatures; owner-only probe impossible');
    skip('the accept-ownership signature still validates at the wallet (it was the wallet\'s key)',
      'guardian set — is_valid_signature requires owner+guardian signatures; owner-only probe impossible');
  } else {
    await check('the wallet account refuses a stranger signature (delegation is honest)', async () => {
      const s = starkSign(DUMMY_HASH, DEPLOYER_PRIV);
      const r = await walletIsValidSignature(provider, prep.walletAddress,
        walletForProbe, DUMMY_HASH, s.r, s.s);
      return BigInt(r) !== BigInt(VALID_FELT);
    });
    await check('the accept-ownership signature still validates at the wallet (it was the wallet\'s key)', async () => {
      const r = await walletIsValidSignature(provider, prep.walletAddress,
        walletForProbe, prep.acceptOwnershipHash, prep.r, prep.s);
      return BigInt(r) === BigInt(VALID_FELT);
    });
  }
  await check('NEGATIVE CONTROL: a signature by the OLD pasted key does NOT validate on the gate', async () => {
    const s = starkSign(DUMMY_HASH, OWNER_PRIV);
    const r = await call(provider, GATE, 'is_valid_signature',
      [DUMMY_HASH, '0x2', hex(s.r), hex(s.s)]);
    return BigInt(r[0]) !== BigInt(VALID_FELT);
  });
  await check('gate still advertises SNIP-9 V2 (library probe)', async () => {
    const probeAcct = new sn.Account({
      provider, address: GATE, signer: new sn.Signer(DEPLOYER_PRIV), cairoVersion: '1',
    });
    return (await probeAcct.getSnip9Version()) === sn.OutsideExecutionVersion.V2;
  });
  await check('the gate holds gas for future wallet-signed relays', async () =>
    (await strkBalance(provider, GATE)) > 0n);

  result({ step: 'verify', failures, skips });
  if (failures > 0) process.exit(1);
}

// ---------------------------------------------------------------- main

async function main() {
  const modeIdx = process.argv.findIndex((a) => a.startsWith('--'));
  if (modeIdx < 0) {
    console.error('usage: node handover.mjs --check <walletAddress>' +
      ' | --fund <walletAddress> <strkAmount> | --prepare <walletAddress> <keyfile>' +
      ' | --execute | --verify');
    process.exit(2);
  }
  const mode = process.argv[modeIdx];
  const rest = process.argv.slice(modeIdx + 1).filter((a) => !a.startsWith('--'));
  const provider = new sn.RpcProvider({ nodeUrl: RPC });
  const chainId = await provider.getChainId();
  if (BigInt(chainId) !== BigInt(state.chain_id_hex)) {
    throw new Error(`RPC reports chain ${chainId}, expected ${state.chain_id_hex}`);
  }
  const steps = {
    '--check': () => check(provider, rest[0]),
    '--fund': () => fund(provider, rest[0], rest[1]),
    '--prepare': () => prepare(provider, rest[0], rest[1]),
    '--execute': () => execute(provider),
    '--verify': () => verify(provider),
  };
  if (!steps[mode]) throw new Error(`unknown mode ${mode}`);
  await steps[mode]();
}

main().catch((e) => {
  console.error(String(e?.message ?? e).slice(0, 2000));
  result({ status: 'ERROR', message: String(e?.message ?? e).slice(0, 500) });
  process.exit(1);
});
