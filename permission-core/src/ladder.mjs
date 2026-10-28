// Layer D, the ladder: what an agent's evidence earns it.
//
// Five stages, each a concrete permission profile (not a score):
//
//   new         propose-only: every action becomes a proposal
//   probation   small steps: 5 per call, 20 per window, 1 delete/day, no sharing
//   trusted     the live mandate: the on-chain caps, 3 deletes/day, no sharing
//   established broader: the live mandate, 10 deletes/day, sharing allowed
//   restricted  propose-only after violations, until the owner reinstates
//
// Two rules keep this honest:
//
//   1. The ladder only SUGGESTS. A stage changes only through a ladder change
//      signed by the owner key (the same key the chain reports). The app cannot
//      promote its own agent.
//   2. Every promotion binds to an evidence root. The owner signs a specific
//      snapshot (root + count); currentStage recomputes that root from the
//      records and refuses a change whose root does not match. Editing history
//      after the fact invalidates the promotion, loudly.
//
// Sandbox records count toward the FIRST step only. They are explicitly
// simulated (no value moved), so they can show that an agent follows the rules,
// but they can never earn the broader stages. Real executed/approved records are
// required above probation.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  evidenceDigest, hashToFelt, isHex, merkleRoot, normFelt, signDigest, verifyDigest,
} from './evidence.mjs';

export const STAGES = ['new', 'probation', 'trusted', 'established', 'restricted'];

// `null` means "use the live on-chain mandate"; a BigInt is an additional
// off-chain cap for the stage. The chain is still the final authority.
export const PROFILES = Object.freeze({
  new: Object.freeze({
    label: 'propose-only', autoSpendPerCall: 0n, autoSpendPerWindow: 0n,
    maxDeletesPerDay: 0, canShare: false,
  }),
  probation: Object.freeze({
    label: 'small steps', autoSpendPerCall: 5n, autoSpendPerWindow: 20n,
    maxDeletesPerDay: 1, canShare: false,
  }),
  trusted: Object.freeze({
    label: 'live mandate', autoSpendPerCall: null, autoSpendPerWindow: null,
    maxDeletesPerDay: 3, canShare: false,
  }),
  established: Object.freeze({
    label: 'broader domains', autoSpendPerCall: null, autoSpendPerWindow: null,
    maxDeletesPerDay: 10, canShare: true,
  }),
  restricted: Object.freeze({
    label: 'propose-only', autoSpendPerCall: 0n, autoSpendPerWindow: 0n,
    maxDeletesPerDay: 0, canShare: false,
  }),
});

const CLEAN = new Set(['executed', 'approved', 'sandbox-allowed']);
const REAL_CLEAN = new Set(['executed', 'approved']);
const STRIKES = new Set(['blocked', 'declined']);

export function summarise(records) {
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  const recent = ordered.slice(-10);
  const count = (set) => ordered.filter((r) => set.has(r.outcome)).length;
  return {
    total: ordered.length,
    clean: count(CLEAN),
    realClean: count(REAL_CLEAN),
    sandboxClean: ordered.filter((r) => r.outcome === 'sandbox-allowed').length,
    asked: ordered.filter((r) => r.outcome === 'asked' || r.outcome === 'sandbox-asked').length,
    strikes: count(STRIKES),
    recentStrikes: recent.filter((r) => STRIKES.has(r.outcome)).length,
  };
}

// The next stage the evidence has EARNED, or null. This is a suggestion for the
// owner's signature, never an automatic move.
export function suggestNext(stage, summary) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage '${stage}'`);
  if (stage !== 'restricted' && summary.strikes >= 3) {
    return { to: 'restricted', reason: `${summary.strikes} violations on record` };
  }
  if (stage === 'restricted') {
    if (summary.recentStrikes === 0 && summary.realClean >= 3) {
      return { to: 'probation', reason: '3 clean real actions since the restriction' };
    }
    return null;
  }
  if (stage === 'new') {
    if (summary.recentStrikes === 0 && summary.clean >= 3) {
      return {
        to: 'probation',
        reason: `${summary.clean} clean actions (sandbox counts for this first step)`,
      };
    }
    return null;
  }
  if (stage === 'probation') {
    if (summary.recentStrikes === 0 && summary.realClean >= 10) {
      return { to: 'trusted', reason: '10 clean real actions' };
    }
    return null;
  }
  if (stage === 'trusted') {
    if (summary.recentStrikes === 0 && summary.realClean >= 25) {
      return { to: 'established', reason: '25 clean real actions' };
    }
    return null;
  }
  return null;
}

const TRANSITIONS = {
  new: ['probation', 'restricted'],
  probation: ['trusted', 'restricted'],
  trusted: ['established', 'restricted'],
  established: ['restricted'],
  restricted: ['probation'],
};

export function validateTransition(from, to) {
  if (!STAGES.includes(from)) return { ok: false, reason: `unknown stage '${from}'` };
  if (!STAGES.includes(to)) return { ok: false, reason: `unknown stage '${to}'` };
  if (!TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: `cannot move from '${from}' to '${to}'` };
  }
  return { ok: true, reason: `'${from}' -> '${to}'` };
}

// ---------------------------------------------------------------- ladder changes

export function ladderChangeDigest(change) {
  return hashToFelt({
    v: 1,
    kind: 'layer-d:ladder-change',
    agentId: change.agentId,
    seq: Number(change.seq),
    from: change.from,
    to: change.to,
    reason: change.reason,
    evidenceRoot: normFelt(change.evidenceRoot),
    evidenceCount: Number(change.evidenceCount),
    at: Number(change.at),
    owner: normFelt(change.owner),
  });
}

export function validateLadderChange(change) {
  const errors = [];
  if (typeof change !== 'object' || change === null || Array.isArray(change)) {
    return ['ladder change must be an object'];
  }
  if (change.version !== 1) errors.push('version must be 1');
  if (change.kind !== 'ladder-change') errors.push("kind must be 'ladder-change'");
  if (!isHex(change.agentId)) errors.push('agentId must be a hex felt');
  if (!Number.isInteger(change.seq) || change.seq <= 0) errors.push('seq must be a positive integer');
  if (!STAGES.includes(change.from)) errors.push(`from must be one of ${STAGES.join(', ')}`);
  if (!STAGES.includes(change.to)) errors.push(`to must be one of ${STAGES.join(', ')}`);
  if (typeof change.reason !== 'string' || change.reason.trim().length < 5) {
    errors.push('reason must be a plain sentence (5+ chars)');
  }
  if (!isHex(change.evidenceRoot)) errors.push('evidenceRoot must be a hex felt');
  if (!Number.isInteger(change.evidenceCount) || change.evidenceCount <= 0) {
    errors.push('evidenceCount must be a positive integer');
  }
  if (!Number.isInteger(change.at) || change.at <= 0) errors.push('at must be a positive integer (ms)');
  if (!isHex(change.owner)) errors.push('owner must be a hex public key');
  if (!change.signature?.r || !change.signature?.s) errors.push('signature is required');
  return errors;
}

export function signLadderChange(change, ownerPrivateKey) {
  const clean = {
    version: 1,
    kind: 'ladder-change',
    agentId: change.agentId,
    seq: Number(change.seq),
    from: change.from,
    to: change.to,
    reason: change.reason,
    evidenceRoot: normFelt(change.evidenceRoot),
    evidenceCount: Number(change.evidenceCount),
    at: Number(change.at),
    owner: normFelt(change.owner),
  };
  return { ...clean, signature: signDigest(ladderChangeDigest(clean), ownerPrivateKey) };
}

export function verifyLadderChange(change, ownerPublicKey, context = null) {
  if (validateLadderChange(change).length > 0) return false;
  if (normFelt(change.owner) !== normFelt(ownerPublicKey)) return false;
  return verifyDigest(ladderChangeDigest(change), change.signature, ownerPublicKey, context);
}

// ---------------------------------------------------------------- ladder store

// `context` carries the typed-data binding ({kind, accountAddress, chainId}) a
// WALLET-signed change needs to verify. Without it only raw digest-v1 changes
// pass, so a store that writes wallet signatures must be built with it (found
// while building Track 3: the server's ladder apply verified with context, then
// the store's own context-less re-check refused the very same envelope).
export function createLadderStore({ filePath, now = () => Date.now(), context = null }) {
  if (!filePath) throw new Error('a ladder store needs a filePath');

  function load() {
    if (!existsSync(filePath)) return { version: 1, changes: [] };
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }
  function save(db) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(db, null, 2));
  }

  function append(change) {
    const errors = validateLadderChange(change);
    if (errors.length > 0) throw new Error(`invalid ladder change: ${errors.join('; ')}`);
    if (!verifyLadderChange(change, change.owner, context)) {
      throw new Error('ladder change signature does not verify against its owner');
    }
    const db = load();
    const forAgent = db.changes
      .filter((c) => c.agentId === change.agentId)
      .sort((a, b) => a.seq - b.seq);
    const expected = forAgent.length === 0 ? 1 : forAgent[forAgent.length - 1].seq + 1;
    if (change.seq !== expected) {
      throw new Error(`ladder seq for this agent must be ${expected}, got ${change.seq}`);
    }
    const previousStage = forAgent.length === 0 ? 'new' : forAgent[forAgent.length - 1].to;
    if (change.from !== previousStage) {
      throw new Error(`ladder change starts from '${change.from}', but the agent is '${previousStage}'`);
    }
    const transition = validateTransition(change.from, change.to);
    if (!transition.ok) throw new Error(`invalid ladder transition: ${transition.reason}`);
    if (change.at > now()) throw new Error('a ladder change cannot be dated in the future');
    db.changes.push(change);
    save(db);
    return change;
  }

  function list(agentId) {
    return load().changes
      .filter((c) => agentId === undefined || c.agentId === agentId)
      .sort((a, b) => (a.agentId === b.agentId ? a.seq - b.seq : a.agentId.localeCompare(b.agentId)));
  }

  function verifyAll() {
    const errors = [];
    const db = load();
    if (!Array.isArray(db.changes)) return { ok: false, errors: ['changes must be an array'] };
    const last = new Map();
    for (const [i, change] of db.changes.entries()) {
      const shape = validateLadderChange(change);
      if (shape.length > 0) {
        errors.push(`change ${i}: ${shape.join('; ')}`);
        continue;
      }
      if (!verifyLadderChange(change, change.owner, context)) {
        errors.push(`change ${i}: signature does not verify against ${change.owner}`);
      }
      const previous = last.get(change.agentId);
      const expectedSeq = (previous?.seq ?? 0) + 1;
      if (change.seq !== expectedSeq) {
        errors.push(`change ${i}: seq ${change.seq}, expected ${expectedSeq}`);
      }
      const expectedFrom = previous?.to ?? 'new';
      if (change.from !== expectedFrom) {
        errors.push(`change ${i}: from '${change.from}', expected '${expectedFrom}'`);
      }
      const transition = validateTransition(change.from, change.to);
      if (!transition.ok) errors.push(`change ${i}: ${transition.reason}`);
      last.set(change.agentId, change);
    }
    return { ok: errors.length === 0, errors };
  }

  return { append, list, verifyAll };
}

// Walk the owner-signed changes in order, verifying each signature AND the
// evidence root it binds to. A change that fails any check stops the walk: later
// changes cannot be trusted if their predecessor is broken.
export function currentStage({ agentId, changes, ownerPublicKey, records, context = null }) {
  const ordered = [...changes]
    .filter((c) => c.agentId === agentId)
    .sort((a, b) => a.seq - b.seq);
  let stage = 'new';
  const applied = [];
  const rejected = [];

  for (const change of ordered) {
    if (change.from !== stage) {
      rejected.push({ change, reason: `starts from '${change.from}', agent is '${stage}'` });
      break;
    }
    if (!verifyLadderChange(change, ownerPublicKey, context)) {
      rejected.push({ change, reason: 'signature does not verify against the chain owner key' });
      break;
    }
    const transition = validateTransition(change.from, change.to);
    if (!transition.ok) {
      rejected.push({ change, reason: transition.reason });
      break;
    }
    if (change.evidenceCount > records.length) {
      rejected.push({ change, reason: `binds ${change.evidenceCount} records, only ${records.length} exist` });
      break;
    }
    const prefix = records
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, change.evidenceCount)
      .map(evidenceDigest);
    const root = merkleRoot(prefix);
    if (BigInt(root) !== BigInt(change.evidenceRoot)) {
      rejected.push({ change, reason: 'evidence root does not match the records' });
      break;
    }
    stage = change.to;
    applied.push(change);
  }

  return { stage, applied, rejected };
}
