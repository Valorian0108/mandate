// Canonical accept-ownership hash vector — the cross-language pin for phase 6.
//
// OpenZeppelin v4.0.1's AccountComponent::set_public_key — the entry point the
// handover uses to rotate the GateAccount owner to the wallet's key — requires
// the NEW owner to sign a raw message hash. account.cairo L329-334 builds it:
//
//   PoseidonTrait::new()
//     .update_with('StarkNet Message')
//     .update_with('accept_ownership')
//     .update_with(starknet::get_contract_address())   // the gate
//     .update_with(current_owner)                      // the key being replaced
//     .finalize()
//
// This prints that hash for ONE fixed pair, computed with the same JavaScript
// primitives the console hashes with (permission-core/web/typed-data.js
// shortStringEncode + @scure/starknet poseidonHashMany — themselves pinned to
// starknet.js 10.8.0 as oracle in tests/typed-data.test.mjs). Cairo test t36
// pins the contract-side mirror (`accept_ownership_hash` in tests/lib.cairo)
// against this literal. Together: contract == Cairo mirror == JS == starknet.js.
//
// WHY it matters: this hash is NOT reachable through a wallet's signMessage
// (Wallet Standard signs SNIP-12 typed data only — the binding finding in
// track2-wallet-research.md), so the handover tool signs it locally with the
// wallet's exported private key, used once and never stored or sent anywhere.
// If the JS and Cairo maths ever diverged, the rotation would revert on chain
// after the old key was already gone; this pin makes that impossible to miss.
//
// The vector uses the Sepolia FIXTURE values (the ones recorded in
// .sepolia/state.json): the v0.3 gate and the pre-handover owner key. It is a
// hash-maths pin, not live state — it must never change when the owner rotates.
//
// Usage: node tools/accept-ownership-vector.mjs
import { poseidonHashMany } from '@scure/starknet';
import { shortStringEncode } from '../../permission-core/web/typed-data.js';

// Must match t36 in gate-account/tests/lib.cairo field for field.
const GATE = '0x7d1d8cad365390adfb2f4f9f89277663c555d2eed790f1c4983c44a002570f1';
const CURRENT_OWNER_PUB = '0x3166ad27f1bedee6af7520d71ee60e1bb3719ab2d26d52fc7fdfc5a3cb4fed0';

const inputs = [
  shortStringEncode('StarkNet Message'),
  shortStringEncode('accept_ownership'),
  BigInt(GATE),
  BigInt(CURRENT_OWNER_PUB),
];
const hash = poseidonHashMany(inputs);

console.log('vector =', JSON.stringify({
  gate: GATE,
  currentOwnerPublicKey: CURRENT_OWNER_PUB,
  inputsHex: inputs.map((v) => '0x' + BigInt(v).toString(16)),
}, null, 2));
console.log('ACCEPT_OWNERSHIP_VECTOR_HASH =', '0x' + BigInt(hash).toString(16));
