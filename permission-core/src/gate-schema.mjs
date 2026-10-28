// The gate registration format, as code.
//
// A gate is two things: a DOCUMENT (what it claims, in plain data) and an
// EVALUATE function (what it does). The document exists so a stranger can read
// what a gate covers without reading its code, and so the engine can refuse a
// gate whose paperwork is wrong AT REGISTRATION - not at decision time, where
// a malformed gate could look like an ALLOW to a careless caller (OBS-08).
//
// The format is deliberately strict: unknown fields are errors, so a typo in a
// field name surfaces immediately instead of silently dropping a rule.
//
// validateGateDocument(doc)      -> { ok, errors }   the paperwork alone
// validateGateRegistration(gate) -> { ok, errors }   paperwork vs the code object
//                                 (a gate with no document is legacy-accepted)

export const GATE_DOCUMENT_VERSION = 1;
export const CONTEXT_TYPES = ['address', 'uint', 'string', 'bool'];
export const RESOLUTION_KINDS = ['execute-once', 'amend', 'decline'];

const KNOWN_FIELDS = [
  'version', 'namespace', 'description', 'actions', 'contextFields',
  'policyFields', 'codes', 'approvals', 'advisoryOnly', 'onchain',
];
const KNOWN_APPROVAL_FIELDS = ['canAskUser', 'resolutions', 'amendmentKinds'];
const NAMESPACE_RE = /^[a-z][a-z0-9]*$/;
const CODE_RE = /^[a-z][a-z0-9-]*$/;

const sameSet = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  [...a].sort().join('|') === [...b].sort().join('|');

export function validateGateDocument(doc) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, errors: ['gate document must be an object'] };
  }
  for (const k of Object.keys(doc)) {
    if (!KNOWN_FIELDS.includes(k)) err(`unknown field '${k}' - the format is strict so typos surface`);
  }
  if (doc.version !== GATE_DOCUMENT_VERSION) {
    err(`version must be ${GATE_DOCUMENT_VERSION}, got ${JSON.stringify(doc.version)}`);
  }
  if (typeof doc.namespace !== 'string' || !NAMESPACE_RE.test(doc.namespace)) {
    err(`namespace must be a lowercase word, got ${JSON.stringify(doc.namespace)}`);
  }
  if (typeof doc.description !== 'string' || doc.description.trim().length < 10) {
    err('description must be a plain sentence (10+ chars) a user could read');
  }

  // actions: non-empty, namespaced, and every one of them gets a contextFields entry
  const declared = new Set();
  if (!Array.isArray(doc.actions) || doc.actions.length === 0) {
    err('actions must be a non-empty array');
  } else {
    for (const a of doc.actions) {
      const parts = String(a).split(':');
      if (typeof a !== 'string' || parts.length !== 2 || parts[0] !== doc.namespace || !parts[1]) {
        err(`action '${a}' must look like '${doc.namespace}:verb'`);
      }
      declared.add(a);
    }
  }

  if (typeof doc.contextFields !== 'object' || doc.contextFields === null || Array.isArray(doc.contextFields)) {
    err('contextFields must be an object keyed by action');
  } else {
    for (const [action, fields] of Object.entries(doc.contextFields)) {
      if (!declared.has(action)) err(`contextFields declares undeclared action '${action}'`);
      if (!Array.isArray(fields)) {
        err(`contextFields['${action}'] must be an array (use [] if the action needs nothing)`);
        continue;
      }
      for (const f of fields) {
        const name = f?.name;
        if (typeof name !== 'string' || !name) err(`contextFields['${action}'] has an entry without a name`);
        if (!CONTEXT_TYPES.includes(f?.type)) {
          err(`contextFields['${action}'].${name ?? '?'} type must be one of ${CONTEXT_TYPES.join(', ')}, got ${JSON.stringify(f?.type)}`);
        }
        if (typeof f?.required !== 'boolean') {
          err(`contextFields['${action}'].${name ?? '?'} must say required: true or false`);
        }
      }
    }
    for (const a of declared) {
      if (!(a in doc.contextFields)) err(`action '${a}' has no contextFields entry (use [] if it needs none)`);
    }
  }

  if (!Array.isArray(doc.policyFields) || doc.policyFields.length === 0 ||
      !doc.policyFields.every((p) => typeof p === 'string' && p)) {
    err('policyFields must be a non-empty array of names');
  }

  if (!Array.isArray(doc.codes) || doc.codes.length === 0 ||
      !doc.codes.every((c) => typeof c === 'string' && CODE_RE.test(c))) {
    err('codes must be a non-empty array of kebab-case strings');
  }

  const ap = doc.approvals;
  if (typeof ap !== 'object' || ap === null || Array.isArray(ap)) {
    err('approvals must be an object');
  } else {
    for (const k of Object.keys(ap)) {
      if (!KNOWN_APPROVAL_FIELDS.includes(k)) err(`approvals has unknown field '${k}'`);
    }
    if (typeof ap.canAskUser !== 'boolean') err('approvals.canAskUser must be true or false');
    if (!Array.isArray(ap.resolutions) || ap.resolutions.length === 0 ||
        !ap.resolutions.every((r) => RESOLUTION_KINDS.includes(r))) {
      err(`approvals.resolutions must be a non-empty subset of ${RESOLUTION_KINDS.join(', ')}`);
    }
    if (Array.isArray(ap.resolutions) && ap.resolutions.includes('amend') &&
        (!Array.isArray(ap.amendmentKinds) || ap.amendmentKinds.length === 0 ||
         !ap.amendmentKinds.every((k) => typeof k === 'string' && k))) {
      err('a gate whose resolutions include amend must list its amendmentKinds');
    }
  }

  if (typeof doc.advisoryOnly !== 'boolean') err('advisoryOnly must be true or false');

  if (doc.advisoryOnly === false) {
    const oc = doc.onchain;
    if (typeof oc !== 'object' || oc === null) {
      err('a gate that is not advisoryOnly must describe its onchain lock');
    } else {
      if (typeof oc.contract !== 'string' || !oc.contract) err('onchain.contract must name the enforcing contract');
      if (!Array.isArray(oc.entrypoints) || oc.entrypoints.length === 0 ||
          !oc.entrypoints.every((e) => typeof e === 'string' && e)) {
        err('onchain.entrypoints must list where the lock enforces');
      }
      if (!Array.isArray(oc.mirroredErrors) || oc.mirroredErrors.length === 0 ||
          !oc.mirroredErrors.every((s) => typeof s === 'string' && s)) {
        err('onchain.mirroredErrors must list the contract strings this gate quotes');
      }
    }
  } else if (doc.advisoryOnly === true && doc.onchain !== undefined && doc.onchain !== null) {
    err('advisoryOnly: true with an onchain block is a contradiction - pick one story');
  }

  return { ok: errors.length === 0, errors };
}

// The paperwork against the code object. The document may not claim a different
// namespace, a different action list, different policy fields or a different
// enforcement story than the object that actually evaluates requests.
export function validateGateRegistration(gate) {
  const doc = gate?.document;
  if (doc === undefined) return { ok: true, errors: [] }; // legacy gate, no paperwork yet

  const { errors } = validateGateDocument(doc);
  if (doc.namespace !== gate.namespace) {
    errors.push(`document namespace '${doc.namespace}' != gate namespace '${gate.namespace}'`);
  }
  if (!sameSet(doc.actions, gate.actions)) {
    errors.push('document actions must equal the gate actions exactly');
  }
  if (!sameSet(doc.policyFields ?? [], gate.policyFields ?? [])) {
    errors.push('document policyFields must equal the gate policyFields exactly');
  }
  if ((doc.advisoryOnly ?? false) !== (gate.advisoryOnly ?? false)) {
    errors.push('document advisoryOnly must equal the gate advisoryOnly');
  }
  return { ok: errors.length === 0, errors };
}
