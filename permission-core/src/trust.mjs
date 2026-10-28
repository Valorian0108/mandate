// Layer D glue: the trust state the door consults before a domain gate.
//
// It answers two questions and nothing else:
//
//   precheck(request, state, mandate)  -> a decision that must come BEFORE the
//                                         domain gate (cold start, stage caps),
//                                         or null to let the gate decide.
//   overlayPolicies(policies, state)   -> company-side policy narrowed by the
//                                         stage (files deletes / sharing).
//
// Why precheck instead of lowering the live mandate's cap: the spending gate
// mirrors GateAccount and quotes its exact error strings. If the ladder quietly
// lowered the cap, the gate would say "GateAccount: amount over per-call cap"
// for a transfer the chain would actually allow - a lie. The ladder's stricter
// limit is a separate, plainly-labelled ASK_USER (`ladder-cap`), and the chain's
// own reason stays reserved for the chain's own rule.
//
// Evidence recording is deliberately conservative: a real ALLOW is recorded as
// `executed` only when the app supplies a receipt from the action it performed.
// No receipt means no claim. Sandbox runs are explicitly labelled.

import * as stark from '@scure/starknet';

import {
  createEvidenceStore, normaliseFacts, normFelt, signEvidence, verifyIdentity,
} from './evidence.mjs';
import {
  createAttestationStore, verifyRecordsAgainstChain, witnessChain,
} from './attestations.mjs';
import {
  createLadderStore, currentStage, PROFILES, suggestNext, summarise,
} from './ladder.mjs';

const DEFAULT_DOMAINS = ['spend', 'files'];

function ask(request, code, reason) {
  return { verdict: 'ASK_USER', code, reason, gate: 'trust', action: request.action };
}

export function createTrust({
  identity,
  witnessPrivateKey,
  evidencePath,
  ladderPath,
  attestationPath = null,
  attestationContext = null,
  ladderContext = null,
  readOwnerKey,
  domains = DEFAULT_DOMAINS,
  now = () => Date.now(),
}) {
  if (!identity) throw new Error('trust needs the agent identity');
  if (!witnessPrivateKey) throw new Error('trust needs the app witness private key');
  if (!evidencePath || !ladderPath) throw new Error('trust needs evidencePath and ladderPath');
  if (typeof readOwnerKey !== 'function') throw new Error('trust needs readOwnerKey()');

  const witnessPublicKey = stark.getStarkKey(witnessPrivateKey);
  const knownDomains = new Set(domains);

  // Witness attestations (Track 3) are OPTIONAL and additive: with none, a single
  // consistent witness is accepted exactly as before (so nothing that predates
  // rotation breaks). With a chain, every record must be covered by the
  // attestation that was in effect WHEN IT WAS MADE, so an honest key rotation
  // reads as legitimate, owner-signed history instead of a contradiction.
  const attestationStore = attestationPath
    ? createAttestationStore({ filePath: attestationPath, now, context: attestationContext })
    : null;
  function loadAttestations() {
    return attestationStore ? attestationStore.list(identity.agentId) : [];
  }

  async function load() {
    const owner = await readOwnerKey();
    if (!verifyIdentity(identity, owner)) {
      return {
        ok: false,
        error: 'identity-unverified',
        reason: 'the agent identity is not signed by the owner key the chain reports',
      };
    }

    const evidence = createEvidenceStore({ filePath: evidencePath, now });
    const evidenceCheck = evidence.verifyAll();
    if (!evidenceCheck.ok) {
      return {
        ok: false,
        error: 'evidence-unverified',
        reason: `the evidence file failed verification: ${evidenceCheck.errors.join('; ')}`,
      };
    }
    const records = evidence.list(identity.agentId);
    // Witness verification: the owner-signed attestation chain when present,
    // otherwise the legacy single-witness assumption. Either way a record whose
    // witness is not authorised is named and refused - never averaged away.
    const attestations = loadAttestations();
    let witnessHistory;
    if (attestations.length > 0) {
      const chain = witnessChain({
        agentId: identity.agentId, attestations, ownerPublicKey: owner,
        context: attestationContext,
      });
      if (!chain.ok) {
        const rej = chain.rejected[0];
        return {
          ok: false,
          error: 'witness-chain-unverified',
          reason: `the witness attestation chain is broken at seq ${rej.attestation.seq}: ${rej.reason}`,
        };
      }
      const recCheck = verifyRecordsAgainstChain(records, chain);
      if (!recCheck.ok) {
        return { ok: false, error: 'evidence-witness-mismatch', reason: recCheck.uncovered.reason };
      }
      witnessHistory = chain.witnesses;
    } else {
      const foreign = records.find((r) => r.witness !== witnessPublicKey);
      if (foreign) {
        return {
          ok: false,
          error: 'evidence-witness-mismatch',
          reason: `record ${foreign.seq} was signed by ${foreign.witness}, not this app's witness`,
        };
      }
      witnessHistory = records.length > 0
        ? [{
          witness: witnessPublicKey, validFrom: null, seq: 0, supersedes: null,
          reason: 'single app witness (no attestation chain)',
        }]
        : [];
    }

    const ladder = createLadderStore({ filePath: ladderPath, now, context: ladderContext });
    const ladderCheck = ladder.verifyAll();
    if (!ladderCheck.ok) {
      return {
        ok: false,
        error: 'ladder-unverified',
        reason: `the ladder file failed verification: ${ladderCheck.errors.join('; ')}`,
      };
    }
    const changes = ladder.list(identity.agentId);
    const stageState = currentStage({
      agentId: identity.agentId, changes, ownerPublicKey: owner, records,
      context: ladderContext,
    });
    const summary = summarise(records);

    return {
      ok: true,
      owner,
      stage: stageState.stage,
      profile: PROFILES[stageState.stage],
      summary,
      records,
      witnessHistory,
      changes,
      applied: stageState.applied,
      rejected: stageState.rejected,
      root: evidence.root(identity.agentId),
      count: records.length,
      suggestion: suggestNext(stageState.stage, summary),
    };
  }

  function precheck(request, state, mandate) {
    const action = request?.action;
    if (typeof action !== 'string' || !action.includes(':')) return null;
    const [domain] = action.split(':');
    if (!knownDomains.has(domain)) return null;

    if (state.stage === 'new') {
      return ask(request, 'cold-start',
        'this agent has no track record yet - every action needs the owner\'s approval ' +
        'until it earns a first step');
    }
    if (state.stage === 'restricted') {
      return ask(request, 'restricted',
        'this agent is restricted after violations - the owner must approve each action');
    }

    if (domain === 'spend') {
      let amount;
      try {
        amount = BigInt(request.context?.amount ?? 0);
      } catch {
        // Malformed amounts belong to the gate, which returns a plain DENY. The
        // trust layer must never turn a bad request into an exception.
        return null;
      }
      if (amount <= 0n) return null; // the gate owns non-positive amounts
      const cap = state.profile.autoSpendPerCall;
      if (cap !== null && amount > cap) {
        return ask(request, 'ladder-cap',
          `this agent's ${state.stage} stage allows at most ${cap} per call; ` +
          `${amount} needs the owner's approval`);
      }
      const windowCap = state.profile.autoSpendPerWindow;
      if (windowCap !== null && mandate) {
        let nowSec;
        let windowStart;
        let windowSeconds;
        let spent;
        try {
          nowSec = BigInt(request.context?.now ?? Math.floor(Date.now() / 1000));
          windowStart = BigInt(mandate.windowStart ?? 0);
          windowSeconds = BigInt(mandate.windowSeconds ?? 0);
          spent = nowSec >= windowStart + windowSeconds
            ? 0n
            : BigInt(mandate.spentInWindow ?? 0);
        } catch {
          return null; // the gate will reject a malformed time/context
        }
        if (spent + amount > windowCap) {
          return ask(request, 'ladder-window',
            `this agent's ${state.stage} stage allows at most ${windowCap} per window; ` +
            `${spent + amount} would need the owner's approval`);
        }
      }
    }

    if (action === 'files:share' && !state.profile.canShare) {
      return ask(request, 'ladder-share',
        `this agent's ${state.stage} stage does not allow sharing files without approval`);
    }
    if (action === 'files:delete' && state.profile.maxDeletesPerDay === 0) {
      return ask(request, 'ladder-delete',
        `this agent's ${state.stage} stage does not allow deleting files without approval`);
    }
    return null;
  }

  function overlayPolicies(policies, state) {
    const files = policies.files;
    if (!files) return policies;
    return {
      ...policies,
      files: {
        ...files,
        maxDeletesPerDay: Math.min(
          Number(files.maxDeletesPerDay ?? 0),
          state.profile.maxDeletesPerDay,
        ),
        shareRequiresApproval:
          Boolean(files.shareRequiresApproval) || !state.profile.canShare,
      },
    };
  }

  function record(request, decision, { sandbox = false, proposalId = null, receipt = null } = {}) {
    let outcome = null;
    if (sandbox) {
      outcome = decision.verdict === 'ALLOW' ? 'sandbox-allowed'
        : decision.verdict === 'DENY' ? 'sandbox-blocked'
          : 'sandbox-asked';
    } else if (decision.verdict === 'ALLOW') {
      outcome = receipt ? 'executed' : null; // no receipt -> do not claim execution
    } else if (decision.verdict === 'DENY') {
      outcome = 'blocked';
    } else {
      outcome = 'asked';
    }
    if (outcome === null) return null;

    // Refuse to sign with a rotated-out witness. If the attestation chain names a
    // different CURRENT key, this key has been superseded: any record it signs now
    // would be (correctly) refused at load, so fail at the source with plain words
    // instead of producing a record that silently poisons the file.
    const attestations = loadAttestations();
    if (attestations.length > 0) {
      const latest = attestations
        .slice()
        .sort((a, b) => (a.validFrom - b.validFrom) || (a.seq - b.seq))
        .at(-1);
      if (normFelt(latest.witness) !== normFelt(witnessPublicKey)) {
        throw new Error(`this app's witness key has been rotated out - the current ` +
          `attested witness is ${latest.witness}, refusing to sign a new record ` +
          `with ${witnessPublicKey}`);
      }
    }

    const evidence = createEvidenceStore({ filePath: evidencePath, now });
    const record = signEvidence({
      version: 1,
      agentId: identity.agentId,
      seq: evidence.count(identity.agentId) + 1,
      at: now(),
      domain: request.action.split(':')[0],
      action: request.action,
      outcome,
      facts: {
        action: request.action,
        resource: request.resource,
        context: normaliseFacts(request.context ?? {}),
        code: decision.code,
        reason: decision.reason,
        proposalId,
        receipt: receipt === null ? null : normaliseFacts(receipt),
      },
      witness: witnessPublicKey,
    }, witnessPrivateKey);
    evidence.append(record);
    return record;
  }

  return { load, precheck, overlayPolicies, record };
}
