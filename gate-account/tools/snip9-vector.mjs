// Canonical SNIP-9 outside-execution hash vector — the cross-language pin.
//
// This prints the message hash that Cairo test t35 asserts the contract-side
// mirror (`outside_execution_hash` in tests/lib.cairo, mirroring
// `outside_execution_message_hash` in src/lib.cairo) produces for ONE fixed
// OutsideExecution. The JS side is permission-core/web/typed-data.js, which
// tests/typed-data.test.mjs pins against starknet.js as the oracle (and against
// this same literal). Together: contract == Cairo mirror == JS == starknet.js.
//
// Same pattern as t17 / `node tools/agent-tx.mjs --hash-only` for session hashes.
//
// The vector deliberately uses the SEPOLIA FIXTURE addresses (the ones in
// .sepolia/state.json and the JS tests) — a vector is a hash-maths pin, not live
// state, so it must never change when the gate is redeployed.
//
// Usage: node tools/snip9-vector.mjs
import {
  getMessageHash,
  outsideExecutionTypedData,
} from '../../permission-core/web/typed-data.js';

// Signer = the controller the hash binds to. For the pasted-key proof shape the
// controller IS the gate account, so the v0.2 gate fixture address is the signer.
const SIGNER = '0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25';
const TOKEN = '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd';
const MERCHANT = '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38';

// Must match t35 in gate-account/tests/lib.cairo field for field:
//   chain SN_SEPOLIA, caller ANY_CALLER, nonce 7,
//   window 1_700_000_000 < now < 1_700_003_600,
//   one call: TOKEN.transfer(MERCHANT, 5) with u256 wire layout [to, low, high].
const typedData = outsideExecutionTypedData({
  chainId: 'SN_SEPOLIA',
  caller: 'ANY_CALLER',
  nonce: 7,
  executeAfter: 1_700_000_000,
  executeBefore: 1_700_003_600,
  calls: [{ to: TOKEN, selector: 'transfer', calldata: [MERCHANT, '0x5', '0x0'] }],
});

const hash = getMessageHash(typedData, SIGNER);
console.log('vector =', JSON.stringify({ signer: SIGNER, ...typedData.message }, null, 2));
console.log('SNIP9_VECTOR_HASH =', '0x' + BigInt(hash).toString(16));
