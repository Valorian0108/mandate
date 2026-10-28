// The signer interface, tested as the only door between a decision and a
// signature. Every screen now holds a Signer, never a private key; this file
// proves the pasted-key implementation behaves exactly like the pieces it
// replaced, and that its checks refuse rather than pass.
//
// The oracle is starknet.js 10.8.0, as everywhere else: if a signature this
// module produces does not verify in the library over the library's own hash,
// a real wallet will not be able to produce a compatible one either.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as sn from 'starknet';
import { getPublicKey, getStarkKey } from '@scure/starknet';

import { verifyOwnerSignature } from '../src/proposals.mjs';
import { buildInvokeTx } from '../web/tx-signer.js';
import {
  createPastedKeySigner, isValidPrivateKey, signerForInput,
} from '../web/signers.js';

const PRIV = '0x1';
const OTHER_PRIV = '0x2';
const PUB = getStarkKey(PRIV);
const OTHER_PUB = getStarkKey(OTHER_PRIV);
const FULL_PUB = '0x' + Buffer.from(getPublicKey(PRIV)).toString('hex');
const GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';
const CHAIN = 'SN_SEPOLIA';

const asHex = (value) => '0x' + BigInt(value).toString(16);

// ---------------------------------------------------------------- the contract

test('a pasted-key signer exposes the interface and derives the chain key', () => {
  const signer = createPastedKeySigner(PRIV);
  assert.equal(signer.kind, 'pasted-key');
  assert.equal(signer.publicKey, PUB);
  assert.equal(signer.publicKey, getStarkKey(PRIV), 'derivation must be the library derivation');
  for (const method of ['signTypedData', 'signMandateAction', 'authorizeCalls', 'signInvoke', 'checkAgainst']) {
    assert.equal(typeof signer[method], 'function', `${method} must be part of the interface`);
  }
});

test('the signer keeps no readable copy of the private key', () => {
  // A distinctive key, so a substring hit cannot come from the public key by luck.
  const distinctive = '0x' + '1234567890abcdef'.repeat(3) + '12345678';
  const signer = createPastedKeySigner(distinctive);
  const serialised = JSON.stringify(signer);
  assert.deepEqual(Object.keys(JSON.parse(serialised)).sort(), ['kind', 'publicKey'],
    'only the public identity may serialise');
  assert.ok(!serialised.toLowerCase().includes(distinctive.slice(2)));
  assert.ok(!Object.values(signer).some((v) => v === distinctive));
});

test('invalid keys are refused at construction, never silently accepted', () => {
  for (const bad of ['', '0x0', '0x', 'junk', '0x' + 'f'.repeat(64), null, undefined]) {
    assert.equal(isValidPrivateKey(bad), false, `'${bad}' must not be a valid key`);
    assert.throws(() => createPastedKeySigner(bad), /not a valid Starknet private key/);
  }
  const ui = signerForInput('0x0', PUB);
  assert.equal(ui.signer, null);
  assert.match(ui.check.error, /not a valid Starknet private key/);
  assert.deepEqual(signerForInput('', PUB), { signer: null, check: null });
});

test('checkAgainst compares to the CHAIN owner, and a missing owner is a refusal', () => {
  const signer = createPastedKeySigner(PRIV);
  assert.deepEqual(signer.checkAgainst(PUB), { derived: PUB, matches: true });
  assert.equal(signer.checkAgainst(OTHER_PUB).matches, false);
  assert.equal(signer.checkAgainst(undefined).matches, false);
  assert.match(signer.checkAgainst(null).error, /owner key on chain is not loaded/);
  assert.equal(signer.checkAgainst('not-a-felt').matches, false);
});

// ---------------------------------------------------------------- mandate actions

test('a mandate envelope verifies in the server verifier, bound to chain and account', () => {
  const signer = createPastedKeySigner(PRIV);
  const digest = '0x1234';
  const envelope = signer.signMandateAction({
    chainId: CHAIN,
    accountAddress: GATE,
    kind: 'resolution',
    digest,
    note: 'Raise the per-call cap to 30 for this token.',
  });
  const context = { kind: 'resolution', accountAddress: GATE, chainId: CHAIN };

  assert.equal(envelope.scheme, 'snip12-v1');
  assert.equal(verifyOwnerSignature(digest, envelope, PUB, context), true);

  const attacks = [
    { ...context, chainId: 'SN_MAIN' },
    { ...context, accountAddress: '0x1234' },
    { ...context, kind: 'ladder-change' },
  ];
  for (const wrong of attacks) {
    assert.equal(verifyOwnerSignature(digest, envelope, PUB, wrong), false,
      `a carrier for ${JSON.stringify(wrong)} must not verify`);
  }
  assert.equal(verifyOwnerSignature('0x999', envelope, PUB, context), false,
    'the envelope binds the digest');
  assert.equal(verifyOwnerSignature(digest, envelope, OTHER_PUB, context), false,
    'another key must not pass');
});

test('signTypedData hashes and signs exactly like starknet.js', () => {
  const signer = createPastedKeySigner(PRIV);
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
    message: { text: 'A note the owner can read.' },
  };
  const { r, s, digest } = signer.signTypedData(typedData, GATE);
  assert.equal(digest, BigInt(sn.typedData.getMessageHash(typedData, GATE)));
  assert.equal(sn.typedData.verifyMessage(typedData, [r, s], FULL_PUB, GATE), true);
});

// ---------------------------------------------------------------- SRC-9 (phase 5 carrier)

test('authorizeCalls produces the SRC-9 message starknet.js and OpenZeppelin expect', () => {
  const signer = createPastedKeySigner(PRIV);
  const args = {
    chainId: CHAIN,
    accountAddress: GATE,
    caller: 'ANY_CALLER',
    nonce: '0x7',
    executeAfter: 1_700_000_000,
    executeBefore: 1_700_003_600,
    calls: [{ to: TOKEN, selector: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] }],
  };
  const envelope = signer.authorizeCalls(args);

  assert.equal(envelope.scheme, 'snip12-src9');
  assert.equal(envelope.typedData.domain.name, 'Account.execute_from_outside');
  assert.equal(envelope.typedData.domain.version, '2');
  assert.match(
    sn.typedData.encodeType(envelope.typedData.types, 'OutsideExecution', '1'),
    /"Execute After":"u128"/,
  );
  assert.equal(
    sn.typedData.verifyMessage(envelope.typedData, [envelope.r, envelope.s], FULL_PUB, GATE),
    true,
    'the library must verify the SRC-9 signature',
  );

  // Every field that changes what runs must change the authorization.
  const tampered = signer.authorizeCalls({ ...args, nonce: '0x8' });
  assert.equal(
    sn.typedData.verifyMessage(tampered.typedData, [envelope.r, envelope.s], FULL_PUB, GATE),
    false,
  );
  const substituted = signer.authorizeCalls({
    ...args,
    calls: [{ to: TOKEN, selector: 'transfer', calldata: [MERCHANT, '0x6', '0x0'] }],
  });
  assert.equal(
    sn.typedData.verifyMessage(substituted.typedData, [envelope.r, envelope.s], FULL_PUB, GATE),
    false,
    'a substituted call must not reuse the owner signature',
  );
});

// ---------------------------------------------------------------- final transaction

test('signInvoke signs the invoke-v3 hash this tab built, and only that hash', () => {
  const signer = createPastedKeySigner(PRIV);
  const built = buildInvokeTx({
    sender: GATE,
    calls: [{ to: TOKEN, entrypoint: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] }],
    nonce: '0xe',
    resourceBounds: {
      l1_gas: { max_amount: 0x100n, max_price_per_unit: 0x10n },
      l2_gas: { max_amount: 0x200n, max_price_per_unit: 0x20n },
      l1_data_gas: { max_amount: 0x300n, max_price_per_unit: 0x30n },
    },
    chainId: '0x534e5f5345504f4c4941',
  });
  const { signature, body } = signer.signInvoke(built, built.body);

  assert.deepEqual(body.signature, [signature.r, signature.s]);
  assert.equal(verifyOwnerSignature(built.hash, signature, PUB), true);
  assert.equal(verifyOwnerSignature('0x1234', signature, PUB), false);
  assert.equal(verifyOwnerSignature(built.hash, signature, OTHER_PUB), false);
});
