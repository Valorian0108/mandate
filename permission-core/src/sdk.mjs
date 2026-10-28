// The front door - the only file an app developer needs to import.
//
// Four functions, on purpose:
//
//   loadMandate()          read the user's REAL rules off the chain (fresh)
//   decide(request)        ask "may this agent do this?" - verdict, no side effects
//   propose(request)       turn a blocked/deferred request into a proposal for the owner
//   execute(request)       the point-of-action one-liner: decide, and if blocked,
//                          propose - so the app never has to invent its own flow
//
// Everything else (engine, gates, mandate reader, proposal store, digest maths)
// stays inside this module. The door hides the internals on purpose: an app that
// can reach the internals can also reach around the rules. tests/sdk.test.mjs
// holds this file to that promise, including a static check that the example app
// imports nothing but the door.
//
// Injection points (readMandate / readOwnerKey / storePath / gates) exist for
// tests and for companies that run their own chain reader; the DEFAULTS are the
// live Sepolia reader and the same append-only proposal file the console's
// Approvals screen reads - so a block raised by any app shows up for the owner
// in one place.

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { createEngine } from './engine.mjs';
import { spendingGate } from './gates/spending.mjs';
import { filesGate } from './gates/files.mjs';
import { readLiveMandate } from './mandate-reader.mjs';
import { chainOwnerPublicKey, createProposalStore } from './proposals.mjs';
import { createTrust } from './trust.mjs';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_STATE = join(PKG_ROOT, '..', 'gate-account', '.sepolia', 'state.json');
const DEFAULT_STORE = join(PKG_ROOT, '.data', 'demo-proposals.json');
const DEFAULT_EVIDENCE = join(PKG_ROOT, '.data', 'evidence.json');
const DEFAULT_LADDER = join(PKG_ROOT, '.data', 'ladder.json');
const DEFAULT_ATTESTATIONS = join(PKG_ROOT, '.data', 'attestations.json');

export function createClient(options = {}) {
  const statePath = options.statePath ?? DEFAULT_STATE;
  const storePath = options.storePath ?? DEFAULT_STORE;
  const readMandate = options.readMandate ?? (() => readLiveMandate(statePath));
  const readOwnerKey = options.readOwnerKey ?? (() => chainOwnerPublicKey({ statePath }));

  // Layer D is optional: without an identity the door behaves exactly as before.
  // With one, every decision is checked against the agent's verified trust state.
  if (options.identity && !options.witnessPrivateKey) {
    throw new Error('an identity needs the app witness private key to sign evidence');
  }
  if (!options.identity && options.witnessPrivateKey) {
    throw new Error('a witness key needs an identity - evidence must belong to an agent');
  }
  const trust = options.identity
    ? createTrust({
      identity: options.identity,
      witnessPrivateKey: options.witnessPrivateKey,
      evidencePath: options.evidencePath ?? DEFAULT_EVIDENCE,
      ladderPath: options.ladderPath ?? DEFAULT_LADDER,
      attestationPath: options.attestationPath ?? DEFAULT_ATTESTATIONS,
      attestationContext: options.attestationContext ?? null,
      ladderContext: options.ladderContext ?? null,
      readOwnerKey,
      domains: options.trustDomains,
      now: options.now,
    })
    : null;

  // The engine and its gates are constructed HERE, at the door. Registering a
  // gate with invalid paperwork throws at createClient time - an app cannot start
  // with a gate whose document lies (see GATE-FORMAT.md).
  const engine = createEngine();
  for (const gate of options.gates ?? [spendingGate, filesGate]) {
    engine.registerGate(gate);
  }

  const store = createProposalStore({ filePath: storePath, getOwnerPublicKey: readOwnerKey });

  let mandate = null;
  let mandateReadAt = null;

  async function loadMandate() {
    mandate = await readMandate();
    mandateReadAt = Date.now();
    return { mandate, readAt: mandateReadAt };
  }

  async function decide(request, { policies, sandbox = false } = {}) {
    if (!mandate) await loadMandate();
    // The live mandate is the spend policy; every other namespace uses the
    // company-side policy the app supplied at construction (or per call).
    const base = { ...(options.policies ?? {}), spend: mandate };

    let trustState = null;
    if (trust) {
      trustState = await trust.load();
      if (!trustState.ok) {
        return {
          verdict: 'DENY',
          code: trustState.error,
          reason: trustState.reason,
          gate: 'trust',
          action: request.action,
        };
      }
      // Sandbox runs simulate the live mandate; they do not apply the current
      // stage's stricter limits, because the point is to show what the agent
      // would do once trusted.
      if (!sandbox) {
        const blocked = trust.precheck(request, trustState, mandate);
        if (blocked) return blocked;
      }
    }

    const merged = { ...base, ...(policies ?? {}) };
    const effective = trust && trustState && !sandbox
      ? trust.overlayPolicies(merged, trustState)
      : merged;
    return engine.decide(request, effective);
  }

  async function propose(request, { note = '' } = {}) {
    const decision = await decide(request);
    // store.create throws on ALLOW with its own words; the message here is the
    // door's own explanation so the app learns why before it hits the store.
    if (decision.verdict === 'ALLOW') {
      throw new Error('this request is allowed by the live mandate - there is nothing ' +
        'to propose. Call execute() and proceed.');
    }
    const proposal = store.create(request, decision, note);
    if (trust) await trust.record(request, decision, { proposalId: proposal.id });
    return proposal;
  }

  async function execute(request, { note = '', sandbox = false, commit } = {}) {
    const decision = await decide(request, { sandbox });

    if (decision.verdict === 'ALLOW') {
      if (sandbox) {
        const evidence = trust
          ? trust.record(request, decision, { sandbox: true })
          : null;
        return { allowed: true, decision, proposal: null, receipt: null, evidence };
      }
      if (typeof commit === 'function') {
        // The app performs the action here. Evidence says `executed` only if the
        // action actually returns a receipt; a thrown commit leaves no record.
        const receipt = await commit(decision);
        const evidence = trust ? trust.record(request, decision, { receipt }) : null;
        return { allowed: true, decision, proposal: null, receipt, evidence };
      }
      // Allowed, but the app did not ask the door to witness the execution.
      return { allowed: true, decision, proposal: null, receipt: null, evidence: null };
    }

    if (sandbox) {
      const evidence = trust
        ? trust.record(request, decision, { sandbox: true })
        : null;
      return { allowed: false, decision, proposal: null, receipt: null, evidence };
    }

    const proposal = store.create(request, decision, note);
    const evidence = trust
      ? trust.record(request, decision, { proposalId: proposal.id })
      : null;
    return { allowed: false, decision, proposal, receipt: null, evidence };
  }

  return Object.freeze({ loadMandate, decide, propose, execute });
}
