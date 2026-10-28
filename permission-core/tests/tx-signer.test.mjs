// The anti-drift test for the browser's transaction signer. web/tx-signer.js
// re-implements the invoke-v3 hash so the tab can sign the FINAL transaction, not
// just the decision. If it ever disagrees with starknet.js - the library the rest
// of the ecosystem and ultimately the chain agree with - every browser-signed
// transaction would be rejected, so this file makes that disagreement impossible
// to miss.
//
// The oracle chain, strongest first:
//   1. starknet.js builds a fully signed transaction OFFLINE (nonce and resource
//      bounds supplied, so no network) and we compare its compiled calldata and
//      its whole RPC body against ours, field for field.
//   2. The signature the library produced over ITS hash must verify against OUR
//      hash - which is only possible if the two hashes are the same number.
//   3. Where the library exports the raw hash function and the spec constants, we
//      compare those directly too.
// The live chain remains the final oracle; that proof lives in SCREENS.md.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as sn from 'starknet';
import { getStarkKey } from '@scure/starknet';

import { verifyOwnerSignature } from '../src/proposals.mjs';
import {
  buildInvokeTx, compileCalls, EDAMODE_L1, invokeV3Hash, selectorFromName,
  signInvokeTx, VERSION_V3,
} from '../web/tx-signer.js';

const OWNER_PRIV = '0x1';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const REGISTRY = '0x03484789c7e0212a8ea8a398cb5b92ab9bacb01155db929e117efece9ec7e88c';
const CHAIN_ID = '0x534e5f5345504f4c4941'; // SN_SEPOLIA as a felt

// The chain id comes from the library, not from memory: if starknet.js and this
// file ever disagree about Sepolia, the suite fails here.
const LIB_CHAIN = sn.constants?.StarknetChainId?.SN_SEPOLIA;
assert.ok(LIB_CHAIN, 'starknet.js must export the Sepolia chain id or this pin is blind');
assert.equal(BigInt(LIB_CHAIN), BigInt(CHAIN_ID), 'our Sepolia felt must be the library one');

const BOUNDS = {
  l1_gas: { max_amount: 0x1234n, max_price_per_unit: 0x5678n },
  l2_gas: { max_amount: 0x9abcn, max_price_per_unit: 0xdef0n },
  l1_data_gas: { max_amount: 0x2468n, max_price_per_unit: 0x1357n },
};
const NONCE = '0x7';

const transfer = { to: TOKEN, entrypoint: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] };
const anchor = { to: REGISTRY, entrypoint: 'anchor', calldata: [GATE, '0x2597', '0x4'] };
const policy = {
  to: GATE, entrypoint: 'set_spending_policy',
  calldata: [TOKEN, '0x1a', '0x64', '0x259200', '0x1', '0xa'],
};

function account() {
  // The URL is never contacted: chainId, nonce and resourceBounds are supplied, so
  // the library neither reads the chain nor estimates. If that ever changes, these
  // tests fail instead of silently touching the network.
  const provider = new sn.RpcProvider({ nodeUrl: 'http://127.0.0.1:1', chainId: LIB_CHAIN });
  return new sn.Account({ provider, address: GATE, signer: new sn.Signer(OWNER_PRIV), cairoVersion: '1' });
}

async function librarySigned(calls) {
  // The library's Call type names the target `contractAddress`; our calls (the
  // shape resolutions.mjs and the console use) name it `to`. Same transaction.
  const libCalls = calls.map((c) => ({
    contractAddress: c.to, entrypoint: c.entrypoint, calldata: c.calldata,
  }));
  return account().getSignedTransaction(libCalls, {
    nonce: NONCE, resourceBounds: BOUNDS, tip: 0,
  });
}

const asBigInts = (arr) => arr.map((v) => BigInt(v));

// ---------------------------------------------------------------- calldata + body

test('the compiled calldata is byte for byte what the library sends', async () => {
  for (const calls of [[transfer], [transfer, anchor], [policy, transfer, anchor]]) {
    const signed = await librarySigned(calls);
    assert.deepEqual(asBigInts(signed.calldata), compileCalls(calls),
      `compiled calldata drift for ${calls.length} call(s)`);
  }
  // And the selector is the library's selector, not our guess at it.
  assert.equal(BigInt(selectorFromName('transfer')), BigInt(sn.hash.getSelectorFromName('transfer')));
  assert.equal(BigInt(selectorFromName('set_spending_policy')),
    BigInt(sn.hash.getSelectorFromName('set_spending_policy')));
});

test('the RPC body is the library body, field for field', async () => {
  const signed = await librarySigned([transfer, anchor]);
  const { body } = buildInvokeTx({
    sender: GATE, calls: [transfer, anchor], nonce: NONCE, resourceBounds: BOUNDS, chainId: CHAIN_ID,
  });

  assert.equal(body.type, signed.type);
  assert.equal(BigInt(body.sender_address), BigInt(signed.sender_address));
  assert.deepEqual(asBigInts(body.calldata), asBigInts(signed.calldata));
  assert.equal(BigInt(body.nonce), BigInt(signed.nonce));
  assert.equal(BigInt(body.version), BigInt(signed.version));
  assert.equal(BigInt(body.tip), BigInt(signed.tip));
  for (const gas of ['l1_gas', 'l2_gas', 'l1_data_gas']) {
    assert.equal(BigInt(body.resource_bounds[gas].max_amount),
      BigInt(signed.resource_bounds[gas].max_amount), gas);
    assert.equal(BigInt(body.resource_bounds[gas].max_price_per_unit),
      BigInt(signed.resource_bounds[gas].max_price_per_unit), gas);
  }
  assert.deepEqual(asBigInts(body.paymaster_data), asBigInts(signed.paymaster_data));
  assert.deepEqual(asBigInts(body.account_deployment_data), asBigInts(signed.account_deployment_data));
  assert.equal(body.nonce_data_availability_mode, signed.nonce_data_availability_mode);
  assert.equal(body.fee_data_availability_mode, signed.fee_data_availability_mode);
  assert.deepEqual(Object.keys(body.signature), [], 'the body leaves signing to the signer');
});

// ---------------------------------------------------------------- the hash

test('the hash the library signed is the hash we compute', async () => {
  for (const calls of [[transfer], [transfer, anchor], [policy]]) {
    const signed = await librarySigned(calls);
    const { hash } = buildInvokeTx({
      sender: GATE, calls, nonce: NONCE, resourceBounds: BOUNDS, chainId: CHAIN_ID,
    });

    // The library's signature was made over the library's hash. It verifying
    // against OUR hash - with the same verifier the relay server uses - is only
    // possible if the two are the same number.
    const libSig = { r: signed.signature[0], s: signed.signature[1] };
    assert.equal(verifyOwnerSignature(hash, libSig, OWNER_PUB), true,
      'the library signature must verify against our transaction hash');
    assert.equal(verifyOwnerSignature(`0x${(BigInt(hash) + 1n).toString(16)}`, libSig, OWNER_PUB), false,
      'and must not verify against a neighbouring hash');

    // Where the library exports the raw function, compare it directly too.
    if (typeof sn.hash.calculateInvokeTransactionHash === 'function') {
      const direct = sn.hash.calculateInvokeTransactionHash({
        senderAddress: GATE,
        version: signed.version,
        compiledCalldata: signed.calldata,
        chainId: LIB_CHAIN,
        nonce: NONCE,
        accountDeploymentData: signed.account_deployment_data,
        nonceDataAvailabilityMode: sn.EDAMode.L1,
        feeDataAvailabilityMode: sn.EDAMode.L1,
        resourceBounds: BOUNDS,
        tip: 0,
        paymasterData: signed.paymaster_data,
      });
      assert.equal(BigInt(direct), BigInt(hash), 'raw hash function disagrees');
    }
  }
});

test('the spec constants are the library exports, not our memory', () => {
  assert.ok(sn.EDAMode, 'starknet.js must export EDAMode or this pin is blind');
  assert.ok(sn.ETransactionVersion, 'starknet.js must export ETransactionVersion');
  assert.equal(EDAMODE_L1, BigInt(sn.EDAMode.L1));
  assert.equal(VERSION_V3, BigInt(sn.ETransactionVersion.V3));
});

test('every field of the envelope is covered by the hash', () => {
  const calls = [transfer];
  const base = {
    sender: GATE, chainId: CHAIN_ID, nonce: NONCE, tip: 0, resourceBounds: BOUNDS,
    compiledCalldata: compileCalls(calls),
  };
  const baseHash = invokeV3Hash(base);

  const tampered = [
    { ...base, nonce: '0x8' },
    { ...base, chainId: '0x534e5f4d41494e' },
    { ...base, sender: MERCHANT },
    { ...base, tip: 1 },
    { ...base, resourceBounds: { ...BOUNDS, l2_gas: { ...BOUNDS.l2_gas, max_amount: BOUNDS.l2_gas.max_amount + 1n } } },
    { ...base, compiledCalldata: compileCalls([anchor]) },
    { ...base, compiledCalldata: [...compileCalls(calls), 1n] },
    { ...base, paymasterData: [1n] },
    { ...base, accountDeploymentData: [1n] },
    { ...base, nonceDa: 1n },
    { ...base, feeDa: 1n },
  ];
  for (const t of tampered) {
    assert.notEqual(invokeV3Hash(t), baseHash, 'a changed envelope field must change the hash');
  }
  assert.match(baseHash, /^0x[0-9a-f]{1,64}$/, 'the hash is a felt in hex');
});

// ---------------------------------------------------------------- signing

test('a browser signature over the transaction hash verifies like any owner signature', async () => {
  const { hash, body } = buildInvokeTx({
    sender: GATE, calls: [transfer], nonce: NONCE, resourceBounds: BOUNDS, chainId: CHAIN_ID,
  });
  const { signature, body: signedBody } = signInvokeTx({ hash }, body, OWNER_PRIV);
  // The same verifier the relay server runs against the chain-read owner key.
  assert.equal(verifyOwnerSignature(hash, signature, OWNER_PUB), true);
  assert.deepEqual(signedBody.signature, [signature.r, signature.s]);

  // A signature for one transaction is not a signature for another.
  const other = buildInvokeTx({
    sender: GATE, calls: [anchor], nonce: NONCE, resourceBounds: BOUNDS, chainId: CHAIN_ID,
  });
  assert.equal(verifyOwnerSignature(other.hash, signature, OWNER_PUB), false);
});

test('the signer refuses to build nonsense instead of signing it', () => {
  assert.throws(() => compileCalls([]), /at least one call/);
  assert.throws(() => compileCalls([{ to: GATE, entrypoint: 'x' }]), /calldata/);
  assert.throws(() => invokeV3Hash({ sender: GATE, chainId: CHAIN_ID, nonce: NONCE, resourceBounds: { l1_gas: BOUNDS.l1_gas } }), /l1_data_gas/);
});
