// The browser half of the FINAL transaction. Until this module existed, the
// browser signed the decision (a digest) and the server's harness key signed and
// sent the Starknet transaction. Now the tab signs the transaction itself and the
// server only carries the finished bytes to the chain.
//
// Everything here is the invoke-v3 transaction hash as starknet.js 10.8.0 computes
// it, read out of that library's source (dist/index.mjs, transactionHash/v3):
//
//   feeField  = poseidonMany([tip, enc(l1_gas), enc(l2_gas), enc(l1_data_gas)])
//   enc(name) = (shortString(name) << 192) + (max_amount << 128) + max_price_per_unit
//   daHash    = (nonceDA << 32) + feeDA
//   txHash    = poseidonMany([ 'invoke', version, sender, feeField,
//                              poseidonMany(paymaster), chainId, nonce, daHash,
//                              poseidonMany(accountDeployment),
//                              poseidonMany(compiledCalldata) ])
//
// None of these numbers is trusted from memory: tests/tx-signer.test.mjs builds the
// same transaction with starknet.js itself and fails loudly on any difference -
// including the compiled calldata, the RPC body field names, and the signature the
// library produced over its own hash.
//
// This module must stay free of `node:` imports: the served-import-graph test walks
// it. Only @scure/starknet and @noble/hashes, both already on the page.

import { getStarkKey, keccak, poseidonHashMany, sign } from '@scure/starknet';
import { utf8ToBytes } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------- constants

const PREFIX_INVOKE = 0x696e766f6b65n; // encodeShortString('invoke')
export const VERSION_V3 = 0x3n;
const MAX_AMOUNT_BITS = 64n;
const MAX_PRICE_BITS = 128n;
const RESOURCE_OFFSET = MAX_AMOUNT_BITS + MAX_PRICE_BITS; // 192
const DA_MODE_BITS = 32n;
export const EDAMODE_L1 = 0n; // EDataAvailabilityMode.L1

function shortString(value) {
  const bytes = utf8ToBytes(value);
  if (bytes.length === 0 || bytes.length > 31) {
    throw new Error(`short string must be 1-31 bytes, got '${value}'`);
  }
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

const GAS_L1 = shortString('L1_GAS');
const GAS_L2 = shortString('L2_GAS');
const GAS_L1_DATA = shortString('L1_DATA');

const hex = (v) => '0x' + BigInt(v).toString(16);

// ---------------------------------------------------------------- calls

// Entrypoint selector: Starknet keccak (keccak-256 keeping the low 250 bits),
// which is exactly what @scure/starknet's keccak returns.
export function selectorFromName(name) {
  return keccak(utf8ToBytes(name));
}

// The calldata the account's __execute__ (Cairo 1) receives: the call count, then
// per call the target, the selector, the argument count, the arguments.
export function compileCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error('a transaction needs at least one call');
  }
  const out = [BigInt(calls.length)];
  for (const c of calls) {
    if (!c?.to || !c?.entrypoint || !Array.isArray(c?.calldata)) {
      throw new Error(`each call needs {to, entrypoint, calldata[]}, got ${JSON.stringify(c)}`);
    }
    out.push(BigInt(c.to), selectorFromName(c.entrypoint), BigInt(c.calldata.length));
    for (const f of c.calldata) out.push(BigInt(f));
  }
  return out;
}

// ---------------------------------------------------------------- the hash

function encodeBounds(name, bounds) {
  return (name << RESOURCE_OFFSET)
    + (BigInt(bounds.max_amount) << MAX_PRICE_BITS)
    + BigInt(bounds.max_price_per_unit);
}

// `tx` is the plain envelope: { sender, chainId, nonce, tip, resourceBounds,
// compiledCalldata, paymasterData?, accountDeploymentData?, nonceDa?, feeDa? }.
// DA modes default to L1 (0), which is what starknet.js sends for this account.
export function invokeV3Hash(tx) {
  const rb = tx.resourceBounds;
  if (!rb?.l1_gas || !rb?.l2_gas || !rb?.l1_data_gas) {
    throw new Error('resource bounds need l1_gas, l2_gas and l1_data_gas');
  }
  const feeField = poseidonHashMany([
    BigInt(tx.tip ?? 0),
    encodeBounds(GAS_L1, rb.l1_gas),
    encodeBounds(GAS_L2, rb.l2_gas),
    encodeBounds(GAS_L1_DATA, rb.l1_data_gas),
  ]);
  const daHash = (BigInt(tx.nonceDa ?? EDAMODE_L1) << DA_MODE_BITS)
    + BigInt(tx.feeDa ?? EDAMODE_L1);
  const paymaster = (tx.paymasterData ?? []).map((v) => BigInt(v));
  const deployment = (tx.accountDeploymentData ?? []).map((v) => BigInt(v));
  return hex(poseidonHashMany([
    PREFIX_INVOKE,
    VERSION_V3,
    BigInt(tx.sender),
    feeField,
    poseidonHashMany(paymaster),
    BigInt(tx.chainId),
    BigInt(tx.nonce),
    daHash,
    poseidonHashMany(deployment),
    poseidonHashMany(tx.compiledCalldata.map((v) => BigInt(v))),
  ]));
}

// ---------------------------------------------------------------- the body

// The exact JSON the RPC's starknet_addInvokeTransaction takes for a v3 invoke.
// Field names and shapes are pinned by the drift test against the signed
// transaction starknet.js builds for the same envelope.
export function buildInvokeTx({ sender, calls, nonce, resourceBounds, chainId, tip = 0 }) {
  const compiled = compileCalls(calls);
  const envelope = {
    sender, chainId, nonce, tip, resourceBounds, compiledCalldata: compiled,
  };
  const hash = invokeV3Hash(envelope);
  const bound = (b) => ({ max_amount: hex(b.max_amount), max_price_per_unit: hex(b.max_price_per_unit) });
  const body = {
    type: 'INVOKE',
    sender_address: hex(sender),
    calldata: compiled.map(hex),
    signature: [],
    nonce: hex(nonce),
    resource_bounds: {
      l1_gas: bound(resourceBounds.l1_gas),
      l2_gas: bound(resourceBounds.l2_gas),
      l1_data_gas: bound(resourceBounds.l1_data_gas),
    },
    tip: hex(tip),
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: 'L1',
    fee_data_availability_mode: 'L1',
    version: hex(VERSION_V3),
  };
  return { envelope, compiled, hash, body };
}

// Sign the transaction hash with the owner key, exactly like the digest signing:
// same curve, same key, a different message. Returns {r, s} hex strings and also
// writes them into a copy of the body so the tab can hand the server one object.
export function signInvokeTx(tx, body, ownerPrivateKey) {
  const sig = sign(tx.hash, String(ownerPrivateKey).trim());
  const signature = [hex(sig.r), hex(sig.s)];
  return {
    signature: { r: hex(sig.r), s: hex(sig.s) },
    body: { ...body, signature },
  };
}

// The chain-id felt for a network label ('SN_SEPOLIA'), computed from the bytes -
// never typed from memory. tests/tx-signer.test.mjs pins the result against
// starknet.js's own StarknetChainId table.
export function chainIdFelt(label) {
  return hex(shortString(String(label)));
}

function daMode(value) {
  if (value === 'L1' || value === 0 || value === '0') return 0n;
  if (value === 'L2' || value === 1 || value === '1') return 1n;
  throw new Error(`unknown data availability mode '${value}'`);
}

// Recompute the transaction hash FROM A FINISHED RPC BODY. This is what the relay
// server does before carrying anything: the body carries no hash, so the server
// rebuilds it and checks the signature against the owner key it read from the
// chain. A body built for another chain, or edited after signing, produces a
// different hash and therefore a signature that does not verify.
export function hashFromBody(body, chainId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('a transaction body is required');
  }
  if (body.type !== 'INVOKE') throw new Error(`only INVOKE transactions can be relayed, got '${body.type}'`);
  if (BigInt(body.version ?? -1) !== VERSION_V3) {
    throw new Error(`only transaction version 0x3 can be relayed, got '${body.version}'`);
  }
  const rb = body.resource_bounds;
  if (!rb?.l1_gas || !rb?.l2_gas || !rb?.l1_data_gas) {
    throw new Error('resource_bounds need l1_gas, l2_gas and l1_data_gas');
  }
  if (!Array.isArray(body.calldata) || body.calldata.length === 0) {
    throw new Error('calldata is required');
  }
  return invokeV3Hash({
    sender: body.sender_address,
    chainId,
    nonce: body.nonce,
    tip: body.tip ?? 0,
    resourceBounds: rb,
    compiledCalldata: body.calldata,
    paymasterData: body.paymaster_data ?? [],
    accountDeploymentData: body.account_deployment_data ?? [],
    nonceDa: daMode(body.nonce_data_availability_mode),
    feeDa: daMode(body.fee_data_availability_mode),
  });
}

export { getStarkKey };
