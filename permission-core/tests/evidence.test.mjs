// Layer D evidence tests.
//
// Every test here is an OBS-08 test: the thing under test is the ONLY barrier
// between a valid-looking record and an accepted one. A tampered fact must fail
// the signature; a proof must fail for the wrong leaf; a sequence gap must fail
// the store. No test accepts "it looked fine".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStarkKey } from '@scure/starknet';

import {
  agentIdFor, createEvidenceStore, evidenceDigest, identityDigest, merkleProof,
  merkleRoot, normaliseFacts, signEvidence, signIdentity, validateEvidenceRecord,
  validateIdentity, verifyEvidence, verifyIdentity, verifyMerkleProof,
} from '../src/evidence.mjs';

const OWNER_PRIV = '0x1';
const OWNER_PUB = getStarkKey(OWNER_PRIV);
const WITNESS_PRIV = '0x2';
const WITNESS_PUB = getStarkKey(WITNESS_PRIV);
const ATTACKER_PRIV = '0x3';
const ATTACKER_PUB = getStarkKey(ATTACKER_PRIV);
const AGENT = '0xabc123';
const NOW = 1_800_000_000_000;

function makeIdentity(overrides = {}) {
  return signIdentity({
    owner: OWNER_PUB,
    purpose: 'travel booking',
    nonce: '0x1',
    createdAt: NOW - 1000,
    ...overrides,
  }, OWNER_PRIV);
}

function makeRecord(overrides = {}) {
  const { signWith = WITNESS_PRIV, ...fields } = overrides;
  return signEvidence({
    version: 1,
    agentId: AGENT,
    seq: 1,
    at: NOW - 500,
    domain: 'spend',
    action: 'spend:transfer',
    outcome: 'sandbox-allowed',
    facts: { recipient: '0x079e', amount: '5', code: 'within-mandate' },
    witness: WITNESS_PUB,
    ...fields,
  }, signWith);
}

// ---------------------------------------------------------------- identity

test('an owner-signed identity verifies; the agent id is derived, not typed', () => {
  const identity = makeIdentity();
  assert.equal(validateIdentity(identity).length, 0);
  assert.equal(verifyIdentity(identity, OWNER_PUB), true);
  assert.equal(identity.agentId, agentIdFor(identity));
});

test('a different owner key cannot claim the identity', () => {
  const identity = makeIdentity();
  assert.equal(verifyIdentity(identity, ATTACKER_PUB), false);
});

test('changing the purpose invalidates the owner signature', () => {
  const identity = makeIdentity();
  const tampered = { ...identity, purpose: 'drain the account' };
  assert.equal(verifyIdentity(tampered, OWNER_PUB), false);
});

test('changing the owner or nonce invalidates the owner signature', () => {
  const identity = makeIdentity();
  assert.equal(verifyIdentity({ ...identity, owner: ATTACKER_PUB }, ATTACKER_PUB), false);
  assert.equal(verifyIdentity({ ...identity, nonce: '0x2' }, OWNER_PUB), false);
});

test('the identity digest is deterministic', () => {
  const identity = makeIdentity();
  assert.equal(identityDigest(identity), identityDigest({ ...identity }));
  assert.notEqual(identityDigest(identity), identityDigest({ ...identity, createdAt: NOW }));
});

// ---------------------------------------------------------------- evidence

test('a witness-signed record verifies; changing any fact breaks it', () => {
  const record = makeRecord();
  assert.equal(validateEvidenceRecord(record).length, 0);
  assert.equal(verifyEvidence(record, WITNESS_PUB), true);

  const tampered = {
    ...record,
    facts: { ...record.facts, amount: '5000' },
  };
  assert.equal(verifyEvidence(tampered, WITNESS_PUB), false);
});

test('a record signed by a different key does not verify as the witness', () => {
  const record = makeRecord({ witness: ATTACKER_PUB, signWith: ATTACKER_PRIV });
  assert.equal(verifyEvidence(record, ATTACKER_PUB), true);
  assert.equal(verifyEvidence(record, WITNESS_PUB), false);
});

test('evidence shape rejects scores and prose-only records', () => {
  const record = makeRecord();
  assert.ok(validateEvidenceRecord({ ...record, outcome: 'trusted' }).length > 0);
  assert.ok(validateEvidenceRecord({ ...record, facts: 'the agent was good' }).length > 0);
  assert.ok(validateEvidenceRecord({ ...record, action: 'transfer' }).length > 0);
});

test('bigint facts become exact decimal strings, never floats', () => {
  assert.deepEqual(normaliseFacts({ amount: 5n, nested: [10n, { x: 1n }], gone: undefined }),
    { amount: '5', nested: ['10', { x: '1' }] });
});

// ---------------------------------------------------------------- Merkle

test('every leaf in trees of size 1..7 has a verifying proof', () => {
  for (let n = 1; n <= 7; n += 1) {
    const digests = Array.from({ length: n }, (_, i) => evidenceDigest(makeRecord({ seq: i + 1 })));
    const root = merkleRoot(digests);
    for (let i = 0; i < n; i += 1) {
      const { proof } = merkleProof(digests, i);
      assert.equal(verifyMerkleProof(digests[i], proof, root), true, `n=${n} leaf=${i}`);
      const wrong = evidenceDigest(makeRecord({ seq: i + 1, at: NOW - 1 }));
      assert.equal(verifyMerkleProof(wrong, proof, root), false, `n=${n} wrong leaf=${i}`);
    }
  }
});

test('a proof cannot be replayed against a different root', () => {
  const digests = [1, 2, 3, 4].map((seq) => evidenceDigest(makeRecord({ seq })));
  const { proof } = merkleProof(digests, 2);
  const otherRoot = merkleRoot(digests.slice(0, 3));
  assert.equal(verifyMerkleProof(digests[2], proof, otherRoot), false);
});

test('the empty tree has a zero root', () => {
  assert.equal(merkleRoot([]), '0x' + '0'.repeat(64));
});

// ---------------------------------------------------------------- store

test('the store enforces sequence, signatures, and tamper detection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  const filePath = join(dir, 'evidence.json');
  const store = createEvidenceStore({ filePath, now: () => NOW });

  store.append(makeRecord({ seq: 1 }));
  store.append(makeRecord({ seq: 2, at: NOW - 400 }));
  store.append(makeRecord({ seq: 3, at: NOW - 300 }));
  assert.equal(store.count(AGENT), 3);
  assert.equal(store.verifyAll().ok, true);

  const root = store.root(AGENT);
  const { proof } = store.proof(AGENT, 2);
  assert.equal(verifyMerkleProof(evidenceDigest(store.list(AGENT)[1]), proof, root), true);

  // A skipped sequence is refused before it is written.
  assert.throws(() => store.append(makeRecord({ seq: 5, at: NOW - 200 })), /must be 4/);

  // Editing the file after the fact is detected.
  const db = JSON.parse(readFileSync(filePath, 'utf8'));
  db.records[1].facts.amount = '9999';
  writeFileSync(filePath, JSON.stringify(db, null, 2));
  const check = store.verifyAll();
  assert.equal(check.ok, false);
  assert.match(check.errors.join(' '), /signature does not verify/);
});

test('a record signed by a foreign witness is accepted by the store but caught by trust', () => {
  // The store verifies each record against the witness IT NAMES. Binding the
  // whole file to one app witness is the trust layer's job (tested separately).
  const dir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  const store = createEvidenceStore({ filePath: join(dir, 'evidence.json'), now: () => NOW });
  store.append(makeRecord({ witness: ATTACKER_PUB, signWith: ATTACKER_PRIV }));
  assert.equal(store.verifyAll().ok, true);
  assert.equal(store.list(AGENT)[0].witness, ATTACKER_PUB);
});

test('a future-dated record is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  const store = createEvidenceStore({ filePath: join(dir, 'evidence.json'), now: () => NOW });
  assert.throws(() => store.append(makeRecord({ at: NOW + 1 })), /future/);
});
