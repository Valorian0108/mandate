// crypto-surface:start
// The cast. This whole file is the machine-facing mapping layer, so it sits
// inside one crypto-surface block: it is the ONLY place a machine identifier
// appears in the app's source, and it is a map, never a display. Every screen
// renders the store's NAME; the jargon gate (tools/check-jargon.mjs) fails the
// build if an identifier leaks into rendered copy anywhere else.
//
// Where the addresses come from (all public, all read from the run's state
// file, never typed):
//   CloudCompute -> keys.merchant.address  (on the approved list from the start)
//   DataStore    -> keys.stranger.address  (added later by an owner-signed
//                                           change - a real receipt exists)
//   ShipIt       -> keys.deployer.address  (a real account that is NOT on the
//                                           approved list; it is the cast member
//                                           that demonstrates a refusal, and the
//                                           one the owner can approve later)

export const STORES = [
  {
    name: 'CloudCompute',
    what: 'Server time for the store',
    id: '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38',
  },
  {
    name: 'DataStore',
    what: 'Market data feeds',
    id: '0x16cb41ec11efcc9129d858ae07449f4f1a31d7d292269a5e7c40cd4d33db371',
  },
  {
    name: 'ShipIt',
    what: 'Shipping and labels',
    id: '0x290179d7dcf12b5f733a3680a42bf9e367437ac5486ac480ecd5d5b5fb8546',
  },
];

const norm = (a) => String(a ?? '').toLowerCase().replace(/^0x0+/, '0x');

/** The cast name for a machine identifier. Unknown names stay honest. */
export function storeName(id) {
  const hit = STORES.find((s) => norm(s.id) === norm(id));
  return hit ? hit.name : 'An unknown store';
}

/** What the store sells, for the request rows. */
export function storeWhat(id) {
  const hit = STORES.find((s) => norm(s.id) === norm(id));
  return hit ? hit.what : null;
}

/** The whole cast entry, or null. */
export function storeFor(id) {
  return STORES.find((s) => norm(s.id) === norm(id)) ?? null;
}

/** Is this cast member on the owner's approved list right now? */
export function isApproved(id, allowedRecipients = []) {
  const allowed = allowedRecipients.map(norm);
  return allowed.includes(norm(id));
}
// crypto-surface:end
