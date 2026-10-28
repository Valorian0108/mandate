// Layer D, witness attestations: which key speaks for an app, and when.
//
// An evidence record is signed by an APP WITNESS key. Today one agent has one
// witness forever, so an honest key ROTATION (a leak, a re-provision, a scheduled
// turn) looks like a contradiction. A witness attestation fixes that: it is an
// OWNER-signed statement -
//
//   "witness key W speaks for agent A from time T, superseding key W_prev" -
//
// signed by the same owner key the chain reports (get_public_key on the
// GateAccount) that signs an agent's identity and its ladder promotions. A
// rotation is therefore legitimate, owner-signed history, not a red flag.
//
// This module mirrors ladder.mjs on purpose: an append-only, seq-ordered,
// supersedes-linked chain, each link owner-signed, walked in order so a broken
// link stops the walk (later attestations cannot be trusted if a predecessor is).
// Verification is context-aware (verifyDigest) so an attestation can be signed
// raw (headless tests/scripts) OR as wallet typed-data (the browser owner, post
// phase-6 handover) - exactly like a ladder change.
//
// Nothing here is on-chain: like the rest of the hybrid model, signatures live
// off-chain and the chain holds fingerprints. On-chain registration of
// attestation fingerprints is a later option, not a v-next requirement.
//
// Curve operations come from evidence.mjs (@scure/starknet). No constant is typed
// from memory.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { hashToFelt, isHex, normFelt, signDigest, verifyDigest } from './evidence.mjs';

// normFelt, but a null/undefined supersedes (the first attestation) stays null
// instead of throwing - the genesis link has nothing before it.
function normFeltOrNull(value) {
  if (value === null || value === undefined) return null;
  return normFelt(value);
}

// ---------------------------------------------------------------- attestation

export function witnessAttestationDigest(att) {
  return hashToFelt({
    v: 1,
    kind: 'layer-d:witness-attestation',
    agentId: att.agentId,
    seq: Number(att.seq),
    witness: normFelt(att.witness),
    supersedes: normFeltOrNull(att.supersedes),
    validFrom: Number(att.validFrom),
    reason: att.reason,
    at: Number(att.at),
    owner: normFelt(att.owner),
  });
}

export function validateWitnessAttestation(att) {
  const errors = [];
  if (typeof att !== 'object' || att === null || Array.isArray(att)) {
    return ['witness attestation must be an object'];
  }
  if (att.version !== 1) errors.push('version must be 1');
  if (att.kind !== 'witness-attestation') errors.push("kind must be 'witness-attestation'");
  if (!isHex(att.agentId)) errors.push('agentId must be a hex felt');
  if (!Number.isInteger(att.seq) || att.seq <= 0) errors.push('seq must be a positive integer');
  if (!isHex(att.witness)) errors.push('witness must be a hex public key');
  if (att.supersedes !== null && att.supersedes !== undefined && !isHex(att.supersedes)) {
    errors.push('supersedes must be a hex public key or null');
  }
  if (!Number.isInteger(att.validFrom) || att.validFrom <= 0) {
    errors.push('validFrom must be a positive integer (ms)');
  }
  if (typeof att.reason !== 'string' || att.reason.trim().length < 5) {
    errors.push('reason must be a plain sentence (5+ chars)');
  }
  if (!Number.isInteger(att.at) || att.at <= 0) errors.push('at must be a positive integer (ms)');
  if (!isHex(att.owner)) errors.push('owner must be a hex public key');
  if (!att.signature?.r || !att.signature?.s) errors.push('signature is required');
  return errors;
}

export function signWitnessAttestation(att, ownerPrivateKey) {
  const clean = {
    version: 1,
    kind: 'witness-attestation',
    agentId: att.agentId,
    seq: Number(att.seq),
    witness: normFelt(att.witness),
    supersedes: normFeltOrNull(att.supersedes),
    validFrom: Number(att.validFrom),
    reason: att.reason,
    at: Number(att.at),
    owner: normFelt(att.owner),
  };
  return { ...clean, signature: signDigest(witnessAttestationDigest(clean), ownerPrivateKey) };
}

export function verifyWitnessAttestation(att, ownerPublicKey, context = null) {
  if (validateWitnessAttestation(att).length > 0) return false;
  if (normFelt(att.owner) !== normFelt(ownerPublicKey)) return false;
  return verifyDigest(witnessAttestationDigest(att), att.signature, ownerPublicKey, context);
}

// ---------------------------------------------------------------- store

// `context` carries the typed-data binding ({kind:'witness-attestation',
// accountAddress, chainId}) a WALLET-signed attestation needs to verify - the
// same optional parameter createLadderStore takes. Without it only raw digest-v1
// attestations pass the store's own re-check; with it the browser owner's
// wallet signature is accepted end to end.
export function createAttestationStore({ filePath, now = () => Date.now(), context = null }) {
  if (!filePath) throw new Error('an attestation store needs a filePath');

  function load() {
    if (!existsSync(filePath)) return { version: 1, attestations: [] };
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }
  function save(db) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(db, null, 2));
  }

  function append(att) {
    const errors = validateWitnessAttestation(att);
    if (errors.length > 0) throw new Error(`invalid witness attestation: ${errors.join('; ')}`);
    if (!verifyWitnessAttestation(att, att.owner, context)) {
      throw new Error('witness attestation signature does not verify against its owner');
    }
    const db = load();
    const forAgent = db.attestations
      .filter((a) => a.agentId === att.agentId)
      .sort((a, b) => a.seq - b.seq);
    const expected = forAgent.length === 0 ? 1 : forAgent[forAgent.length - 1].seq + 1;
    if (att.seq !== expected) {
      throw new Error(`attestation seq for this agent must be ${expected}, got ${att.seq}`);
    }
    const prev = forAgent.length === 0 ? null : forAgent[forAgent.length - 1];
    const expectedSupersedes = prev ? normFelt(prev.witness) : null;
    if (normFeltOrNull(att.supersedes) !== expectedSupersedes) {
      throw new Error(`attestation supersedes '${att.supersedes}', but the previous ` +
        `witness is '${expectedSupersedes}'`);
    }
    if (prev && att.validFrom < prev.validFrom) {
      throw new Error(`attestation validFrom ${att.validFrom} is before the previous ` +
        `${prev.validFrom} - time must move forward`);
    }
    if (prev && normFelt(att.witness) === normFelt(prev.witness)) {
      throw new Error('attestation names the same witness as the previous one - ' +
        'nothing rotated');
    }
    if (att.at > now()) throw new Error('a witness attestation cannot be dated in the future');
    if (att.validFrom > now()) {
      throw new Error('a witness attestation cannot be valid from a future time');
    }
    db.attestations.push(att);
    save(db);
    return att;
  }

  function list(agentId) {
    return load().attestations
      .filter((a) => agentId === undefined || a.agentId === agentId)
      .sort((a, b) => (a.agentId === b.agentId ? a.seq - b.seq : a.agentId.localeCompare(b.agentId)));
  }

  function verifyAll() {
    const errors = [];
    const db = load();
    if (!Array.isArray(db.attestations)) return { ok: false, errors: ['attestations must be an array'] };
    const last = new Map();
    for (const [i, att] of db.attestations.entries()) {
      const shape = validateWitnessAttestation(att);
      if (shape.length > 0) {
        errors.push(`attestation ${i}: ${shape.join('; ')}`);
        continue;
      }
      if (!verifyWitnessAttestation(att, att.owner, context)) {
        errors.push(`attestation ${i}: signature does not verify against ${att.owner}`);
      }
      const previous = last.get(att.agentId);
      const expectedSeq = (previous?.seq ?? 0) + 1;
      if (att.seq !== expectedSeq) {
        errors.push(`attestation ${i}: seq ${att.seq}, expected ${expectedSeq}`);
      }
      const expectedSupersedes = previous ? normFelt(previous.witness) : null;
      if (normFeltOrNull(att.supersedes) !== expectedSupersedes) {
        errors.push(`attestation ${i}: supersedes '${att.supersedes}', expected '${expectedSupersedes}'`);
      }
      if (previous && att.validFrom < previous.validFrom) {
        errors.push(`attestation ${i}: validFrom ${att.validFrom} before previous ${previous.validFrom}`);
      }
      last.set(att.agentId, att);
    }
    return { ok: errors.length === 0, errors };
  }

  return { append, list, verifyAll };
}

// ---------------------------------------------------------------- chain walk

// Walk the owner-signed attestations for one agent in seq order, verifying each
// signature and each supersedes link. A link that fails any check stops the walk:
// later attestations cannot be trusted if their predecessor is broken (the same
// rule the ladder's currentStage applies). Returns the witnesses in effect (in
// time order), the CURRENT witness, and any rejected link.
export function witnessChain({ agentId, attestations, ownerPublicKey, context = null }) {
  const ordered = [...attestations]
    .filter((a) => a.agentId === agentId)
    .sort((a, b) => a.seq - b.seq);
  const witnesses = [];
  const rejected = [];
  let prevWitness = null;
  let prevValidFrom = null;

  for (const att of ordered) {
    if (!verifyWitnessAttestation(att, ownerPublicKey, context)) {
      rejected.push({ attestation: att, reason: 'signature does not verify against the chain owner key' });
      break;
    }
    if (normFeltOrNull(att.supersedes) !== prevWitness) {
      rejected.push({
        attestation: att,
        reason: `supersedes '${att.supersedes}', but the previous witness is '${prevWitness}'`,
      });
      break;
    }
    if (prevValidFrom !== null && att.validFrom < prevValidFrom) {
      rejected.push({
        attestation: att,
        reason: `validFrom ${att.validFrom} is before the previous ${prevValidFrom}`,
      });
      break;
    }
    witnesses.push({
      witness: normFelt(att.witness),
      validFrom: att.validFrom,
      seq: att.seq,
      reason: att.reason,
      supersedes: normFeltOrNull(att.supersedes),
    });
    prevWitness = normFelt(att.witness);
    prevValidFrom = att.validFrom;
  }

  const current = witnesses.length > 0 ? witnesses[witnesses.length - 1].witness : null;
  return { ok: rejected.length === 0, witnesses, current, rejected };
}

// The witness in effect at time `at`: the attestation with the greatest
// validFrom <= at. `chain.witnesses` is in ascending validFrom order (the walk
// enforces it), so this is the last link that has already taken effect.
export function attestationInEffectAt(chain, at) {
  let inEffect = null;
  for (const w of chain.witnesses) {
    if (w.validFrom <= at) inEffect = w;
    else break;
  }
  return inEffect;
}

// Verify one record's witness against the chain: the witness in effect at the
// record's `at` must be the key that signed it. This single rule delivers the
// whole Track-3 promise - a rotated-out key cannot sign NEW records (the
// attestation in effect now names the new key), OLD records still verify (the
// attestation in effect THEN named the old key), and a foreign key never matches
// any attestation in this agent's chain.
export function witnessForRecord(record, chain) {
  const inEffect = attestationInEffectAt(chain, Number(record.at));
  if (!inEffect) {
    return {
      ok: false,
      reason: `no witness attestation was in effect at ${record.at} - the record ` +
        'predates this agent\'s attestation chain',
    };
  }
  if (normFelt(record.witness) !== inEffect.witness) {
    return {
      ok: false,
      reason: `record ${record.seq} was signed by ${record.witness}, but the ` +
        `attestation in effect at ${record.at} names ${inEffect.witness}`,
    };
  }
  return { ok: true, witness: inEffect.witness, validFrom: inEffect.validFrom, seq: inEffect.seq };
}

// Verify every record against the chain. Returns the first uncovered record (if
// any) plus the full per-record result, so the résumé can name a genuine problem
// instead of averaging it away.
export function verifyRecordsAgainstChain(records, chain) {
  const results = records.map((record) => ({ record, ...witnessForRecord(record, chain) }));
  const uncovered = results.find((r) => !r.ok) ?? null;
  return { ok: uncovered === null, uncovered, results };
}
