// Track 3: witness attestations - owner-signed keys that make an honest key
// ROTATION legitimate history instead of a red flag.
//
// Every check here is an OBS-08 check: it is the ONLY thing between a plausible
// forgery (a rotated-out key signing new facts, a foreign app's key signing into
// this history, an attacker minting an attestation) and that forgery being
// accepted as an agent's real track record.
//
// No network. Synthetic owner/witness keys and raw digest-v1 signatures - the
// same signDigest/verifyDigest the browser wallet's typed-data path resolves to,
// so the crypto is identical and only the signature transport differs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStarkKey } from '@scure/starknet';
import { signEvidence } from '../src/evidence.mjs';
import {
  attestationInEffectAt, createAttestationStore, signWitnessAttestation,
  validateWitnessAttestation, verifyRecordsAgainstChain, verifyWitnessAttestation,
  witnessAttestationDigest, witnessChain, witnessForRecord,
} from '../src/attestations.mjs';

const OWNER_PRIV = '0x1';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const ATTACKER_PRIV = '0x2';
const ATTACKER_PUB = getStarkKey(ATTACKER_PRIV);
const W1_PRIV = '0x3';
const W1_PUB = getStarkKey(W1_PRIV);
const W2_PRIV = '0x4';
const W2_PUB = getStarkKey(W2_PRIV);

const AGENT = '0xabc123';
const OTHER_AGENT = '0xdef456';
const NOW = 1_800_000_000_000;

// Canonical felt form, for comparisons that must not trip on leading zeros.
const nf = (v) => '0x' + BigInt(v).toString(16);

function signedAttest(fields = {}, ownerPriv = OWNER_PRIV) {
  return signWitnessAttestation({
    version: 1,
    kind: 'witness-attestation',
    agentId: AGENT,
    seq: 1,
    witness: W1_PUB,
    supersedes: null,
    validFrom: NOW - 30_000,
    reason: 'first witness for the app',
    at: NOW - 30_000,
    owner: getStarkKey(ownerPriv),
    ...fields,
  }, ownerPriv);
}

function record(seq, at, { witness = W1_PUB, key = W1_PRIV, agentId = AGENT } = {}) {
  return signEvidence({
    version: 1,
    agentId,
    seq,
    at,
    domain: 'spend',
    action: 'spend:transfer',
    outcome: 'sandbox-allowed',
    facts: { amount: '5' },
    witness,
  }, key);
}

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'attest-')), 'attestations.json');
}

// ---------------------------------------------------------------- primitive

test('an owner-signed attestation verifies; any edit or a foreign signer breaks it', () => {
  const a = signedAttest({});
  assert.equal(verifyWitnessAttestation(a, OWNER_PUB), true);
  assert.equal(typeof witnessAttestationDigest(a), 'string');

  // Editing any signed field breaks the signature.
  assert.equal(verifyWitnessAttestation({ ...a, witness: W2_PUB }, OWNER_PUB), false);
  assert.equal(verifyWitnessAttestation({ ...a, validFrom: a.validFrom + 1 }, OWNER_PUB), false);
  assert.equal(verifyWitnessAttestation({ ...a, agentId: OTHER_AGENT }, OWNER_PUB), false);
  assert.equal(verifyWitnessAttestation({ ...a, supersedes: ATTACKER_PUB }, OWNER_PUB), false);

  // Verified against the wrong owner key: refused.
  assert.equal(verifyWitnessAttestation(a, ATTACKER_PUB), false);

  // An attacker can mint a self-consistent attestation, but it never verifies
  // against the OWNER key the chain reports - which is the only key that counts.
  const forged = signedAttest({ witness: ATTACKER_PUB }, ATTACKER_PRIV);
  assert.equal(verifyWitnessAttestation(forged, OWNER_PUB), false);
  assert.equal(verifyWitnessAttestation(forged, ATTACKER_PUB), true);
});

test('validateWitnessAttestation names every malformed field', () => {
  const a = signedAttest({});
  assert.deepEqual(validateWitnessAttestation(a), []);
  assert.ok(validateWitnessAttestation({ ...a, version: 2 }).length > 0);
  assert.ok(validateWitnessAttestation({ ...a, kind: 'not-an-attestation' }).length > 0);
  assert.ok(validateWitnessAttestation({ ...a, seq: 0 }).length > 0);
  assert.ok(validateWitnessAttestation({ ...a, witness: 'nothex' }).length > 0);
  assert.ok(validateWitnessAttestation({ ...a, supersedes: 'nothex' }).length > 0);
  assert.ok(validateWitnessAttestation({ ...a, validFrom: 0 }).length > 0);
  assert.ok(validateWitnessAttestation({ ...a, reason: 'x' }).length > 0);
  assert.ok(validateWitnessAttestation({ ...a, at: -1 }).length > 0);
  assert.ok(validateWitnessAttestation({ ...a, owner: 'nothex' }).length > 0);
  assert.ok(validateWitnessAttestation({ ...a, signature: null }).length > 0);
  // supersedes: null is legal (the genesis link).
  assert.deepEqual(validateWitnessAttestation({ ...a, supersedes: null }), []);
});

// ---------------------------------------------------------------- store

test('the store refuses an attestation its own stated owner did not sign', () => {
  const store = createAttestationStore({ filePath: tempPath(), now: () => NOW });
  const bad = signWitnessAttestation({
    version: 1, kind: 'witness-attestation', agentId: AGENT, seq: 1,
    witness: W1_PUB, supersedes: null, validFrom: NOW - 10_000,
    reason: 'claims to be the owner but is not', at: NOW - 10_000, owner: OWNER_PUB,
  }, ATTACKER_PRIV);
  assert.throws(() => store.append(bad), /does not verify against its owner/);
});

test('the store enforces seq, supersedes links, forward time, a real rotation, and no future dating', () => {
  const store = createAttestationStore({ filePath: tempPath(), now: () => NOW });
  store.append(signedAttest({ seq: 1, witness: W1_PUB, supersedes: null, validFrom: NOW - 30_000, at: NOW - 30_000 }));
  assert.equal(store.list(AGENT).length, 1);

  // seq must be contiguous.
  assert.throws(
    () => store.append(signedAttest({ seq: 3, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW - 20_000, at: NOW - 20_000, reason: 'rotated' })),
    /seq for this agent must be 2/);

  // supersedes must name the actual previous witness.
  assert.throws(
    () => store.append(signedAttest({ seq: 2, witness: W2_PUB, supersedes: ATTACKER_PUB, validFrom: NOW - 20_000, at: NOW - 20_000, reason: 'rotated' })),
    /previous witness is/);

  // time must move forward.
  assert.throws(
    () => store.append(signedAttest({ seq: 2, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW - 40_000, at: NOW - 20_000, reason: 'rotated' })),
    /before the previous/);

  // a rotation to the SAME key is not a rotation.
  assert.throws(
    () => store.append(signedAttest({ seq: 2, witness: W1_PUB, supersedes: W1_PUB, validFrom: NOW - 20_000, at: NOW - 20_000, reason: 'rotated' })),
    /nothing rotated/);

  // no future dating (validFrom or at).
  assert.throws(
    () => store.append(signedAttest({ seq: 2, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW + 5_000, at: NOW - 20_000, reason: 'rotated' })),
    /future/);
  assert.throws(
    () => store.append(signedAttest({ seq: 2, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW - 20_000, at: NOW + 5_000, reason: 'rotated' })),
    /future/);

  // a real rotation appends, and the whole file still verifies.
  store.append(signedAttest({ seq: 2, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW - 20_000, at: NOW - 20_000, reason: 'rotated after a leak' }));
  assert.equal(store.list(AGENT).length, 2);
  assert.equal(store.verifyAll().ok, true);
});

test('verifyAll catches a broken link that append would have refused', () => {
  const path = tempPath();
  const store = createAttestationStore({ filePath: path, now: () => NOW });
  store.append(signedAttest({ seq: 1, witness: W1_PUB, supersedes: null, validFrom: NOW - 30_000, at: NOW - 30_000 }));
  store.append(signedAttest({ seq: 2, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW - 20_000, at: NOW - 20_000, reason: 'rotated' }));
  assert.equal(store.verifyAll().ok, true);

  // Hand-corrupt the file: rewind the second link's validFrom behind the first.
  const db = JSON.parse(readFileSync(path, 'utf8'));
  db.attestations[1].validFrom = NOW - 99_000;
  writeFileSync(path, JSON.stringify(db, null, 2));
  const check = store.verifyAll();
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /validFrom .* before previous/.test(e)));
});

// ---------------------------------------------------------------- chain walk

test('witnessChain verifies the owner-signed chain and STOPS at a broken link', () => {
  const a1 = signedAttest({ seq: 1, witness: W1_PUB, supersedes: null, validFrom: NOW - 30_000, at: NOW - 30_000 });
  const a2 = signedAttest({ seq: 2, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW - 20_000, at: NOW - 20_000, reason: 'rotated' });

  const chain = witnessChain({ agentId: AGENT, attestations: [a1, a2], ownerPublicKey: OWNER_PUB });
  assert.equal(chain.ok, true);
  assert.equal(chain.current, nf(W2_PUB));
  assert.deepEqual(chain.witnesses.map((w) => w.witness), [nf(W1_PUB), nf(W2_PUB)]);
  assert.deepEqual(chain.witnesses.map((w) => w.validFrom), [NOW - 30_000, NOW - 20_000]);

  // A forged second link (attacker-signed) stops the walk: only a1 is trusted,
  // so the "current" witness is still W1 and the forgery is named, not absorbed.
  const forged = signedAttest({ seq: 2, witness: ATTACKER_PUB, supersedes: W1_PUB, validFrom: NOW - 20_000, at: NOW - 20_000, reason: 'evil rotation' }, ATTACKER_PRIV);
  const bad = witnessChain({ agentId: AGENT, attestations: [a1, forged], ownerPublicKey: OWNER_PUB });
  assert.equal(bad.ok, false);
  assert.equal(bad.current, nf(W1_PUB));
  assert.equal(bad.witnesses.length, 1);
  assert.match(bad.rejected[0].reason, /does not verify/);
});

test('witnessChain refuses a supersedes link that does not name the previous witness', () => {
  const a1 = signedAttest({ seq: 1, witness: W1_PUB, supersedes: null, validFrom: NOW - 30_000, at: NOW - 30_000 });
  // a2 claims to supersede the ATTACKER key, not W1 - an unbroken-chain violation.
  const a2 = signedAttest({ seq: 2, witness: W2_PUB, supersedes: ATTACKER_PUB, validFrom: NOW - 20_000, at: NOW - 20_000, reason: 'rotated' });
  const chain = witnessChain({ agentId: AGENT, attestations: [a1, a2], ownerPublicKey: OWNER_PUB });
  assert.equal(chain.ok, false);
  assert.match(chain.rejected[0].reason, /supersedes/);
});

// ---------------------------------------------------------------- the four proof properties

test('PROOF: a rotated-out key cannot sign NEW records, but OLD records still verify', () => {
  const a1 = signedAttest({ seq: 1, witness: W1_PUB, supersedes: null, validFrom: NOW - 30_000, at: NOW - 30_000 });
  const a2 = signedAttest({ seq: 2, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW - 10_000, at: NOW - 10_000, reason: 'rotated' });
  const chain = witnessChain({ agentId: AGENT, attestations: [a1, a2], ownerPublicKey: OWNER_PUB });
  assert.equal(chain.ok, true);

  // An OLD record, made while W1 was in effect, still verifies after the rotation.
  const oldRec = record(1, NOW - 20_000, { witness: W1_PUB, key: W1_PRIV });
  assert.equal(witnessForRecord(oldRec, chain).ok, true);

  // A NEW record under the current key W2 verifies.
  const newRec = record(2, NOW - 5_000, { witness: W2_PUB, key: W2_PRIV });
  assert.equal(witnessForRecord(newRec, chain).ok, true);

  // The rotated-OUT key W1 signing a NEW record (after the rotation) is refused -
  // the attestation in effect now names W2.
  const stale = record(3, NOW - 5_000, { witness: W1_PUB, key: W1_PRIV });
  const staleRes = witnessForRecord(stale, chain);
  assert.equal(staleRes.ok, false);
  assert.match(staleRes.reason, /attestation in effect at .* names/);
});

test('PROOF: a record predating the chain, and a foreign app witness, are each refused', () => {
  const a1 = signedAttest({ seq: 1, witness: W1_PUB, supersedes: null, validFrom: NOW - 30_000, at: NOW - 30_000 });
  const chain = witnessChain({ agentId: AGENT, attestations: [a1], ownerPublicKey: OWNER_PUB });

  // Dated before any attestation took effect -> nothing was in effect -> refused.
  const ancient = record(1, NOW - 40_000, { witness: W1_PUB, key: W1_PRIV });
  assert.equal(witnessForRecord(ancient, chain).ok, false);
  assert.match(witnessForRecord(ancient, chain).reason, /predates/);

  // A witness that is not in this agent's chain at all -> refused.
  const foreign = record(2, NOW - 20_000, { witness: ATTACKER_PUB, key: ATTACKER_PRIV });
  assert.equal(witnessForRecord(foreign, chain).ok, false);
  assert.match(witnessForRecord(foreign, chain).reason, /names/);
});

test("PROOF: per-app isolation - a key attested for one app cannot sign into another's history", () => {
  const a1 = signedAttest({ seq: 1, witness: W1_PUB, supersedes: null, validFrom: NOW - 30_000, at: NOW - 30_000 });
  // The attestation names AGENT, so OTHER_AGENT's chain is empty.
  const chainOther = witnessChain({ agentId: OTHER_AGENT, attestations: [a1], ownerPublicKey: OWNER_PUB });
  assert.equal(chainOther.witnesses.length, 0);
  assert.equal(chainOther.current, null);

  // A record for OTHER_AGENT bearing W1 has no attestation in effect -> refused.
  const rec = record(1, NOW - 20_000, { witness: W1_PUB, key: W1_PRIV, agentId: OTHER_AGENT });
  assert.equal(witnessForRecord(rec, chainOther).ok, false);
});

test('attestationInEffectAt picks the greatest validFrom <= at', () => {
  const a1 = signedAttest({ seq: 1, witness: W1_PUB, supersedes: null, validFrom: NOW - 30_000, at: NOW - 30_000 });
  const a2 = signedAttest({ seq: 2, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW - 10_000, at: NOW - 10_000, reason: 'rotated' });
  const chain = witnessChain({ agentId: AGENT, attestations: [a1, a2], ownerPublicKey: OWNER_PUB });
  assert.equal(attestationInEffectAt(chain, NOW - 40_000), null);// before the chain
  assert.equal(attestationInEffectAt(chain, NOW - 20_000).witness, nf(W1_PUB));
  assert.equal(attestationInEffectAt(chain, NOW - 10_000).witness, nf(W2_PUB));// exactly at validFrom
  assert.equal(attestationInEffectAt(chain, NOW).witness, nf(W2_PUB));
});

test('verifyRecordsAgainstChain accepts a fully covered history and names the first gap', () => {
  const a1 = signedAttest({ seq: 1, witness: W1_PUB, supersedes: null, validFrom: NOW - 30_000, at: NOW - 30_000 });
  const a2 = signedAttest({ seq: 2, witness: W2_PUB, supersedes: W1_PUB, validFrom: NOW - 10_000, at: NOW - 10_000, reason: 'rotated' });
  const chain = witnessChain({ agentId: AGENT, attestations: [a1, a2], ownerPublicKey: OWNER_PUB });

  const covered = [
    record(1, NOW - 20_000, { witness: W1_PUB, key: W1_PRIV }),
    record(2, NOW - 5_000, { witness: W2_PUB, key: W2_PRIV }),
  ];
  assert.equal(verifyRecordsAgainstChain(covered, chain).ok, true);

  const withGap = [
    record(1, NOW - 20_000, { witness: W1_PUB, key: W1_PRIV }),
    record(2, NOW - 5_000, { witness: W1_PUB, key: W1_PRIV }), // rotated-out key signs a new record
  ];
  const res = verifyRecordsAgainstChain(withGap, chain);
  assert.equal(res.ok, false);
  assert.equal(res.uncovered.record.seq, 2);
});
