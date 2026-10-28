// Layer C core: the decision engine.
//
// One standard question, one standard answer:
//
//   request:  { user, agent, action, resource, context }
//             action is namespaced: 'spend:transfer', 'files:delete'
//   decision: { verdict: 'ALLOW' | 'DENY' | 'ASK_USER',
//               gate, action, code, reason }
//             reason is ALWAYS a plain sentence a user could read.
//
// Design rules baked in (from the layer map / OBS records):
//   - DENY BY DEFAULT: an action whose namespace has no registered gate is denied.
//     Same philosophy as the on-chain merchant allowlist (DESIGN.md deviation #4).
//   - C4: the decision is made from the request's ACTUAL fields (context.amount,
//     context.recipient - the tool call), never from model-produced prose. The
//     engine has no parameter that accepts free text describing intent.
//   - The engine is the fast off-chain half of the agreed split; the on-chain
//     account (Layer E) remains the final authority. A gate whose verdicts could
//     diverge from its lock must say so in `advisoryOnly`.
//   - Pluggability is the layer's "done when": registering a new gate must never
//     require editing this file. Gates are plain objects; nothing here imports them.

import { validateGateRegistration } from './gate-schema.mjs';

export const VERDICTS = ['ALLOW', 'DENY', 'ASK_USER'];

function decision(gate, action, verdict, code, reason) {
  return { gate, action, verdict, code, reason };
}

export function createEngine() {
  const gates = new Map(); // namespace -> gate

  function registerGate(gate) {
    // Shape check up front: a malformed gate must fail at registration, not at
    // decision time (a broken gate that silently returned nothing would look
    // like an ALLOW to a careless caller - OBS-08).
    for (const field of ['namespace', 'actions', 'evaluate']) {
      if (gate[field] === undefined) {
        throw new Error(`gate is missing required field '${field}'`);
      }
    }
    if (typeof gate.namespace !== 'string' || !/^[a-z][a-z0-9]*$/.test(gate.namespace)) {
      throw new Error(`gate namespace must be a lowercase word, got '${gate.namespace}'`);
    }
    if (!Array.isArray(gate.actions) || gate.actions.length === 0) {
      throw new Error(`gate '${gate.namespace}' must declare at least one action`);
    }
    for (const a of gate.actions) {
      if (!a.startsWith(gate.namespace + ':')) {
        throw new Error(`gate '${gate.namespace}' declares foreign action '${a}'`);
      }
    }
    if (typeof gate.evaluate !== 'function') {
      throw new Error(`gate '${gate.namespace}' evaluate must be a function`);
    }
    // The paperwork check: a gate that carries a registration document (see
    // GATE-FORMAT.md) must have valid paperwork, and it must match the code
    // object. Refused here, loudly, so a wrong document can never reach decide().
    const registration = validateGateRegistration(gate);
    if (!registration.ok) {
      throw new Error(`gate '${gate.namespace}' registration document is invalid: ` +
        registration.errors.join('; '));
    }
    if (gates.has(gate.namespace)) {
      throw new Error(`a gate for namespace '${gate.namespace}' is already registered`);
    }
    gates.set(gate.namespace, gate);
  }

  function decide(request, policies = {}) {
    // Validate the request itself: every field the schema promises must exist.
    for (const field of ['user', 'agent', 'action', 'resource']) {
      if (request?.[field] === undefined || request[field] === '') {
        return decision('(core)', request?.action ?? '(none)', 'DENY',
          'malformed-request', `request is missing '${field}'`);
      }
    }
    const [domain, verb] = String(request.action).split(':');
    if (!domain || !verb) {
      return decision('(core)', request.action, 'DENY',
        'unnamespaced-action',
        `action '${request.action}' is not namespaced (expected 'domain:verb')`);
    }

    const gate = gates.get(domain);
    if (!gate) {
      // Deny by default: no gate, no permission. A new vertical is an explicit
      // act of registration, never an accident of routing.
      return decision('(core)', request.action, 'DENY', 'no-gate',
        `no gate is registered for domain '${domain}' - denied by default`);
    }
    if (!gate.actions.includes(request.action)) {
      return decision(gate.namespace, request.action, 'DENY', 'action-not-declared',
        `gate '${gate.namespace}' does not declare action '${request.action}'`);
    }

    const policy = policies[gate.namespace] ?? null;
    let result;
    try {
      result = gate.evaluate(request, policy);
    } catch (e) {
      return decision(gate.namespace, request.action, 'DENY', 'gate-misbehaved',
        `gate '${gate.namespace}' threw (${e?.message ?? e}) - denied by default`);
    }
    if (!result || !VERDICTS.includes(result.verdict)) {
      // A gate that crashes or answers nonsense must never look like success.
      return decision(gate.namespace, request.action, 'DENY', 'gate-misbehaved',
        `gate '${gate.namespace}' returned no valid verdict - denied by default`);
    }
    if (!result.code || !result.reason) {
      return decision(gate.namespace, request.action, 'DENY', 'gate-misbehaved',
        `gate '${gate.namespace}' returned a verdict without a plain-word reason`);
    }
    return decision(gate.namespace, request.action, result.verdict, result.code, result.reason);
  }

  function listGates() {
    return [...gates.values()].map((g) => ({
      namespace: g.namespace,
      actions: [...g.actions],
      policyFields: [...(g.policyFields ?? [])],
      advisoryOnly: g.advisoryOnly ?? false,
    }));
  }

  return { registerGate, decide, listGates };
}
