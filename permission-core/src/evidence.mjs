// Layer D, off-chain half: agent identity, signed evidence records, Merkle roots.
//
// The chain holds a FINGERPRINT (src/../gate-account/src/evidence_registry.cairo);
// this file holds the records the fingerprint covers. Three separate signatures
// make the model honest:
//
//   identity      signed by the OWNER key   -> this owner authorized this agent
//   evidence      signed by the APP key     -> this app witnessed this action
//   ladder change signed by the OWNER key   -> this owner moved the agent's trust
//
// Nothing here is a score. A record stores the raw structured facts of one action
// (who/what/amount/code/reason), never a model's prose and never a reputation
// number. The ladder (ladder.mjs) reads facts; it does not invent them.
//
// Curve operations come from @scure/starknet, the same library the rest of the
// repo uses. No curve constant is typed from memory.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as stark from '@scure/starknet';

import { stableStringify, verifyOwnerSignature } from './proposals.mjs';

const MASK_250 = (1n << 250n) - 1n;

export const OUTCOMES = [
  'executed',        // a real action the door allowed and the app then performed
  'approved',        // a real action the owner approved once and the app performed
  'blocked',         // the door refused; the agent tried something outside the mandate
  'asked',           // the door deferred to the owner; no action yet
  'declined',        // the owner declined a proposal
  'sandbox-allowed', // simulated action, no real value moved
  'sandbox-blocked', // simulated refusal
  'sandbox-asked',   // simulated deferral
];

const HEX_RE = /^0x[0-9a-fA-F]+$/;

export function isHex(value) {
  return typeof value === 'string' && HEX_RE.test(value);
}

// Normalise a felt-like value without masking it: public keys and addresses are
// real field elements and must not lose their top bits.
export function normFelt(value) {
  if (value === undefined || value === null) throw new Error('a felt value is required');
  return '0x' + BigInt(value).toString(16);
}

// Hash a canonical preimage down to a Starknet felt (250 bits, like proposals.mjs).
export function hashToFelt(preimage) {
  const hex = createHash('sha256').update(stableStringify(preimage)).digest('hex');
  return '0x' + (BigInt('0x' + hex) & MASK_250).toString(16).padStart(64, '0');
}

// JSON-safe facts: BigInt becomes a decimal string, undefined keys disappear.
// Money stays exact; it never passes through a float.
export function normaliseFacts(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normaliseFacts);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = normaliseFacts(v);
    }
    return out;
  }
  return value;
}

export function signDigest(digest, privateKey) {
  const sig = stark.sign(digest, privateKey);
  return { r: '0x' + sig.r.toString(16), s: '0x' + sig.s.toString(16) };
}

export function verifyDigest(digest, signature, publicKeyX, context = null) {
  if (!signature?.r || !signature?.s) return false;
  try {
    return verifyOwnerSignature(digest, signature, publicKeyX, context);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- identity

export function agentIdFor({ owner, purpose, nonce }) {
  return hashToFelt({
    v: 1,
    kind: 'layer-d:agent-id',
    owner: normFelt(owner),
    purpose: String(purpose ?? ''),
    nonce: normFelt(nonce),
  });
}

export function identityDigest(identity) {
  return hashToFelt({
    v: 1,
    kind: 'layer-d:identity',
    agentId: identity.agentId,
    owner: normFelt(identity.owner),
    purpose: identity.purpose,
    nonce: normFelt(identity.nonce),
    createdAt: Number(identity.createdAt),
  });
}

export function validateIdentity(identity) {
  const errors = [];
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
    return ['identity must be an object'];
  }
  if (identity.version !== 1) errors.push('version must be 1');
  if (!isHex(identity.agentId)) errors.push('agentId must be a hex felt');
  if (!isHex(identity.owner)) errors.push('owner must be a hex public key');
  if (typeof identity.purpose !== 'string' || identity.purpose.trim().length === 0 ||
      identity.purpose.length > 120) {
    errors.push('purpose must be a plain 1-120 character description');
  }
  if (!isHex(identity.nonce)) errors.push('nonce must be a hex felt');
  if (!Number.isInteger(identity.createdAt) || identity.createdAt <= 0) {
    errors.push('createdAt must be a positive integer (ms)');
  }
  if (!identity.signature?.r || !identity.signature?.s) errors.push('signature is required');
  return errors;
}

export function signIdentity(identity, ownerPrivateKey) {
  const clean = {
    version: 1,
    agentId: agentIdFor(identity),
    owner: normFelt(identity.owner),
    purpose: identity.purpose,
    nonce: normFelt(identity.nonce),
    createdAt: Number(identity.createdAt),
  };
  return { ...clean, signature: signDigest(identityDigest(clean), ownerPrivateKey) };
}

export function verifyIdentity(identity, ownerPublicKey) {
  if (validateIdentity(identity).length > 0) return false;
  if (normFelt(identity.owner) !== normFelt(ownerPublicKey)) return false;
  if (identity.agentId !== agentIdFor(identity)) return false;
  return verifyDigest(identityDigest(identity), identity.signature, ownerPublicKey);
}

// ---------------------------------------------------------------- evidence

export function evidenceDigest(record) {
  return hashToFelt({
    v: 1,
    kind: 'layer-d:evidence',
    agentId: record.agentId,
    seq: Number(record.seq),
    at: Number(record.at),
    domain: record.domain,
    action: record.action,
    outcome: record.outcome,
    facts: record.facts,
    witness: normFelt(record.witness),
  });
}

export function validateEvidenceRecord(record) {
  const errors = [];
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return ['evidence record must be an object'];
  }
  if (record.version !== 1) errors.push('version must be 1');
  if (!isHex(record.agentId)) errors.push('agentId must be a hex felt');
  if (!Number.isInteger(record.seq) || record.seq <= 0) errors.push('seq must be a positive integer');
  if (!Number.isInteger(record.at) || record.at <= 0) errors.push('at must be a positive integer (ms)');
  if (typeof record.domain !== 'string' || !record.domain) errors.push('domain is required');
  if (typeof record.action !== 'string' || !record.action.startsWith(`${record.domain}:`)) {
    errors.push(`action must look like '${record.domain}:verb'`);
  }
  if (!OUTCOMES.includes(record.outcome)) {
    errors.push(`outcome must be one of ${OUTCOMES.join(', ')}`);
  }
  if (typeof record.facts !== 'object' || record.facts === null || Array.isArray(record.facts)) {
    errors.push('facts must be an object of structured facts');
  }
  if (!isHex(record.witness)) errors.push('witness must be a hex public key');
  if (!record.signature?.r || !record.signature?.s) errors.push('signature is required');
  return errors;
}

export function signEvidence(record, witnessPrivateKey) {
  const clean = { ...record, facts: normaliseFacts(record.facts) };
  return { ...clean, signature: signDigest(evidenceDigest(clean), witnessPrivateKey) };
}

export function verifyEvidence(record, witnessPublicKey) {
  if (validateEvidenceRecord(record).length > 0) return false;
  if (normFelt(record.witness) !== normFelt(witnessPublicKey)) return false;
  return verifyDigest(evidenceDigest(record), record.signature, witnessPublicKey);
}

// ---------------------------------------------------------------- Merkle

export function merkleLeaf(digest) {
  return hashToFelt({ v: 1, kind: 'layer-d:merkle-leaf', digest: normFelt(digest) });
}

export function merkleNode(left, right) {
  return hashToFelt({
    v: 1, kind: 'layer-d:merkle-node', left: normFelt(left), right: normFelt(right),
  });
}

export function merkleRoot(digests) {
  if (!Array.isArray(digests)) throw new Error('merkleRoot needs an array of digests');
  if (digests.length === 0) return '0x' + '0'.repeat(64);
  let level = digests.map(merkleLeaf);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? merkleNode(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

export function merkleProof(digests, index) {
  if (!Array.isArray(digests) || digests.length === 0) {
    throw new Error('merkleProof needs a non-empty array of digests');
  }
  if (!Number.isInteger(index) || index < 0 || index >= digests.length) {
    throw new Error(`merkleProof index ${index} is out of range`);
  }
  let level = digests.map(merkleLeaf);
  let idx = index;
  const proof = [];
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const sibling = isRight ? idx - 1 : idx + 1;
    if (sibling < level.length) {
      proof.push({ hash: level[sibling], side: isRight ? 'left' : 'right' });
    }
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? merkleNode(level[i], level[i + 1]) : level[i]);
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { root: level[0], proof };
}

export function verifyMerkleProof(digest, proof, root) {
  if (!Array.isArray(proof)) return false;
  let current = merkleLeaf(digest);
  for (const step of proof) {
    if (!isHex(step?.hash) || (step.side !== 'left' && step.side !== 'right')) return false;
    current = step.side === 'left'
      ? merkleNode(step.hash, current)
      : merkleNode(current, step.hash);
  }
  // Compare as numbers: merkle roots are padded to 64 hex chars, while normFelt
  // strips leading zeros. String equality would reject a perfectly valid proof.
  return BigInt(current) === BigInt(root);
}

// ---------------------------------------------------------------- evidence store

export function createEvidenceStore({ filePath, now = () => Date.now() }) {
  if (!filePath) throw new Error('an evidence store needs a filePath');

  function load() {
    if (!existsSync(filePath)) return { version: 1, records: [] };
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }
  function save(db) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(db, null, 2));
  }

  function append(record) {
    const errors = validateEvidenceRecord(record);
    if (errors.length > 0) throw new Error(`invalid evidence record: ${errors.join('; ')}`);
    if (!verifyEvidence(record, record.witness)) {
      throw new Error('evidence signature does not verify against its witness');
    }
    const db = load();
    const forAgent = db.records
      .filter((r) => r.agentId === record.agentId)
      .sort((a, b) => a.seq - b.seq);
    const expected = forAgent.length === 0 ? 1 : forAgent[forAgent.length - 1].seq + 1;
    if (record.seq !== expected) {
      throw new Error(`evidence seq for this agent must be ${expected}, got ${record.seq}`);
    }
    if (record.at > now()) throw new Error('evidence cannot be dated in the future');
    db.records.push(record);
    save(db);
    return record;
  }

  function list(agentId) {
    const records = load().records;
    return records
      .filter((r) => agentId === undefined || r.agentId === agentId)
      .sort((a, b) => (a.agentId === b.agentId ? a.seq - b.seq : a.agentId.localeCompare(b.agentId)));
  }

  function verifyAll() {
    const errors = [];
    const db = load();
    if (!Array.isArray(db.records)) return { ok: false, errors: ['records must be an array'] };
    const seen = new Set();
    const lastSeq = new Map();
    for (const [i, record] of db.records.entries()) {
      const shape = validateEvidenceRecord(record);
      if (shape.length > 0) {
        errors.push(`record ${i}: ${shape.join('; ')}`);
        continue;
      }
      if (!verifyEvidence(record, record.witness)) {
        errors.push(`record ${i}: signature does not verify against ${record.witness}`);
      }
      const key = `${record.agentId}:${record.seq}`;
      if (seen.has(key)) errors.push(`record ${i}: duplicate ${key}`);
      seen.add(key);
      const expected = (lastSeq.get(record.agentId) ?? 0) + 1;
      if (record.seq !== expected) {
        errors.push(`record ${i}: seq ${record.seq} for ${record.agentId}, expected ${expected}`);
      }
      lastSeq.set(record.agentId, record.seq);
    }
    return { ok: errors.length === 0, errors };
  }

  function root(agentId) {
    return merkleRoot(list(agentId).map(evidenceDigest));
  }

  function proof(agentId, seq) {
    const records = list(agentId);
    const index = records.findIndex((r) => r.seq === seq);
    if (index === -1) throw new Error(`no evidence seq ${seq} for agent ${agentId}`);
    return merkleProof(records.map(evidenceDigest), index);
  }

  function count(agentId) {
    return list(agentId).length;
  }

  return { append, list, verifyAll, root, proof, count };
}
