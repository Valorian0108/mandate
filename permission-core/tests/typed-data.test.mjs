// The anti-drift test for the typed-data carrier. web/typed-data.js re-implements
// SNIP-12 revision 1 so the browser and the server hash identically; starknet.js
// 10.8.0 is the oracle, exactly as it was for the invoke-v3 transaction hash.
//
// The oracle chain, strongest first:
//   1. Type strings and type hashes must equal the library's, character for
//      character - including the quoted names and the spaced SRC-9 field names.
//   2. Struct hashes and whole message hashes must equal the library's.
//   3. The library must be able to VERIFY a signature we produced, and we must be
//      able to verify one the library produced, over the same message.
//   4. Every tamper (amount, note, calls, expiry, signer account) must change the
//      hash and break the signature. A carrier that ignores a field is worse than
//      no carrier at all.
//
// The live chain remains the final oracle for SRC-9 (phase 4); this file makes a
// silent divergence from the standard impossible to miss before that.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as sn from 'starknet';
import { getPublicKey, getStarkKey, sign as starkSign } from '@scure/starknet';

import { verifyOwnerSignature } from '../src/proposals.mjs';

import {
  encodeType,
  getMessageHash,
  getStructHash,
  getTypeHash,
  mandateActionTypedData,
  outsideExecutionTypedData,
  shortStringDecode,
  shortStringEncode,
  signTypedData,
} from '../web/typed-data.js';

const OWNER_PRIV = '0x1';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const OWNER_FULL_PUB = '0x' + Buffer.from(getPublicKey(OWNER_PRIV)).toString('hex');
const GATE = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const OTHER_GATE = '0x1234';
const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';

// Pulled from the library, not typed from memory.
const CHAIN_FELT = sn.constants.StarknetChainId.SN_SEPOLIA;
const CHAIN_ID = sn.shortString.decodeShortString(CHAIN_FELT);
assert.equal(CHAIN_ID, 'SN_SEPOLIA', 'the library chain id must decode to SN_SEPOLIA');

const ORACLE_HASH = (typedData, account = GATE) =>
  BigInt(sn.typedData.getMessageHash(typedData, account));
const asHex = (value) => '0x' + BigInt(value).toString(16);

const NOTE = 'Approve 15 STRK to the merchant, once.';

function mandate(overrides = {}) {
  return mandateActionTypedData({
    chainId: CHAIN_ID,
    kind: 'resolution',
    digest: '0x1234',
    note: NOTE,
    ...overrides,
  });
}

function outside(overrides = {}) {
  return outsideExecutionTypedData({
    chainId: CHAIN_ID,
    caller: GATE,
    nonce: '0x7',
    executeAfter: 1_700_000_000,
    executeBefore: 1_700_003_600,
    calls: [{ to: TOKEN, selector: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] }],
    ...overrides,
  });
}

// ---------------------------------------------------------------- type strings

test('type strings and type hashes match starknet.js exactly', () => {
  for (const [typedData, primary] of [
    [mandate(), 'MandateAction'],
    [outside(), 'OutsideExecution'],
    [outside(), 'Call'],
  ]) {
    assert.equal(
      encodeType(typedData.types, primary),
      sn.typedData.encodeType(typedData.types, primary, '1'),
      `the encoded type string for ${primary} drifted`,
    );
    assert.equal(
      getTypeHash(typedData.types, primary),
      BigInt(sn.typedData.getTypeHash(typedData.types, primary, '1')),
      `the type hash for ${primary} drifted`,
    );
  }
});

test('SRC-9 type strings keep OpenZeppelin spaced field names', () => {
  const encoded = encodeType(outside().types, 'OutsideExecution');
  assert.match(encoded, /"Execute After":"u128"/);
  assert.match(encoded, /"Execute Before":"u128"/);
  assert.match(encoded, /"Calls":"Call\*"/);
  assert.match(encodeType(outside().types, 'Call'), /"To":"ContractAddress","Selector":"selector","Calldata":"felt\*"/);
});

// ---------------------------------------------------------------- struct hashes

test('struct hashes match starknet.js for every struct in both carriers', () => {
  for (const [typedData, type, data] of [
    [mandate(), 'StarknetDomain', mandate().domain],
    [mandate(), 'MandateAction', mandate().message],
    [outside(), 'StarknetDomain', outside().domain],
    [outside(), 'OutsideExecution', outside().message],
    [outside(), 'Call', outside().message.Calls[0]],
  ]) {
    assert.equal(
      getStructHash(typedData.types, type, data),
      BigInt(sn.typedData.getStructHash(typedData.types, type, data, '1')),
      `the struct hash for ${type} drifted`,
    );
  }
});

// ---------------------------------------------------------------- message hashes

test('mandate message hash matches starknet.js for short and multi-chunk notes', () => {
  const notes = [
    'x',
    'a'.repeat(31),
    'a'.repeat(32),
    'a'.repeat(62),
    'a'.repeat(63),
    NOTE,
    'The owner is asked to amend the per-call cap to 30 STRK for the merchant, once, in a window that ends tomorrow at noon.',
  ];
  for (const note of notes) {
    const typedData = mandate({ note });
    assert.equal(getMessageHash(typedData, GATE), ORACLE_HASH(typedData), `note length ${note.length} drifted`);
  }
});

test('outside-execution message hash matches starknet.js (caller, selector names, arrays)', () => {
  const variants = [
    outside(),
    outside({ caller: 'ANY_CALLER' }),
    outside({ nonce: 0 }),
    outside({ executeAfter: 0, executeBefore: 2 ** 32 }),
    outside({
      calls: [
        { to: TOKEN, selector: 'transfer', calldata: [] },
        { to: GATE, selector: '0x1234', calldata: ['0x1', '0x2', '0x3'] },
      ],
    }),
  ];
  for (const typedData of variants) {
    assert.equal(getMessageHash(typedData, GATE), ORACLE_HASH(typedData));
  }
});

test('the canonical SNIP-9 vector is pinned to the Cairo mirror (snforge t35)', () => {
  // The exact vector of gate-account/tools/snip9-vector.mjs and snforge test t35
  // (gate-account/tests/lib.cairo): ANY_CALLER, nonce 7, window 1_700_000_000 ->
  // 1_700_003_600, one transfer of 5 to the merchant, signer = the GATE fixture.
  // The pinning chain: starknet.js pins this file (oracle assert below), this
  // literal pins the Cairo mirror (t35), and every SNIP-9 happy path pins the
  // contract to the mirror. Nothing here may drift silently.
  const typedData = outside({ caller: 'ANY_CALLER' });
  const EXPECTED = 0x5f4becd3a2815731f6f378ac9dab8a193bb80a2a4b4b992ddf3703bba66718cn;
  assert.equal(getMessageHash(typedData, GATE), EXPECTED, 'SNIP-9 vector drifted from Cairo t35');
  assert.equal(getMessageHash(typedData, GATE), ORACLE_HASH(typedData), 'SNIP-9 vector drifted from starknet.js');
});

test('the u256 preset type hashes like the library', () => {
  const typedData = {
    types: {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      Payment: [{ name: 'amount', type: 'u256' }],
    },
    primaryType: 'Payment',
    domain: { name: 'Demi Mandate', version: '1', chainId: CHAIN_ID, revision: '1' },
    message: { amount: { low: '0x1', high: '0x0' } },
  };
  assert.equal(encodeType(typedData.types, 'Payment'), sn.typedData.encodeType(typedData.types, 'Payment', '1'));
  assert.equal(getMessageHash(typedData, GATE), ORACLE_HASH(typedData));
});

// ---------------------------------------------------------------- signatures

test('a signature we produce verifies in the library and in our own verifier', () => {
  const typedData = mandate();
  const { r, s, digest } = signTypedData(typedData, GATE, OWNER_PRIV);
  assert.equal(digest, ORACLE_HASH(typedData), 'our digest must be the library digest');
  assert.equal(
    sn.typedData.verifyMessage(typedData, [r, s], OWNER_FULL_PUB, GATE),
    true,
    'the library must verify our signature',
  );
  assert.equal(verifyOwnerSignature(asHex(digest), { r, s }, OWNER_PUB), true);
});

test('a signature the library produces verifies against our hash', () => {
  const typedData = outside();
  // Sign the oracle's own digest with the same curve primitive the library uses.
  const oracleDigest = ORACLE_HASH(typedData);
  const raw = starkSign('0x' + oracleDigest.toString(16), OWNER_PRIV);
  const sig = { r: '0x' + raw.r.toString(16), s: '0x' + raw.s.toString(16) };
  assert.equal(sn.typedData.verifyMessage(typedData, [sig.r, sig.s], OWNER_FULL_PUB, GATE), true);
  assert.equal(verifyOwnerSignature(asHex(oracleDigest), sig, OWNER_PUB), true);
  // Our own hash must be the number that signature was made over.
  assert.equal(getMessageHash(typedData, GATE), oracleDigest);
});

// ---------------------------------------------------------------- controls

test('every field is bound: a tamper changes the hash and breaks the signature', () => {
  const base = mandate();
  const { r, s } = signTypedData(base, GATE, OWNER_PRIV);
  const tampered = [
    mandate({ digest: '0x1235' }),
    mandate({ kind: 'ladder-change' }),
    mandate({ note: NOTE + ' (not really)' }),
  ];
  for (const typedData of tampered) {
    assert.notEqual(getMessageHash(typedData, GATE), getMessageHash(base, GATE));
    assert.equal(sn.typedData.verifyMessage(typedData, [r, s], OWNER_FULL_PUB, GATE), false);
  }
});

test('the signer account is bound: a signature for one account is not valid for another', () => {
  const typedData = mandate();
  const { r, s } = signTypedData(typedData, GATE, OWNER_PRIV);
  assert.equal(sn.typedData.verifyMessage(typedData, [r, s], OWNER_FULL_PUB, GATE), true);
  assert.equal(sn.typedData.verifyMessage(typedData, [r, s], OWNER_FULL_PUB, OTHER_GATE), false);
});

test('a tampered SRC-9 call is not the same authorization', () => {
  const base = outside();
  const { r, s } = signTypedData(base, GATE, OWNER_PRIV);
  const changes = [
    outside({ executeBefore: 1_700_003_601 }),
    outside({ nonce: '0x8' }),
    outside({ caller: 'ANY_CALLER' }),
    outside({ calls: [{ to: MERCHANT, selector: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] }] }),
    outside({ calls: [{ to: TOKEN, selector: 'transfer', calldata: [MERCHANT, '0x6', '0x0'] }] }),
  ];
  for (const typedData of changes) {
    assert.notEqual(getMessageHash(typedData, GATE), getMessageHash(base, GATE));
    assert.equal(sn.typedData.verifyMessage(typedData, [r, s], OWNER_FULL_PUB, GATE), false);
  }
});

// ---------------------------------------------------------------- loud refusals

test('legacy revision is refused, not silently hashed with the wrong maths', () => {
  const legacy = mandate();
  legacy.types.StarkNetDomain = legacy.types.StarknetDomain;
  delete legacy.types.StarknetDomain;
  legacy.domain.revision = '0';
  assert.throws(() => getMessageHash(legacy, GATE), /revision 1|StarknetDomain/);
});

test('an unsupported field type is refused loudly', () => {
  const typedData = mandate();
  typedData.types.MandateAction = [{ name: 'digest', type: 'u64' }];
  typedData.message = { digest: '0x1' };
  assert.throws(() => getMessageHash(typedData, GATE), /unsupported type 'u64'/);
});

test('a missing field is refused, never hashed as zero', () => {
  const typedData = mandate();
  delete typedData.message.note;
  assert.throws(() => getMessageHash(typedData, GATE), /missing data for 'note'/);
});

test('short strings round-trip and refuse non-ASCII', () => {
  for (const value of ['SN_SEPOLIA', 'Demi Mandate', 'a', 'x'.repeat(31)]) {
    assert.equal(shortStringDecode(shortStringEncode(value)), value);
  }
  assert.throws(() => shortStringEncode('café'), /not ASCII/);
  assert.throws(() => shortStringEncode('x'.repeat(32)), /1-31 bytes/);
});

// ---------------------------------------------------------------- note carrier
// The browser proof of the wallet path (2026-10-26) caught a display-only
// character crossing into the signature carrier: resolution notes built with the
// UI's shortened addresses contain '…', which the ASCII string encoder rightly
// refuses - the whole wallet signing path was dead on arrival. The fold below
// lives in mandateActionTypedData, the single entry point every signer goes
// through; these controls pin the fold AND the refusal that must survive it.

test('typographic notes are folded to carriable ASCII and stay fully bound', () => {
  const pretty = 'Approve once: 40 to 0x079e\u2026cf38 \u2014 the \u201cmerchant\u201d account.';
  const plain = 'Approve once: 40 to 0x079e...cf38 -- the "merchant" account.';
  const folded = mandate({ note: pretty });
  assert.equal(folded.message.note, plain, 'the carried note must be the ASCII look-alike');
  // The fold equals the hand-written ASCII equivalent - identical hash, and the
  // library agrees (the oracle chain covers folded notes too).
  assert.equal(getMessageHash(folded, GATE), getMessageHash(mandate({ note: plain }), GATE));
  assert.equal(getMessageHash(folded, GATE), ORACLE_HASH(folded), 'folded notes must hash like the library');
  // The signature round-trip works on the folded carrier.
  const { r, s, digest } = signTypedData(folded, GATE, OWNER_PRIV);
  assert.equal(sn.typedData.verifyMessage(folded, [r, s], OWNER_FULL_PUB, GATE), true);
  assert.equal(verifyOwnerSignature(asHex(digest), { r, s }, OWNER_PUB), true);
  // Pure-ASCII notes pass through untouched (the fold is the identity).
  assert.equal(mandate({ note: NOTE }).message.note, NOTE);
});

test('a note with no ASCII look-alike is still refused loudly at hash time', () => {
  // The fold is for look-alikes only: it must NOT launder characters that change
  // meaning (accents) or carry no ASCII equivalent at all (emoji). Build passes
  // (nothing is encoded yet); the encoder refuses, as it always did.
  assert.throws(() => getMessageHash(mandate({ note: 'Approve once: 40 \u{1F680}' }), GATE), /not ASCII/);
  assert.throws(() => getMessageHash(mandate({ note: 'Approve once: café' }), GATE), /not ASCII/);
  assert.equal(mandate({ note: 'caf\u00e9' }).message.note, 'café', 'the fold must not alter non-look-alikes');
});
