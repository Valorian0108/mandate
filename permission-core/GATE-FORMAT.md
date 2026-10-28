# The gate format — how to register a new kind of rule

A **gate** is one vertical of permission: everything about what an agent may do in some
domain (`spend`, `files`, later `travel`, `anchor`…). Layer C's engine knows nothing
about any domain. Gates plug in; the engine routes questions to them and refuses to
trust their answers beyond a strict contract.

A gate is **two things**:

1. **A document** — plain data describing what the gate covers. This file is the
   specification of that document. A stranger should be able to read a gate's document
   and know exactly what it polices, without reading its code.
2. **An `evaluate` function** — the actual rules: `(request, policy) → {verdict, code, reason}`.

The document is not decoration. The engine checks it at registration and **refuses the
gate** if the paperwork is wrong or contradicts the code, and the test suite checks the
document against the gate's *behaviour* (every code it can return, every field it truly
requires). A document that lies fails the build.

---

## The request and the answer (the part that never changes)

```js
request  = { user, agent, action, resource, context }
// action is namespaced: 'spend:transfer', 'files:delete' - 'domain:verb'
// context holds ONLY structured facts from the real tool call (C4):
// numbers, addresses, paths. Never prose describing intent.

answer   = { verdict: 'ALLOW' | 'DENY' | 'ASK_USER', code, reason }
// reason is ALWAYS a plain sentence a user could read. No codes-only answers.
```

## The document, field by field

```jsonc
{
  "version": 1,                    // exactly 1, for now
  "namespace": "spend",            // lowercase word; must equal the gate object's namespace
  "description": "Mirrors the GateAccount lock: who the agent may pay, how much per call and per window.",
                                   // one plain sentence, 10+ chars, a user could read
  "actions": ["spend:transfer"],   // every action this gate polices; 'namespace:verb'; non-empty
  "contextFields": {               // per action: the structured facts evaluate() needs
    "spend:transfer": [
      { "name": "recipient", "type": "address", "required": true },
      { "name": "amount",    "type": "uint",    "required": true },
      { "name": "token",     "type": "address", "required": true },
      { "name": "now",       "type": "uint",    "required": false }
    ]
  },                               // types: address | uint | string | bool
                                   // every declared action needs an entry (use [] if none)
  "policyFields": ["maxPerCall", "…"],   // the policy snapshot fields evaluate() reads
  "codes": ["over-per-call-cap", "…", "within-mandate"],
                                   // EVERY code evaluate() can return - no more, no less
  "approvals": {
    "canAskUser": false,           // may this gate ever answer ASK_USER?
    "resolutions": ["execute-once", "amend", "decline"],
                                   // which owner resolutions make sense for its proposals
    "amendmentKinds": ["raise-per-call-cap", "raise-window-cap", "allow-recipient"]
                                   // required iff 'amend' is in resolutions
  },
  "advisoryOnly": false,           // false = an on-chain lock enforces this too
  "onchain": {                    // REQUIRED when advisoryOnly is false, FORBIDDEN when true
    "contract": "GateAccount",
    "entrypoints": ["__validate__", "enforce_spending"],
    "mirroredErrors": ["GateAccount: recipient not allowed", "…"]
                                   // the exact contract strings this gate quotes as reasons
  }
}
```

## The rules, and why each exists

| Rule | Why |
|---|---|
| Unknown fields are errors | A typo (`polcyFields`) must surface at registration, not silently drop a rule. |
| `actions` must be `namespace:verb` and non-empty | Routing is by namespace; a gate policing foreign actions could shadow another gate. |
| Every action needs a `contextFields` entry | The console and the SDK render/validate context from the document; a missing entry means a blind spot. |
| `codes` must equal actual behaviour | The audit screen and tests reason over codes; an undeclared code is an unreviewed path. |
| `advisoryOnly: false` requires an `onchain` block | "The chain enforces this too" is a claim; the claim must name where. |
| `advisoryOnly: true` forbids an `onchain` block | The opposite claim with a lock described is a contradiction - pick one story. |
| `amend` in resolutions requires `amendmentKinds` | The Approvals screen builds amendment forms from these kinds; vague promises make broken forms. |
| Document must match the gate object (namespace, actions, policyFields, advisoryOnly) | Paperwork that describes a different gate than the code is worse than no paperwork. |

## How it is enforced

- `src/gate-schema.mjs` — `validateGateDocument(doc)` and `validateGateRegistration(gate)`.
- `src/engine.mjs` `registerGate()` — a gate carrying a document with any error is
  **refused at registration**, and its namespace stays deny-by-default. A malformed gate
  can never half-register and look like an ALLOW later (OBS-08).
- `tests/gate-schema.test.mjs` — 10 tests: both shipped documents valid; 25 broken
  documents rejected with readable errors; contradictions refused by the engine; and the
  behaviour cross-checks (run every path, compare the codes and required fields against
  the document, both directions).
- Gates without a document are still accepted (back-compat), but every gate shipped in
  this repo carries one.

## Writing a new gate, in six steps

1. Pick a lowercase namespace nobody owns (`travel`).
2. Write the document first — actions, context fields, codes you intend to return,
   whether a chain lock exists. If you cannot fill it in, the gate is not designed yet.
3. Write `evaluate(request, policy)`: check context completeness first
   (`incomplete-context`), then your rules, each DENY with a plain-sentence reason and a
   code from your document. Never throw; never return prose-free verdicts.
4. If a lock enforces this domain on-chain, mirror its checks **in its order** and quote
   its exact error strings; set `advisoryOnly: false` and fill `onchain`. Otherwise set
   `advisoryOnly: true` and say so honestly.
5. `engine.registerGate(yourGate)` — registration is the first test; it refuses bad paperwork.
6. Add the behaviour cross-check to `tests/gate-schema.test.mjs`: a corpus that hits
   every code your gate can return, asserted equal to your document's `codes`.
