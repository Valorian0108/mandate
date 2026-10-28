// Compute the OZ v4.0.1 accept-ownership message hash (account.cairo L329-334:
// PoseidonTrait('StarkNet Message','accept_ownership', gate_address,
// current_owner_pub).finalize()) with the JS primitives, TWO independent ways:
//   (a) the console's own: @scure/starknet poseidonHashMany + web/typed-data.js
//       shortStringEncode - the exact code the browser/server hash with
//   (b) starknet.js (the package gate-account/tools already import)
// If both agree, the Cairo drift test can pin the value and the handover tool
// can use whichever package resolves. Inputs are the LIVE deployment values,
// read from state.json - never typed from memory.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/Users/USER/demi the builder';
const state = JSON.parse(readFileSync(`${ROOT}/gate-account/.sepolia/state.json`, 'utf8'));
const gate = state.contracts.gate_account.address;
const ownerPub = state.keys.owner.public_key;

const hex = (v) => '0x' + BigInt(v).toString(16);

// (a) the console's primitives
const scure = await import('@scure/starknet');
const td = await import(pathToFileURL(`${ROOT}/permission-core/web/typed-data.js`).href);
const inputsA = [
  td.shortStringEncode('StarkNet Message'),
  td.shortStringEncode('accept_ownership'),
  BigInt(gate),
  BigInt(ownerPub),
];
const hashA = scure.poseidonHashMany(inputsA);

// (b) starknet.js - probe which exports exist, then use them
const sn = await import('starknet');
const probe = {
  topLevelPoseidonHashMany: typeof sn.poseidonHashMany,
  cryptoKeys: Object.keys(sn.crypto ?? {}).filter((k) => /poseidon/i.test(k)),
  shortStringKeys: Object.keys(sn.shortString ?? {}).filter((k) => /encode/i.test(k)),
};
let hashB = null;
let viaB = null;
const poseidonFn = sn.poseidonHashMany ?? sn.crypto?.poseidonHashMany
  ?? sn.crypto?.poseidon?.poseidonHashMany;
const encodeFn = sn.shortString?.encodeShortString;
if (typeof poseidonFn === 'function' && typeof encodeFn === 'function') {
  hashB = poseidonFn([
    encodeFn('StarkNet Message'), encodeFn('accept_ownership'), gate, ownerPub,
  ]);
  viaB = 'starknet.js poseidonHashMany + shortString.encodeShortString';
}

console.log('ACCEPT_OWNERSHIP_HASH ' + JSON.stringify({
  inputs: { gate, ownerPub },
  scureInputsHex: inputsA.map(hex),
  hashA_scure: hex(hashA),
  hashB_starknetJs: hashB === null ? null : hex(hashB),
  viaB,
  agree: hashB !== null && hex(hashA) === hex(hashB),
  probe,
}));
