// The JSON-RPC wire seam in mandate-reader's call(), pinned after it bit live
// (2026-10-26): callers hand felts in mixed shapes - state.json records hex
// strings, web/tx-signer.js's selectorFromName returns BigInt - and
// JSON.stringify THROWS on BigInt ("Do not know how to serialize a BigInt").
// The server's get_owner fallback (the ONLY key path on a real Ready X
// controller) died on exactly that, so the browser's chain-key read was refused
// for a reason that had nothing to do with the chain. The unit tests missed it
// because their fake call functions never serialize. These tests mirror the
// real wire: the body must be JSON, every felt must arrive as a hex string,
// and anything that is not a felt must fail LOUDLY - never silently become
// null on the wire (JSON.stringify's other trap for arrays).

import test from 'node:test';
import assert from 'node:assert/strict';

import { call } from '../src/mandate-reader.mjs';
import { selectorFromName } from '../web/tx-signer.js';

// The real Ready X controller from the live pass - mixed-case on purpose: the
// wire canonicalises it, and Sepolia answered for exactly this account.
const W = '0x0022239D0077a2783757f87269b1FC0157DD603895C65e5d6A07Ac5dA4b1fCFb';

// Stub globalThis.fetch, capture the request body, answer like a JSON-RPC node.
function stubFetch(capture) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capture.url = url;
    capture.body = opts.body;
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result: ['0xabc'] }) };
  };
  return () => { globalThis.fetch = real; };
}

test('call() puts a BigInt selector and BigInt calldata on the wire as hex', async () => {
  const capture = {};
  const restore = stubFetch(capture);
  let out;
  try {
    // selectorFromName returns a BigInt (scure keccak) - the exact shape the
    // server's resolveControllerPublicKey fallback hands chainCall.
    out = await call(W, selectorFromName('get_owner'), [9n]);
  } finally {
    restore();
  }
  assert.deepEqual(out, ['0xabc']);
  const req = JSON.parse(capture.body).params.request;
  assert.equal(typeof req.entry_point_selector, 'string');
  assert.equal(req.entry_point_selector, '0x' + selectorFromName('get_owner').toString(16));
  assert.deepEqual(req.calldata, ['0x9']);
});

test('call() canonicalises mixed-case addresses, hex strings and decimal strings', async () => {
  const capture = {};
  const restore = stubFetch(capture);
  try {
    await call(W, '0x1234abcd', ['25', '0x0ABC']);
  } finally {
    restore();
  }
  const req = JSON.parse(capture.body).params.request;
  // Felts are NUMBERS on the wire: minimal lowercase hex, leading zeros gone.
  assert.equal(req.contract_address, '0x' + BigInt(W).toString(16));
  assert.equal(req.entry_point_selector, '0x1234abcd');
  assert.deepEqual(req.calldata, ['0x19', '0xabc']);
});

test('call() refuses a calldata element that is not a felt, loudly', async () => {
  const capture = {};
  const restore = stubFetch(capture);
  try {
    // undefined in an array is JSON.stringify's silent-null trap; BigInt()
    // throws instead, which is the honest failure.
    await assert.rejects(
      call(W, '0x1234abcd', [undefined]),
      /Cannot convert/,
    );
  } finally {
    restore();
  }
});
