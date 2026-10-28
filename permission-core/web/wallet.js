// Track 2, phase 3: the native wallet as a Signer.
//
// Browser extensions inject `window.starknet` (Wallet Standard) and, for the two
// wallets we target, the legacy aliases `window.starknet_argentX` and
// `window.starknet_braavos`. This module detects them, connects, and turns the
// connected wallet into the same Signer contract the pasted key implements
// (see web/signers.js) - so no screen knows or cares which one it holds.
//
// THE BINDING FACT this module is built around (read from starknet.js 10.8.0
// dist/index.mjs, L12184 + L10124, recorded in track2-wallet-research.md):
// a wallet's `signMessage` hashes the typed data with the WALLET'S OWN address
// and a dapp cannot override that. So:
//
//   - every envelope this signer produces carries `signerAddress` (the wallet's
//     address) and the scheme `wallet-snip12-v1`; the server re-hashes with that
//     address and verifies raw ECDSA against the OWNER key read from the chain.
//     The address is not trusted as an identity claim - it only selects the
//     hash; the chain-read key is the only gate.
//   - `signInvoke` is refused loudly: a native wallet will not sign a raw
//     transaction for another account. Wallet-driven final transactions go
//     through SNIP-9 authorizations (phase 5), not direct invoke signatures.
//
// Connect-time refusals (all plain words, all tested with a mocked window):
//   no wallet found / declined connection / no account address / chain unknown
//   or wrong / the wallet's on-chain key unreadable / the wallet is not the
//   owner of the GateAccount (the phase-3 headline: wrong-wallet refusal).
//
// The wallet's public key is read FROM THE CHAIN — get_public_key on OZ-style
// accounts, get_owner + get_owner_type on Ready X (formerly Argent X)
// ArgentAccount v0.4.0 — never taken from the extension's word for itself.
//
// Node-free: the browser loads this directly and the tests import it in node
// with an injected fake `window`.

import { Point } from '@scure/starknet';

import {
  getMessageHash,
  mandateActionTypedData,
  outsideExecutionTypedData,
  shortStringDecode,
  shortStringEncode,
} from './typed-data.js';

const norm = (value) => '0x' + BigInt(value).toString(16);

export function short(value, head = 10, tail = 6) {
  const h = norm(value);
  return h.length > head + tail + 2 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h;
}

// Chain ids arrive either as a label ('SN_SEPOLIA') or as the felt the chain
// itself reports ('0x534e5f5345504f4c4941'). Both become the same BigInt.
export function toChainFelt(value) {
  if (value === undefined || value === null || value === '') {
    throw new Error('a chain id is required to check the wallet against');
  }
  if (typeof value === 'bigint') return value;
  const v = String(value).trim();
  if (/^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  if (/^[0-9]+$/.test(v)) return BigInt(v);
  return shortStringEncode(v); // labels like SN_SEPOLIA
}

function chainLabel(felt) {
  try {
    const decoded = shortStringDecode(felt);
    return decoded && /^[\x20-\x7e]+$/.test(decoded) ? decoded : norm(felt);
  } catch {
    return norm(felt);
  }
}

// ---------------------------------------------------------------- detection

// Wallet Standard: `window.starknet`. Legacy per-wallet aliases are checked too,
// and the same object is never listed twice. Ready aliases: Argent X REBRANDED
// to Ready (Ready X) in late 2025 — same extension, same account contracts,
// same signing behavior (fact-checked 2026-10-26 with sources in
// track2-wallet-research.md, "The rebrand"). Detection is standard-first, so a
// rebrand cannot break it: any id, known or not, is listed. The Ready aliases
// are insurance in case the extension renames its legacy injection surface;
// what it actually injects gets OBSERVED in the user's browser at the phase-6
// connect step, not assumed here.
export function detectWallets(win = globalThis) {
  const found = [];
  const push = (obj, fallbackId) => {
    if (!obj || typeof obj !== 'object') return;
    if (found.some((f) => f.obj === obj)) return;
    const id = typeof obj.id === 'string' && obj.id ? obj.id : fallbackId;
    const name = typeof obj.name === 'string' && obj.name ? obj.name : id;
    found.push({ id, name, obj });
  };
  push(win?.starknet, 'starknet');
  push(win?.starknet_argentX, 'argentX');
  push(win?.starknet_ready, 'ready');
  push(win?.starknet_readyX, 'readyX');
  push(win?.starknet_braavos, 'braavos');
  return found;
}

// ---------------------------------------------------------------- signatures

function feltToHex(value, label) {
  let v;
  if (typeof value === 'bigint') v = value;
  else if (typeof value === 'number') v = BigInt(value);
  else if (typeof value === 'string') {
    const t = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(t)) v = BigInt(t);
    else if (/^[0-9]+$/.test(t)) v = BigInt(t);
    else throw new Error(`the wallet's signature ${label} is not a number: '${value}'`);
  } else {
    throw new Error(`the wallet's signature ${label} is not a number`);
  }
  const { n } = Point.CURVE();
  if (v <= 0n || v >= n) {
    throw new Error(`the wallet's signature ${label} is outside the curve order`);
  }
  return '0x' + v.toString(16);
}

// Same parsing, WITHOUT the curve-order check — for the non-signature felts in
// a standard Argent array (count, signer type, pubkey), which are field
// elements but not necessarily < curve order.
function feltToHexLoose(value, label) {
  let v;
  if (typeof value === 'bigint') v = value;
  else if (typeof value === 'number') v = BigInt(value);
  else if (typeof value === 'string') {
    const t = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(t)) v = BigInt(t);
    else if (/^[0-9]+$/.test(t)) v = BigInt(t);
    else throw new Error(`the wallet's signature ${label} is not a number: '${value}'`);
  } else {
    throw new Error(`the wallet's signature ${label} is not a number`);
  }
  if (v < 0n) {
    throw new Error(`the wallet's signature ${label} is negative`);
  }
  return '0x' + v.toString(16);
}

// Wallet Standard signatures are string[]; starknet.js signers return {r,s}
// with BigInts. ArgentAccount v0.4.0 (Ready X) adds two more shapes, resolved
// from the account-0.4.0 source (parse_signature_array + docs/argent_account.md):
//   * CONCISE: 2 felts [owner_r, owner_s] (no guardian) or
//     4 felts [owner_r, owner_s, guardian_r, guardian_s].
//   * STANDARD: Array<SignerSignature> = [count, (type, pubkey, r, s) × count].
// The owner signature always goes first. We extract the owner's (r, s) for
// pre-verification, keep the FULL array for the wire (the gate calls the
// controller's is_valid_signature with exactly what the wallet produced), and
// record the shape so the server can refuse a mismatch instead of guessing.
export function normalizeWalletSignature(sig) {
  if (sig && typeof sig === 'object' && !Array.isArray(sig)
    && sig.r !== undefined && sig.s !== undefined) {
    const r = feltToHex(sig.r, 'r');
    const s = feltToHex(sig.s, 's');
    return { r, s, signature: [r, s], format: 'object' };
  }
  if (!Array.isArray(sig)) {
    throw new Error('the wallet returned a signature in a shape this console cannot read');
  }
  const arr = sig.map((v, i) => feltToHexLoose(v, `signature[${i}]`));
  if (arr.length === 0) {
    throw new Error('the wallet returned an empty signature array');
  }
  // Concise formats (ArgentAccount v0.4.0 parse_signature_array: len==2 or len==4)
  if (arr.length === 2) {
    return { r: feltToHex(arr[0], 'r'), s: feltToHex(arr[1], 's'), signature: arr, format: 'concise-owner' };
  }
  if (arr.length === 4) {
    return { r: feltToHex(arr[0], 'r'), s: feltToHex(arr[1], 's'), signature: arr, format: 'concise-owner-guardian' };
  }
  // Standard format: [count, (type, pubkey, r, s) × count]
  if (arr.length >= 5) {
    let count;
    try { count = Number(BigInt(arr[0])); } catch { count = NaN; }
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`the standard signature array's count felt (${arr[0]}) is not a positive integer`);
    }
    if (arr.length !== 1 + count * 4) {
      throw new Error(`the standard signature array says count=${count} but carries ` +
        `${arr.length} felts (expected ${1 + count * 4}) - refusing to guess the layout`);
    }
    const ownerType = BigInt(arr[1]);
    if (ownerType !== 0n) {
      throw new Error(`the first signer in the array is type ${arr[1]}, not Starknet (0) - ` +
        'the gate can only pre-verify a Starknet owner signature');
    }
    return { r: feltToHex(arr[3], 'r'), s: feltToHex(arr[4], 's'), signature: arr, format: 'standard' };
  }
  throw new Error(`a signature needs at least 2 values; the wallet returned ${arr.length}`);
}

// ---------------------------------------------------------------- the signer

// Display/classifier kinds. Ready ids map to 'argent-x' because it IS the same
// wallet after the late-2025 rebrand — keeping one kind means records and the
// pasted-key/wallet behavior split (the only place kind is load-bearing) stay
// stable across the rebrand. What the UI SHOWS is `walletName` — the wallet's
// own declared name ("Ready X"), never this classifier.
const KINDS = {
  argentX: 'argent-x', ready: 'argent-x', readyX: 'argent-x',
  braavos: 'braavos', starknet: 'wallet',
};

// info: { id, name, address, chainId (felt hex), publicKey (x-only, chain-read) }
export function createWalletSigner(wallet, info) {
  const address = norm(info.address);
  const chainFelt = toChainFelt(info.chainId);

  function assertStillOnChain(chainId) {
    if (chainId !== undefined && chainId !== null) {
      const expected = toChainFelt(chainId);
      if (expected !== chainFelt) {
        throw new Error(`the wallet was on ${chainLabel(chainFelt)} when it connected, but this ` +
          `action is for ${chainLabel(expected)} - refusing to sign across chains`);
      }
    }
    return chainFelt;
  }

  async function walletSign(typedData) {
    const account = wallet?.account ?? wallet;
    if (!account || typeof account.signMessage !== 'function') {
      throw new Error('this wallet cannot sign typed-data messages (no signMessage)');
    }
    const raw = await account.signMessage(typedData);
    return normalizeWalletSignature(raw);
  }

  return Object.freeze({
    kind: KINDS[info.id] ?? `wallet:${info.id}`,
    walletName: info.name,
    address,
    publicKey: norm(info.publicKey),

    // The wallet hashes with its OWN address; asking it to hash for another
    // account is exactly the mistake the binding finding rules out, so it is
    // refused here instead of silently producing a mismatched digest.
    async signTypedData(typedData, accountAddress) {
      if (accountAddress !== undefined && accountAddress !== null
        && BigInt(accountAddress) !== BigInt(address)) {
        throw new Error('a native wallet only signs as itself - refusing to hash ' +
          'this message for a different account');
      }
      const { r, s } = await walletSign(typedData);
      return { r, s, digest: getMessageHash(typedData, address) };
    },

    // The envelope a record stores. Same MandateAction carrier as the pasted
    // key, but bound to the wallet's address and labelled accordingly. The
    // GateAccount address passed by the screen is the subject of the action
    // (inside the digest); the hash binds the signer, which is the wallet.
    async signMandateAction({ chainId, kind, digest, note }) {
      assertStillOnChain(chainId);
      const typedData = mandateActionTypedData({ chainId, kind, digest, note });
      const { r, s, signature, format } = await walletSign(typedData);
      return {
        scheme: 'wallet-snip12-v1', r, s, signature, signatureFormat: format,
        typedData, signerAddress: address,
      };
    },

    // SNIP-9 authorization for final transactions. Signed here; consumed by the
    // chain in phases 4-5 (controller-bound execute_from_outside_v2).
    async authorizeCalls({ chainId, caller = 'ANY_CALLER', nonce, executeAfter, executeBefore, calls }) {
      assertStillOnChain(chainId);
      const typedData = outsideExecutionTypedData({
        chainId, caller, nonce, executeAfter, executeBefore, calls,
      });
      const { r, s, signature, format } = await walletSign(typedData);
      return {
        scheme: 'wallet-snip12-src9', r, s, signature, signatureFormat: format,
        typedData, signerAddress: address,
      };
    },

    // The wallet carries a finished call list to the chain AS ITSELF (OBS-31).
    // Ready X's signing simulation replays the authorized CALLS from the
    // wallet, so a controller-bound self-call (set_spending_policy) can never
    // pass that model - it answers 'Account: unauthorized' to every caller but
    // the gate. Sending execute_from_outside_v2 as the wallet's OWN transaction
    // makes simulation and reality agree: the gate checks the SNIP-9 signature
    // (the wallet's key), the window and the nonce, then runs the self-call as
    // itself. The wallet pays its own gas; this page still never sees a key.
    async executeCalls(calls) {
      const account = wallet?.account ?? wallet;
      if (!account || typeof account.execute !== 'function') {
        throw new Error('this wallet cannot send a transaction from this page (no ' +
          'execute on the wallet account) - refusing to pretend it did');
      }
      const out = await account.execute(calls);
      const hash = typeof out === 'string' ? out : out?.transaction_hash;
      if (!hash || !/^0x[0-9a-fA-F]+$/.test(String(hash))) {
        throw new Error('the wallet answered the send with no transaction hash - ' +
          `refusing to guess (got ${String(JSON.stringify(out)).slice(0, 120)})`);
      }
      return String(hash);
    },

    // Loud refusal, not a stub: see the header. Phase 5 replaces the final-tx
    // path with SNIP-9 authorizations; a wallet will never sign our invoke.
    signInvoke() {
      throw new Error('a native wallet does not sign raw transactions for another account. ' +
        'Wallet-driven final transactions go through SNIP-9 authorizations (phase 5); ' +
        'until then the final-transaction screen needs the owner key in the tab.');
    },

    // Does the chain say this wallet's key IS the owner key? A missing chain
    // key is a refusal, never a pass - same rule as the pasted key.
    checkAgainst(ownerPublicKey) {
      if (ownerPublicKey === undefined || ownerPublicKey === null || ownerPublicKey === '') {
        return {
          derived: norm(info.publicKey), matches: false,
          error: 'the owner key on chain is not loaded',
        };
      }
      try {
        return { derived: norm(info.publicKey), matches: norm(info.publicKey) === norm(ownerPublicKey) };
      } catch {
        return { derived: norm(info.publicKey), matches: false, error: 'the owner key on chain is not a felt' };
      }
    },
  });
}

// ---------------------------------------------------------------- connect

// The whole phase-3 gate in one function. Every refusal throws with plain
// words; success returns { signer, info }.
export async function connectWallet({
  win = globalThis,
  expectedChainId,
  ownerPublicKey,
  walletId = null,
  readChainKey = null,
}) {
  // The console's own chain read (server-side, CORS-free): reader 2 for the
  // wallet's on-chain key. Defaults to this console's endpoint; tests inject
  // a stub. Returns { ok, key, getter } or throws with the server's reason.
  const readChainKeyFn = readChainKey ?? (async (addr) => {
    const res = await fetch(`/api/chain/key?address=${encodeURIComponent(addr)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  });
  const wallets = detectWallets(win);
  if (wallets.length === 0) {
    throw new Error('no Starknet wallet found in this browser. Install Ready ' +
      '(formerly Argent X) or Braavos, then reload this page.');
  }
  const chosen = walletId
    ? wallets.find((w) => w.id.toLowerCase() === String(walletId).toLowerCase())
    : wallets[0];
  if (!chosen) {
    throw new Error(`no wallet '${walletId}' here - found: ${wallets.map((w) => w.id).join(', ')}`);
  }
  const obj = chosen.obj;

  if (typeof obj.enable !== 'function') {
    throw new Error(`${chosen.name} is not a Wallet Standard object (no enable()) - cannot connect`);
  }
  try {
    await obj.enable();
  } catch (e) {
    throw new Error(`${chosen.name} declined the connection (or failed to open): ` +
      String(e?.message ?? e));
  }

  const address = obj.account?.address ?? obj.selectedAddress;
  if (!address) {
    throw new Error(`${chosen.name} connected but exposed no account address - refusing`);
  }

  // Which network is the wallet on? Any of the standard places; none = refusal.
  const expectedFelt = toChainFelt(expectedChainId);
  let walletChain = obj.chainId ?? null;
  try {
    if (walletChain === null || walletChain === undefined) {
      walletChain = (await obj.account?.getChainId?.())
        ?? (await obj.getChainId?.())
        ?? (await obj.provider?.getChainId?.())
        ?? null;
    }
  } catch {
    walletChain = null;
  }
  if (walletChain === null || walletChain === undefined) {
    throw new Error('cannot read which network the wallet is on - refusing to sign blind');
  }
  const walletChainFelt = toChainFelt(walletChain);
  if (walletChainFelt !== expectedFelt) {
    throw new Error(`the wallet is on ${chainLabel(walletChainFelt)}, but this mandate lives on ` +
      `${chainLabel(expectedFelt)}. Switch the wallet's network, then connect again.`);
  }

  // The wallet's key, read FROM THE CHAIN - not the extension's word for
  // itself. TWO independent readers, in order:
  //   1. the wallet's own provider (the wallet's eyes on the chain), then
  //   2. the console's server-side chain read (/api/chain/key), CORS-free.
  // Reader 1 can fail at the TRANSPORT layer from this page's origin -
  // "Failed to fetch", i.e. CORS or an extension-internal proxy, observed
  // live 2026-10-26 on Ready X while the wallet's own UI read the chain
  // fine. A transport failure is not a chain answer, so it falls through to
  // reader 2. SEMANTIC refusals (owner type not a felt, owner type not a
  // Starknet key) do NOT fall through: they are the chain's answer, and both
  // readers would report the same one. Either way the key comes from the
  // chain and every signature is verified against it - the extension's word
  // is never trusted for the key itself.
  const providerReport = [];
  const transport = (message) => {
    const err = new Error(message);
    err.transport = true;
    return err;
  };
  const readViaWallet = async () => {
    const provider = obj.provider ?? obj.account;
    if (!provider || typeof provider.callContract !== 'function') {
      providerReport.push('cannot query the chain through this wallet ' +
        '(no callContract on the wallet object)');
      throw transport('no chain reader on the wallet object');
    }
    // Read one felt from the wallet's own account contract.
    const readChainFelt = async (entrypoint) => {
      const result = await provider.callContract({
        contractAddress: address, entrypoint, calldata: [],
      });
      const arr = Array.isArray(result) ? result : result?.result;
      return arr?.[0];
    };
    try {
      const pub = await readChainFelt('get_public_key');
      return { pubRaw: pub, keyGetter: 'get_public_key' };
    } catch (firstErr) {
      providerReport.push(`get_public_key: ${String(firstErr?.message ?? firstErr)}`);
      // Ready X (formerly Argent X) accounts — ArgentAccount v0.4.0, observed
      // live 2026-10-26 (OBS-24) — expose get_owner + get_owner_type instead.
      // Signer type 0 is Starknet; anything else cannot own our GateAccount.
      let ownerType;
      try {
        ownerType = await readChainFelt('get_owner_type');
      } catch (secondErr) {
        providerReport.push(`get_owner_type: ${String(secondErr?.message ?? secondErr)}`);
        throw transport('neither get_public_key nor get_owner_type answered');
      }
      let ownerTypeFelt;
      try {
        ownerTypeFelt = BigInt(ownerType);
      } catch {
        throw new Error(`the wallet's on-chain owner type is not a felt ` +
          `(got ${String(ownerType)}) - refusing`);
      }
      if (ownerTypeFelt !== 0n) {
        throw new Error(`this wallet's owner is not a Starknet key (signer type ` +
          `${String(ownerType)}) - it cannot own this GateAccount; refusing`);
      }
      try {
        const pub = await readChainFelt('get_owner');
        return { pubRaw: pub, keyGetter: 'get_owner' };
      } catch (e) {
        providerReport.push(`get_owner: ${String(e?.message ?? e)}`);
        throw transport('get_owner did not answer');
      }
    }
  };
  let pubRaw;
  let keyGetter;
  let keySource = 'wallet-provider';
  try {
    ({ pubRaw, keyGetter } = await readViaWallet());
  } catch (walletErr) {
    if (!walletErr.transport) throw walletErr; // the chain's answer, not a transport fault
    let out;
    try {
      out = await readChainKeyFn(address);
    } catch (consoleErr) {
      // If the wallet's fetches were blocked by THIS CONSOLE's content-security
      // policy (the wallet's in-page code fetches its own rpc from our origin -
      // OBS-30), say so plainly instead of leaving a generic network error.
      const cspBlocked = providerReport.some((line) => /Content Security Policy/i.test(line));
      throw new Error(`the chain would not return this wallet's key (neither ` +
        `get_public_key nor get_owner on ${short(address)}) - refusing. ` +
        `What the wallet's provider reported: ${providerReport.join(' | ')}. ` +
        `What the console's own chain read reported: ` +
        `${String(consoleErr?.message ?? consoleErr)}. Two independent readers of ` +
        `the same chain both failing means neither could reach it - check the ` +
        `wallet's network and that this console server can read Sepolia.` +
        (cspBlocked ? ` NOTE: those fetches were blocked by THIS CONSOLE's ` +
          `content-security policy - the wallet's rpc host may need adding to ` +
          `the connect-src allowlist in web/server.mjs.` : ''));
    }
    pubRaw = out.key;
    keyGetter = out.getter;
    keySource = 'console-chain';
  }
  let publicKey;
  try {
    if (pubRaw === undefined || pubRaw === null || pubRaw === '' || pubRaw === '0x0') {
      throw new Error('empty');
    }
    publicKey = norm(pubRaw);
  } catch {
    throw new Error(`the wallet's on-chain key is missing or not a felt (got ${String(pubRaw)}) - refusing`);
  }

  // The headline refusal: this wallet must BE the owner of the GateAccount.
  if (ownerPublicKey === undefined || ownerPublicKey === null || ownerPublicKey === '') {
    throw new Error('the GateAccount owner key is not loaded - refusing to connect blind');
  }
  let matches = false;
  try {
    matches = publicKey === norm(ownerPublicKey);
  } catch {
    throw new Error('the GateAccount owner key on chain is not a felt - refusing');
  }
  if (!matches) {
    throw new Error(`wrong wallet: ${chosen.name} (${short(address)}) holds the key ` +
      `${short(publicKey, 12, 8)}, but the owner of this GateAccount is ${short(ownerPublicKey, 12, 8)}. ` +
      'Nothing can be signed until the ownership handover points the account at this wallet ' +
      '(or you connect the wallet that already owns it).');
  }

  const info = {
    id: chosen.id,
    name: chosen.name,
    address: norm(address),
    chainId: norm(walletChainFelt),
    publicKey,
    keyGetter,
    // Which reader supplied the chain key: the wallet's own provider, or the
    // console's server-side read after a transport-level provider failure.
    // Recorded, never hidden - the owner can see whose eyes read the chain.
    keySource,
    signatureFormat: keyGetter === 'get_owner' ? 'argent-signer-v1' : 'oz-raw',
  };
  return { signer: createWalletSigner(obj, info), info };
}
