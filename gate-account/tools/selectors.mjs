// Authoritative selector constants for GateAccount's whitelists and blocklists.
//
// Why this exists: the on-chain whitelist stores raw felt252 selectors. Hand-copying a hex
// constant from memory would be exactly the kind of unverified assumption this project is
// trying to eliminate, so selectors are computed here and cross-checked against the compiled
// Sierra artifacts (scripts/check-selectors.mjs).
import * as sn from 'starknet';

const getSel =
  sn.selector?.getSelector ?? sn.hash?.getSelector ?? sn.stark?.getSelector ?? sn.getSelector;
if (!getSel) {
  console.error('no getSelector export; keys:', Object.keys(sn).join(', '));
  process.exit(1);
}

const NAMES = [
  // spend selectors (tracked by enforce_spending)
  'transfer',
  'approve',
  'increase_allowance',
  'increaseAllowance',
  // session / policy management
  'add_or_update_session_key',
  'revoke_session_key',
  'get_session_data',
  'set_spending_policy',
  'remove_spending_policy',
  'get_spending_policy',
  'allow_recipient',
  'disallow_recipient',
  'is_recipient_allowed',
  // privileged / account
  'set_public_key',
  'setPublicKey',
  'get_public_key',
  'upgrade',
  '__execute__',
  '__validate__',
  '__validate_declare__',
  '__validate_deploy__',
  'execute_from_outside_v2',
  'is_valid_signature',
  'isValidSignature',
  'supports_interface',
  // mock token
  'balance_of',
];

const out = {};
for (const n of NAMES) {
  const v = getSel(n);
  out[n] = typeof v === 'bigint' ? '0x' + v.toString(16) : v;
}
console.log(JSON.stringify(out, null, 2));
