// Phase 3: the native wallet connector, tested with a mocked window.starknet.
// The harness browser cannot install extensions, so the wallet here is a mock -
// but an HONEST one: it signs exactly the way starknet.js says a wallet signs
// (getMessageHash with the WALLET'S OWN address, then STARK-curve ECDSA), and
// it exposes its public key only through an on-chain get_public_key call.
//
// Every refusal is a control test in the OBS-08 sense: the refused case is
// otherwise identical to a successful connect-and-sign, so the check under test
// is the only thing standing between the attacker and a recorded approval.
//
// The live Argent X proof belongs to the user's browser (phase 6); these tests
// pin everything that does not need the real extension.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as sn from 'starknet';
import { sign as starkSign, getPublicKey, getStarkKey, Point } from '@scure/starknet';

import {
  createProposalStore, resolutionDigest, verifyOwnerSignature,
} from '../src/proposals.mjs';
import { shortStringEncode } from '../web/typed-data.js';
import { createPastedKeySigner } from '../web/signers.js';
import {
  connectWallet, createWalletSigner, detectWallets, normalizeWalletSignature, toChainFelt,
} from '../web/wallet.js';

const OWNER_PRIV = '0x1';
const STRANGER_PRIV = '0x2';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const STRANGER_PUB = getStarkKey(STRANGER_PRIV);
const OWNER_FULL_PUB = '0x' + Buffer.from(getPublicKey(OWNER_PRIV)).toString('hex');

const CHAIN = 'SN_SEPOLIA';
const CHAIN_FELT = '0x' + shortStringEncode(CHAIN).toString(16);
const MAIN_FELT = '0x' + shortStringEncode('SN_MAIN').toString(16);
const GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const WALLET_ADDR = '0x5f3a9c2e81d47b06';
const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';

const asHex = (v) => '0x' + BigInt(v).toString(16);

// ---------------------------------------------------------------- mock wallet
//
// Behaves like the Wallet Standard object an extension injects:
//   enable() -> account/selectedAddress/chainId/provider
//   account.signMessage(typedData) -> string[] signature over the hash bound
//                                     to the WALLET's own address (oracle maths)
//   provider.callContract(get_public_key) -> what the CHAIN says the key is
//
// `onChainPub` can be set to a lie: the extension signs with `priv` while the
// chain reports something else - used to prove which side each check trusts.

function mockWallet({
  id = 'argentX',
  name = 'Argent X',
  priv = OWNER_PRIV,
  address = WALLET_ADDR,
  chainId = CHAIN_FELT,
  onChainPub = null, // defaults to the true derivation of priv
  declineEnable = false,
  enableFails = false,
  noAddress = false,
  noChainId = false,
  providerThrows = false,
  providerError = 'node said no', // the exact message a throwing provider reports
  emptyProviderKey = false,
  wrappedProviderResult = false,
  sigShape = 'array-hex', // array-hex | array-decimal | object | guardian | garbage
  aliasAlso = false, // also expose as window.starknet_argentX (same object)
  keyGetter = 'get_public_key', // get_public_key (OZ) | get_owner (Ready X)
  ownerType = '0x0', // SignerType; 0 = Starknet (only valid for get_owner)
  executeFails = false, // the wallet's own send rejects
  executeNoHash = false, // the wallet's own send answers with no tx hash
} = {}) {
  const pubOnChain = onChainPub ?? getStarkKey(priv);
  const executed = []; // call lists the wallet's own send was asked to carry

  function fakeSignature(hash) {
    const sig = starkSign(asHex(hash), priv);
    const r = asHex(sig.r);
    const s = asHex(sig.s);
    switch (sigShape) {
      case 'array-hex': return [r, s];
      case 'array-decimal': return [sig.r.toString(10), sig.s.toString(10)];
      case 'object': return { r: sig.r, s: sig.s };
      case 'guardian': return [r, s, '0x1', '0x2']; // concise owner+guardian (4 felts)
      case 'standard-1': return ['0x1', '0x0', pubOnChain, r, s]; // standard, count=1
      case 'standard-2': return ['0x2', '0x0', pubOnChain, r, s, '0x0', '0x999', '0x1', '0x2']; // count=2
      case 'garbage': return 'not-a-signature';
      default: throw new Error(`unknown sigShape ${sigShape}`);
    }
  }

  const account = {
    address: noAddress ? undefined : address,
    // The oracle's own hash, bound to the wallet's address - exactly what
    // starknet.js's Account.signMessage does (dist L12184 -> L10124).
    async signMessage(typedData) {
      const hash = sn.typedData.getMessageHash(typedData, address);
      return fakeSignature(hash);
    },
    // The wallet's OWN send (OBS-31): carries a finished call list as this
    // account's transaction - the path Ready X's simulation can model.
    async execute(calls) {
      executed.push(calls);
      if (executeFails) throw new Error('wallet said no');
      return executeNoHash ? {} : { transaction_hash: '0xfeedbeef' };
    },
    async getChainId() { return noChainId ? undefined : chainId; },
  };

  const provider = {
    async callContract(req) {
      if (providerThrows) throw new Error(providerError);
      if (keyGetter === 'get_owner') {
        if (req.entrypoint === 'get_owner_type') return [ownerType];
        if (req.entrypoint !== 'get_owner') throw new Error(`unexpected entrypoint ${req.entrypoint}`);
        if (emptyProviderKey) return ['0x0'];
        const out = [pubOnChain];
        return wrappedProviderResult ? { result: out } : out;
      }
      if (req.entrypoint !== 'get_public_key') throw new Error(`unexpected entrypoint ${req.entrypoint}`);
      if (emptyProviderKey) return ['0x0'];
      const out = [pubOnChain];
      return wrappedProviderResult ? { result: out } : out;
    },
    async getChainId() { return noChainId ? undefined : chainId; },
  };

  const obj = {
    id,
    name,
    chainId: noChainId ? undefined : chainId,
    selectedAddress: noAddress ? undefined : address,
    async enable() {
      if (declineEnable) { const e = new Error('User rejected the request'); e.code = 1; throw e; }
      if (enableFails) throw new Error('extension crashed');
      return account;
    },
    account,
    provider,
  };
  const win = { starknet: obj };
  if (aliasAlso) win.starknet_argentX = obj;
  return { obj, win, executed };
}

const CONTEXT = { kind: 'resolution', accountAddress: GATE, chainId: CHAIN };
const DIGEST = '0x1234';

async function connectedSigner(overrides = {}) {
  const { win, obj, executed } = mockWallet(overrides);
  const { signer, info } = await connectWallet({
    win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
  });
  return { signer, info, obj, executed };
}

// ---------------------------------------------------------------- detection

test('detectWallets finds the standard slot and the legacy aliases, without duplicates', () => {
  const a = { id: 'argentX', name: 'Argent X' };
  const b = { id: 'braavos', name: 'Braavos' };
  const found = detectWallets({ starknet: a, starknet_braavos: b });
  assert.deepEqual(found.map((f) => f.id), ['argentX', 'braavos']);

  // The same object behind two slots is one wallet.
  assert.equal(detectWallets({ starknet: a, starknet_argentX: a }).length, 1);

  // No wallet at all is an empty list, never a guess.
  assert.deepEqual(detectWallets({}), []);
  assert.deepEqual(detectWallets(undefined), []);
});

test('detectWallets sees the Ready (formerly Argent X) aliases, still without duplicates', () => {
  const ready = { id: 'ready', name: 'Ready X' };
  assert.deepEqual(detectWallets({ starknet_ready: ready }).map((f) => f.id), ['ready']);
  assert.deepEqual(detectWallets({ starknet_readyX: ready }).map((f) => f.id), ['ready']);

  // The rebranded extension may inject one object under old and new slots.
  assert.equal(
    detectWallets({ starknet: ready, starknet_argentX: ready, starknet_ready: ready }).length,
    1,
  );
});

// ---------------------------------------------------------------- connect refusals

test('no wallet in the browser is a loud refusal', async () => {
  await assert.rejects(
    connectWallet({ win: {}, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB }),
    /no Starknet wallet found/,
  );
});

test('a declined connection is a loud refusal, not a silent failure', async () => {
  const { win } = mockWallet({ declineEnable: true });
  await assert.rejects(
    connectWallet({ win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB }),
    /declined the connection/,
  );
});

test('a wallet that exposes no account address is refused', async () => {
  const { win } = mockWallet({ noAddress: true });
  await assert.rejects(
    connectWallet({ win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB }),
    /no account address/,
  );
});

test('a wallet on the wrong network is refused, naming both networks', async () => {
  const { win } = mockWallet({ chainId: MAIN_FELT });
  await assert.rejects(
    connectWallet({ win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB }),
    (e) => {
      assert.match(e.message, /SN_MAIN/);
      assert.match(e.message, /SN_SEPOLIA/);
      assert.match(e.message, /Switch the wallet's network/);
      return true;
    },
  );
});

test('a wallet whose network cannot be read is refused (never assumed)', async () => {
  const { win } = mockWallet({ noChainId: true });
  await assert.rejects(
    connectWallet({ win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB }),
    /cannot read which network/,
  );
});

test('an unreadable on-chain key is a refusal: node errors and empty answers alike', async () => {
  const throwing = mockWallet({ providerThrows: true });
  await assert.rejects(
    connectWallet({
      win: throwing.win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
      readChainKey: async () => { throw new Error('console RPC down'); },
    }),
    (e) => {
      assert.match(e.message, /would not return this wallet's key/);
      // BOTH readers' underlying errors, verbatim - a refusal that cannot
      // say why is a refusal that will be misdiagnosed (OBS-27).
      assert.match(e.message, /node said no/);
      assert.match(e.message, /console RPC down/);
      return true;
    },
  );
  const empty = mockWallet({ emptyProviderKey: true });
  await assert.rejects(
    connectWallet({ win: empty.win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB }),
    /missing or not a felt/,
  );
  const noProvider = mockWallet({});
  delete noProvider.obj.provider;
  delete noProvider.obj.account.callContract; // account cannot query either
  await assert.rejects(
    connectWallet({
      win: noProvider.win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
      readChainKey: async () => { throw new Error('console RPC down'); },
    }),
    (e) => {
      assert.match(e.message, /cannot query the chain through this wallet/);
      assert.match(e.message, /would not return this wallet's key/);
      return true;
    },
  );
});

test('a CSP-blocked provider failure names the console policy in the refusal (OBS-30)', async () => {
  // The live 2026-10-26 shape: the console's connect-src did not allow the
  // wallet's rpc host, so the wallet's IN-PAGE fetches were blocked by this
  // page's own CSP. The browser says "Content Security Policy" in the error
  // text; the refusal must pass that through and point at the allowlist
  // instead of leaving the owner to guess a network fault.
  const { win } = mockWallet({
    providerThrows: true,
    providerError: 'Failed to fetch (blocked by the Content Security Policy directive "connect-src")',
  });
  await assert.rejects(
    connectWallet({
      win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
      readChainKey: async () => { throw new Error('console RPC down'); },
    }),
    (e) => {
      assert.match(e.message, /would not return this wallet's key/);
      assert.match(e.message, /Content Security Policy/);
      assert.match(e.message, /NOTE: those fetches were blocked by THIS CONSOLE's/);
      assert.match(e.message, /connect-src allowlist in web\/server\.mjs/);
      return true;
    },
  );
  // And a plain transport error must NOT claim CSP: a wrong diagnosis is
  // worse than none.
  const plain = mockWallet({ providerThrows: true });
  await assert.rejects(
    connectWallet({
      win: plain.win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
      readChainKey: async () => { throw new Error('console RPC down'); },
    }),
    (e) => {
      assert.match(e.message, /node said no/);
      assert.doesNotMatch(e.message, /NOTE: those fetches were blocked/);
      return true;
    },
  );
});

test('executeCalls sends the wallet\'s own transaction and returns its hash (OBS-31)', async () => {
  const { signer, executed } = await connectedSigner();
  const calls = [{
    contractAddress: '0x2502', entrypoint: 'execute_from_outside_v2', calldata: ['0x1'],
  }];
  const hash = await signer.executeCalls(calls);
  assert.equal(hash, '0xfeedbeef');
  assert.deepEqual(executed, [calls]); // exactly what the console asked, verbatim
});

test('a wallet that cannot send, or answers with no hash, is refused loudly', async () => {
  const failing = await connectedSigner({ executeFails: true });
  await assert.rejects(failing.signer.executeCalls([]), /wallet said no/);

  const noHash = await connectedSigner({ executeNoHash: true });
  await assert.rejects(noHash.signer.executeCalls([]), /no transaction hash/);

  const bare = mockWallet({});
  delete bare.obj.account.execute;
  const { signer } = await connectWallet({
    win: bare.win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
  });
  await assert.rejects(
    signer.executeCalls([]),
    /cannot send a transaction from this page/,
  );
});

test('a wallet whose provider cannot FETCH falls back to the console chain read', async () => {
  // The live 2026-10-26 shape: the injected provider dies at the transport
  // layer ("Failed to fetch" - CORS or an extension-internal proxy) while the
  // chain itself is fine. The console's own server-side read answers instead:
  // still THE CHAIN, and the getter it names decides the signature shape.
  const { win } = mockWallet({ providerThrows: true });
  const asked = [];
  const { info } = await connectWallet({
    win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
    readChainKey: async (addr) => {
      asked.push(addr);
      return { ok: true, key: OWNER_PUB, getter: 'get_owner' };
    },
  });
  assert.deepEqual(asked, [WALLET_ADDR]);
  assert.equal(info.publicKey, OWNER_PUB);
  assert.equal(info.keyGetter, 'get_owner');
  assert.equal(info.keySource, 'console-chain');
  assert.equal(info.signatureFormat, 'argent-signer-v1');
});

test('a wallet with no provider object at all still connects via the console read', async () => {
  const bare = mockWallet({});
  delete bare.obj.provider;
  delete bare.obj.account.callContract;
  const { info } = await connectWallet({
    win: bare.win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
    readChainKey: async () => ({ ok: true, key: OWNER_PUB, getter: 'get_public_key' }),
  });
  assert.equal(info.keySource, 'console-chain');
  assert.equal(info.keyGetter, 'get_public_key');
  assert.equal(info.signatureFormat, 'oz-raw');
});

test('a semantic chain answer does NOT fall back to the console read', async () => {
  // Owner type 1 is the CHAIN's answer, not a transport fault: both readers
  // would report the same thing, so the console is never asked.
  const { win } = mockWallet({ keyGetter: 'get_owner', ownerType: '0x1' });
  await assert.rejects(
    connectWallet({
      win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
      readChainKey: async () => { throw new Error('must not be called'); },
    }),
    /not a Starknet key/,
  );
});

test('the default console read goes to /api/chain/key with the wallet address', async () => {
  const { win } = mockWallet({ providerThrows: true });
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, key: OWNER_PUB, getter: 'get_owner' }),
    };
  };
  try {
    const { info } = await connectWallet({
      win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
    });
    assert.equal(info.keySource, 'console-chain');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith(`/api/chain/key?address=${WALLET_ADDR}`), seen[0]);
});

test('WRONG WALLET: a connected wallet whose on-chain key is not the owner is refused', async () => {
  // Everything else about this connect succeeds - this check is the only door.
  const { win } = mockWallet({ priv: STRANGER_PRIV });
  await assert.rejects(
    connectWallet({ win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB }),
    (e) => {
      assert.match(e.message, /wrong wallet/i);
      assert.match(e.message, /handover/);
      assert.ok(e.message.includes(STRANGER_PUB.slice(0, 12)), 'shows the wallet key');
      assert.ok(e.message.includes(OWNER_PUB.slice(0, 12)), 'shows the owner key');
      return true;
    },
  );
});

test('a Ready X (ArgentAccount v0.4.0) wallet connects by its get_owner key', async () => {
  const { win } = mockWallet({ id: 'ready', name: 'Ready X', keyGetter: 'get_owner' });
  const { info, signer } = await connectWallet({
    win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
  });
  assert.equal(info.publicKey, OWNER_PUB);
  assert.equal(info.keyGetter, 'get_owner');
  assert.equal(info.keySource, 'wallet-provider'); // the wallet's own eyes, no fallback
  assert.equal(info.signatureFormat, 'argent-signer-v1');
  assert.equal(signer.kind, 'argent-x'); // the same wallet after the rebrand
  assert.equal(signer.walletName, 'Ready X');
});

test('WRONG WALLET on a Ready X account: the get_owner key is compared, both keys named', async () => {
  const { win } = mockWallet({ keyGetter: 'get_owner', priv: STRANGER_PRIV });
  await assert.rejects(
    connectWallet({ win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB }),
    (e) => {
      assert.match(e.message, /wrong wallet/i);
      assert.ok(e.message.includes(STRANGER_PUB.slice(0, 12)), 'shows the wallet key');
      assert.ok(e.message.includes(OWNER_PUB.slice(0, 12)), 'shows the owner key');
      return true;
    },
  );
});

test('a Ready X wallet whose owner is not a Starknet key is refused loudly', async () => {
  const { win } = mockWallet({ keyGetter: 'get_owner', ownerType: '0x1' });
  await assert.rejects(
    connectWallet({ win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB }),
    /not a Starknet key/,
  );
});

test('a missing owner key refuses the connect blind, and both callContract result shapes work', async () => {
  const { win } = mockWallet({});
  await assert.rejects(
    connectWallet({ win, expectedChainId: CHAIN, ownerPublicKey: null }),
    /owner key is not loaded/,
  );
  // The {result:[...]} shape some providers return is accepted too.
  const wrapped = mockWallet({ wrappedProviderResult: true });
  const { info } = await connectWallet({
    win: wrapped.win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
  });
  assert.equal(info.publicKey, OWNER_PUB);
});

test('the connect trusts the CHAIN for the wallet key, not the extension', async () => {
  // The extension holds a stranger key but the chain (mocked) reports another
  // value: the refusal quotes the chain-read key, proving which side is trusted.
  const { win } = mockWallet({ priv: STRANGER_PRIV, onChainPub: OWNER_PUB });
  const { signer } = await connectWallet({
    win, expectedChainId: CHAIN, ownerPublicKey: OWNER_PUB,
  });
  assert.equal(signer.publicKey, OWNER_PUB, 'the chain-read key is what the signer reports');
  // But a lying contract does not help the attacker: the ECDSA gate below still
  // refuses, because the signature was made with the stranger key.
  const envelope = await signer.signMandateAction({
    chainId: CHAIN, accountAddress: GATE, kind: 'resolution', digest: DIGEST,
    note: 'Approve anyway.',
  });
  assert.equal(
    verifyOwnerSignature(DIGEST, envelope, OWNER_PUB, CONTEXT), false,
    'a wallet that lies about its key still cannot forge an owner signature',
  );
});

// ---------------------------------------------------------------- the signer contract

test('a connected wallet signer exposes the Signer contract', async () => {
  const { signer, info } = await connectedSigner();
  assert.equal(signer.kind, 'argent-x');
  assert.equal(signer.publicKey, OWNER_PUB);
  assert.equal(signer.address, asHex(WALLET_ADDR));
  assert.equal(info.id, 'argentX');
  for (const m of ['signTypedData', 'signMandateAction', 'authorizeCalls', 'signInvoke', 'checkAgainst']) {
    assert.equal(typeof signer[m], 'function', `${m} must be part of the interface`);
  }
  assert.deepEqual(signer.checkAgainst(OWNER_PUB), { derived: OWNER_PUB, matches: true });
  assert.equal(signer.checkAgainst(STRANGER_PUB).matches, false);
  assert.match(signer.checkAgainst(undefined).error, /owner key on chain is not loaded/);

  // The signer holds no key material at all - the wallet does. A distinctive
  // key, so a substring hit cannot come from a public value by luck.
  const distinctive = '0x' + '1234567890abcdef'.repeat(3) + '12345678';
  const distinctivePub = getStarkKey(distinctive);
  const dw = mockWallet({ priv: distinctive });
  const { signer: dSigner } = await connectWallet({
    win: dw.win, expectedChainId: CHAIN, ownerPublicKey: distinctivePub,
  });
  assert.equal(dSigner.publicKey, distinctivePub);
  const serialised = JSON.stringify(dSigner);
  assert.deepEqual(Object.keys(JSON.parse(serialised)).sort(),
    ['address', 'kind', 'publicKey', 'walletName'],
    'only the public identity may serialise');
  assert.ok(!serialised.toLowerCase().includes(distinctive.slice(2)));
});

test('signInvoke through a wallet is refused loudly (phase 5 uses SNIP-9, not raw hashes)', async () => {
  const { signer } = await connectedSigner();
  assert.throws(() => signer.signInvoke({}, {}), /does not sign raw transactions/);
});

test('signTypedData refuses to hash for another account - a wallet only signs as itself', async () => {
  const { signer } = await connectedSigner();
  const typedData = {
    types: {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      Note: [{ name: 'text', type: 'string' }],
    },
    primaryType: 'Note',
    domain: { name: 'Demi Mandate', version: '1', chainId: CHAIN, revision: '1' },
    message: { text: 'A note.' },
  };
  await assert.rejects(signer.signTypedData(typedData, GATE), /only signs as itself/);
  const { r, s, digest } = await signer.signTypedData(typedData, WALLET_ADDR);
  assert.equal(digest, BigInt(sn.typedData.getMessageHash(typedData, WALLET_ADDR)));
  assert.equal(sn.typedData.verifyMessage(typedData, [r, s], OWNER_FULL_PUB, WALLET_ADDR), true);
});

// ---------------------------------------------------------------- the server scheme

test('a wallet mandate envelope verifies in the SERVER verifier, bound to chain, kind and digest', async () => {
  const { signer } = await connectedSigner();
  const envelope = await signer.signMandateAction({
    chainId: CHAIN, accountAddress: GATE, kind: 'resolution', digest: DIGEST,
    note: 'Raise the per-call cap to 30 for this token.',
  });
  assert.equal(envelope.scheme, 'wallet-snip12-v1');
  assert.equal(envelope.signerAddress, asHex(WALLET_ADDR));
  assert.equal(verifyOwnerSignature(DIGEST, envelope, OWNER_PUB, CONTEXT), true);

  // Each attack changes exactly one thing; each must fail.
  assert.equal(verifyOwnerSignature('0x999', envelope, OWNER_PUB, CONTEXT), false,
    'a different digest must not verify');
  assert.equal(verifyOwnerSignature(DIGEST, envelope, STRANGER_PUB, CONTEXT), false,
    'a different owner key must not verify');
  assert.equal(verifyOwnerSignature(DIGEST, envelope, OWNER_PUB, { ...CONTEXT, kind: 'ladder-change' }), false);
  assert.equal(verifyOwnerSignature(DIGEST, envelope, OWNER_PUB, { ...CONTEXT, chainId: 'SN_MAIN' }), false);
  assert.equal(verifyOwnerSignature(DIGEST, { ...envelope, signerAddress: asHex('0xdead') }, OWNER_PUB, CONTEXT), false,
    'a substituted signer address changes the hash and must not verify');
  const { signerAddress: _drop, ...noSigner } = envelope;
  assert.equal(verifyOwnerSignature(DIGEST, noSigner, OWNER_PUB, CONTEXT), false,
    'a wallet envelope without its signer address must not verify');
  assert.equal(verifyOwnerSignature(DIGEST, { ...envelope, signerAddress: 'not-a-felt' }, OWNER_PUB, CONTEXT), false);
  // No context at all: the server refuses rather than guessing the binding.
  assert.equal(verifyOwnerSignature(DIGEST, envelope, OWNER_PUB, null), false);
});

test('the two typed-data schemes are separated by the address their hash binds', async () => {
  const { signer } = await connectedSigner();
  const pasted = createPastedKeySigner(OWNER_PRIV);
  const args = {
    chainId: CHAIN, accountAddress: GATE, kind: 'resolution', digest: DIGEST,
    note: 'Same decision, two carriers.',
  };

  const walletEnv = await signer.signMandateAction(args);
  const pastedEnv = pasted.signMandateAction(args);

  // Both verify under their own scheme...
  assert.equal(verifyOwnerSignature(DIGEST, walletEnv, OWNER_PUB, CONTEXT), true);
  assert.equal(verifyOwnerSignature(DIGEST, pastedEnv, OWNER_PUB, CONTEXT), true);

  // ...and neither verifies when relabelled as the other, because the SNIP-12
  // hash binds a different address in each scheme.
  const walletAsPasted = { scheme: 'snip12-v1', r: walletEnv.r, s: walletEnv.s, typedData: walletEnv.typedData };
  assert.equal(verifyOwnerSignature(DIGEST, walletAsPasted, OWNER_PUB, CONTEXT), false,
    'a wallet signature must not pass as an in-tab signature');
  const pastedAsWallet = { ...pastedEnv, scheme: 'wallet-snip12-v1', signerAddress: asHex(WALLET_ADDR) };
  assert.equal(verifyOwnerSignature(DIGEST, pastedAsWallet, OWNER_PUB, CONTEXT), false,
    'an in-tab signature must not pass as a wallet signature');
});

test('the wallet envelope is a real SNIP-12 signature in the oracle eyes, and tampering breaks it', async () => {
  const { signer } = await connectedSigner();
  const envelope = await signer.signMandateAction({
    chainId: CHAIN, accountAddress: GATE, kind: 'resolution', digest: DIGEST,
    note: 'Decline this request.',
  });
  assert.equal(
    sn.typedData.verifyMessage(envelope.typedData, [envelope.r, envelope.s], OWNER_FULL_PUB, WALLET_ADDR),
    true,
    'starknet.js itself must verify the wallet signature at the wallet address',
  );
  const tampered = JSON.parse(JSON.stringify(envelope.typedData));
  tampered.message.note = 'Approve everything forever.';
  assert.equal(
    sn.typedData.verifyMessage(tampered, [envelope.r, envelope.s], OWNER_FULL_PUB, WALLET_ADDR),
    false,
  );
});

test('authorizeCalls through the wallet produces the SNIP-9 carrier bound to the wallet address', async () => {
  const { signer } = await connectedSigner();
  const envelope = await signer.authorizeCalls({
    chainId: CHAIN,
    caller: 'ANY_CALLER',
    nonce: '0x7',
    executeAfter: 1_700_000_000,
    executeBefore: 1_700_003_600,
    calls: [{ to: TOKEN, selector: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] }],
  });
  assert.equal(envelope.scheme, 'wallet-snip12-src9');
  assert.equal(envelope.signerAddress, asHex(WALLET_ADDR));
  assert.equal(envelope.typedData.domain.name, 'Account.execute_from_outside');
  assert.equal(
    sn.typedData.verifyMessage(envelope.typedData, [envelope.r, envelope.s], OWNER_FULL_PUB, WALLET_ADDR),
    true,
  );
  const replayed = await signer.authorizeCalls({
    chainId: CHAIN, caller: 'ANY_CALLER', nonce: '0x8',
    executeAfter: 1_700_000_000, executeBefore: 1_700_003_600,
    calls: [{ to: TOKEN, selector: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] }],
  });
  assert.equal(
    sn.typedData.verifyMessage(replayed.typedData, [envelope.r, envelope.s], OWNER_FULL_PUB, WALLET_ADDR),
    false,
    'a different nonce must not reuse the authorization signature',
  );
});

test('a wallet that switched chains after connecting is refused at signing time', async () => {
  const { signer } = await connectedSigner();
  await assert.rejects(
    signer.signMandateAction({
      chainId: 'SN_MAIN', accountAddress: GATE, kind: 'resolution', digest: DIGEST, note: 'x',
    }),
    /refusing to sign across chains/,
  );
});

// ---------------------------------------------------------------- signature shapes

test('signature shapes: hex/decimal/object/concise-guardian/standard all pass; garbage refuses', async () => {
  for (const shape of ['array-hex', 'array-decimal', 'object', 'guardian', 'standard-1', 'standard-2']) {
    const { signer } = await connectedSigner({ sigShape: shape });
    const envelope = await signer.signMandateAction({
      chainId: CHAIN, accountAddress: GATE, kind: 'resolution', digest: DIGEST, note: 'shape check',
    });
    assert.equal(verifyOwnerSignature(DIGEST, envelope, OWNER_PUB, CONTEXT), true,
      `${shape} must verify`);
    assert.ok(Array.isArray(envelope.signature), `${shape} envelope carries the full signature array`);
    assert.ok(envelope.signatureFormat, `${shape} envelope records its format`);
  }

  const garbage = await connectedSigner({ sigShape: 'garbage' });
  await assert.rejects(
    garbage.signer.signMandateAction({
      chainId: CHAIN, accountAddress: GATE, kind: 'resolution', digest: DIGEST, note: 'x',
    }),
    /cannot read/,
  );

  // Out-of-curve values are refused by the normaliser itself.
  assert.throws(() => normalizeWalletSignature(['0x0', '0x1']), /outside the curve order/);
  const { n } = Point.CURVE();
  assert.throws(() => normalizeWalletSignature(['0x' + n.toString(16), '0x1']), /outside the curve order/);
  assert.throws(() => normalizeWalletSignature(['0x1']), /at least 2 values/);
  assert.throws(() => normalizeWalletSignature([]), /empty signature array/);
  assert.throws(() => normalizeWalletSignature(null), /cannot read/);
  // Standard array with a mismatched count is refused, not guessed.
  assert.throws(() => normalizeWalletSignature(['0x1', '0x0', '0x1', '0x2', '0x3', '0x4']), /expected 5/);
  // Non-Starknet first signer type is refused.
  assert.throws(() => normalizeWalletSignature(['0x1', '0x1', '0x1', '0x2', '0x3']), /not Starknet/);
});

// ---------------------------------------------------------------- store level

const tempStore = () => join(mkdtempSync(join(tmpdir(), 'opencode', 'wallet-test-')), 'proposals.json');

test('the proposal store records a wallet-signed resolution, and refuses it without context', async () => {
  const decision = { verdict: 'DENY', code: 'over-per-call-cap', reason: 'amount 35 > cap 30', gate: 'spending' };
  const resolution = { type: 'decline' };

  const store = createProposalStore({
    filePath: tempStore(),
    getOwnerPublicKey: async () => OWNER_PUB,
    getSignatureContext: async () => CONTEXT,
  });
  const proposal = store.create({ amount: '35' }, decision);
  const digest = resolutionDigest(proposal, resolution);
  const { signer } = await connectedSigner();
  const envelope = await signer.signMandateAction({
    chainId: CHAIN, accountAddress: GATE, kind: 'resolution', digest,
    note: 'Decline this request. The block stands; nothing goes on-chain.',
  });
  const resolved = await store.resolve(proposal.id, resolution, envelope);
  assert.equal(resolved.status, 'DECLINED');
  assert.equal(resolved.signature.scheme, 'wallet-snip12-v1');
  assert.equal(resolved.signature.signerAddress, asHex(WALLET_ADDR));
  assert.equal(resolved.ownerPublicKeyAtResolution, OWNER_PUB);

  // A wallet envelope relabelled as the in-tab scheme is refused by the store.
  const store2 = createProposalStore({
    filePath: tempStore(),
    getOwnerPublicKey: async () => OWNER_PUB,
    getSignatureContext: async () => CONTEXT,
  });
  const p2 = store2.create({ amount: '36' }, decision);
  const d2 = resolutionDigest(p2, resolution);
  const env2 = await signer.signMandateAction({
    chainId: CHAIN, accountAddress: GATE, kind: 'resolution', digest: d2, note: 'Relabelled.',
  });
  await assert.rejects(
    store2.resolve(p2.id, resolution, { scheme: 'snip12-v1', r: env2.r, s: env2.s, typedData: env2.typedData }),
    /does not verify against the OWNER key/,
  );

  // A server without signature context cannot verify typed data and says so.
  const store3 = createProposalStore({
    filePath: tempStore(),
    getOwnerPublicKey: async () => OWNER_PUB,
  });
  const p3 = store3.create({ amount: '37' }, decision);
  const d3 = resolutionDigest(p3, resolution);
  const env3 = await signer.signMandateAction({
    chainId: CHAIN, accountAddress: GATE, kind: 'resolution', digest: d3, note: 'No context.',
  });
  await assert.rejects(store3.resolve(p3.id, resolution, env3), /cannot verify typed-data signatures/);
});

// ---------------------------------------------------------------- helpers

test('toChainFelt accepts labels, hex felts and decimal felts alike', () => {
  assert.equal(toChainFelt(CHAIN), toChainFelt(CHAIN_FELT));
  assert.equal(toChainFelt(CHAIN_FELT), BigInt(CHAIN_FELT));
  assert.equal(toChainFelt(BigInt(CHAIN_FELT).toString(10)), BigInt(CHAIN_FELT));
  assert.throws(() => toChainFelt(''), /chain id is required/);
});

test('createWalletSigner can be built directly from verified facts (used by later phases)', () => {
  const fake = { account: { async signMessage() { return ['0x1', '0x2']; } } };
  const signer = createWalletSigner(fake, {
    id: 'braavos', name: 'Braavos', address: WALLET_ADDR, chainId: CHAIN_FELT, publicKey: OWNER_PUB,
  });
  assert.equal(signer.kind, 'braavos');
  assert.equal(signer.publicKey, OWNER_PUB);
});
