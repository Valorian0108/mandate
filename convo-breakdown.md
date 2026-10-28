# Conversation Breakdown: What Was Agreed

**Source:** `convo.txt` (Starknet research conversation)
**Purpose:** Extract every conclusion/position the conversation landed on, so each can be confirmed, rejected, or refined — before any build decision is made.
**Rule:** AnchorGate is treated as *evidence that a pattern works*, NOT as the thing to rebuild.

Status legend: `[ ]` unconfirmed · `[x]` confirmed · `[~]` needs rework

---

## A. Core beliefs (the philosophy layer)

### A1. AI cannot be made trustworthy — it can be made verifiable
- The goal is never "make the AI correct." It is "prove what the AI did."
- Framing: **"Don't trust the AI. Verify the contract between the user and the AI."**
- Cryptography can prove: this model ran this computation / this action followed these rules.
- Cryptography cannot prove: the answer was wise, best, or aligned.
- (This matches `research.md` — trust is the wrong target; computational accountability is the right one.)

`[x]` confirmed

### A2. The model proposes; plain code decides
- A model is never asked whether its own request should pass.
- The decision engine is deterministic: checks run in a fixed order, verdicts are explainable in plain words.
- Three verdicts only: **ALLOW / DENY / ASK USER** — every no names its reason.

`[x]` confirmed

### A3. A promise is not an enforcement
- "Our app will not let the agent overspend" = a promise (server can be hacked, buggy, malicious).
- "The agent's account cannot produce a valid overspend" = an enforced constraint.
- The meaningful upgrade is moving enforcement from *promise* to *constraint the system cannot bypass*.

`[x]` confirmed

---

## B. Ownership model (who controls what)

### B1. Company owns the app; user owns the authority
- The DEX analogy: the company can own the website, UI, charts, support — but never your keys, so it cannot freeze or move your funds.
- Applied here: **AnchorGate owns the experience. The user owns the gate.**

`[x]` confirmed

### B2. Three-layer split
| Layer | Owner | Examples |
|---|---|---|
| Experience | Company | Login, dashboard, AI chat, notifications, analytics |
| Coordination | Company | Proposals, parsing, indexing, simulations, integrations |
| **Authority** | **User** | Rules, budgets, permissions, approvals, revocation |

- Most Web2 apps collapse all three into company servers. The agreed design keeps layer 3 user-held by default.

`[x]` confirmed

### B3. The server may suggest; only the user's account may authorize
- Server drafts a rule change → user signs it → account commits it.
- Server can be shut down, hacked, or redesigned → user's authority survives.
- Centralization is fine for convenience; it is not allowed to be the *final authority*.
- **Amendment (from review):** the account must also remain *reachable and executable* without the server. An authority that survives but cannot be used is inert. Usability of an authority = how many executors honor it, not whether one app survives. On a public network (Starknet) this holds natively; in a fiat-only flow it is a real debt (see E3).

`[x]` confirmed (with amendment)

---

## C. Architecture (the skeleton)

### C1. It is a permission operating system, not a collection of gates
- The core understands only: **user → agent → action → resource → policy → decision**.
- It handles: user-owned accounts, agent session keys, policy evaluation, approvals, expiry/revocation, audit records.
- The core does NOT know what a "flight," "printer paper," or "EC2 instance" is.

`[x]` confirmed (provisional)

### C2. Gates are plugins
- Each vertical (purchase, travel, cloud, data...) registers its own schema: resources, actions, policy fields, approval requirements.
- Namespacing keeps them from leaking into each other: `anchor:purchase`, `travel:book`, `cloud:provision`.
- A new gate type never makes the platform useless — it plugs in if it follows the contract.

`[x]` confirmed (provisional)

### C3. Integration is an SDK at the point of action
- Developers don't rebuild their apps around the platform.
- They wrap sensitive actions: `authorize({user, agent, action, resource, context})` → ALLOW / DENY / ASK_USER.
- Their app keeps its own UI, domain objects, and business logic.

`[x]` confirmed (provisional)

### C4. Never trust the model's claim about what it is doing
- The action/resource must be derived from the actual tool call or API route — not from LLM text output.
- The agent can *say* "this is just a deploy"; the gateway checks what the deploy tool was actually invoked with.

`[x]` confirmed (provisional)

### C5. Every vertical shares the same four screens
1. **Mandate** — what the agent may do.
2. **Proposals** — what the agent wants to do now.
3. **Approvals** — what needs the user's yes.
4. **Audit** — what happened, under which rules, who approved.
- The UI language changes per vertical; the authority model does not.
- (2026-10-25: Layer D added a fifth screen, **Résumé** — what the agent has earned,
  read from signed records and the chain, with ladder changes signed in the browser.)

`[x]` confirmed (provisional)

---

## D. Agent identity & reputation

### D1. Portable agent identity = ID card + résumé for agents
- Problem today: an agent is a stranger in every new app; trust cannot transfer.
- The layer gives an agent: stable identity, named owner, verifiable history, proofs other apps can check.
- Owner field is a disclosure dial: pseudonymous by default; revealed per-app only when accountability requires it; consent-logged.

`[x]` confirmed

### D2. An agent carries proofs, not people
- Portable: agent identity, agent reputation (selectively).
- NOT portable: user personal data, credentials, purchase history, private messages.
- Mechanisms: per-user sessions, no shared private memory, scoped credentials, selective disclosure ("over 18 = true", not the birthdate), consent logs, revocation, separate storage.

`[x]` confirmed

### D3. Cold start: a new agent is "unknown", not untrusted
- New agent gets: identity verified, propose-only, $0 money limit, approval required for everything, short sessions.
- Onboarding modes: shadow mode (proposes, cannot execute), sandbox (fake money/tiny caps).
- Receiver-side enforcement: every app defaults unknown agents to minimum permission regardless of operator claims.

`[x]` confirmed

### D4. Graduated autonomy: permissions grow with evidence, not promises
- Ladder: New → Probation → Trusted → Established → (Restricted on violations).
- Bootstrap signals: owner verification, operator attestation, capability credentials, sandbox performance, small live history, stake/bond, vouching. No single signal is enough.
- Evidence is domain-tagged: shopping reputation ≠ travel reputation; each vertical restarts the ladder near the bottom.

`[x]` confirmed

### D5. Reputation is a history of evidence, not one score
- Not "Trust score: 87." Instead: "50 purchases completed, 0 limit violations, 2 refunds, revoked once."
- Each app decides which evidence matters to it (travel app → booking accuracy; shopping app → budget compliance).
- Not public until earned: an agent without sufficient evidence stays private/sandboxed/restricted.
- Raw evidence, not a computed score; signed by the app that witnessed it, so fake histories fail verification.

`[x]` confirmed

---

## E. Starknet's role

### E1. Why Starknet specifically
1. **Native account abstraction** — every account is a smart contract; the user's account itself encodes the policy (caps, allowlists, approval rules).
2. **Session keys** — scoped, time-bounded, revocable delegation for agents, natively supported.
3. **STARK verifiability** — policy checks and reputation updates can be proven, not just logged.
4. **Portability** — identity/permissions tied to an on-chain account, recognizable by any compatible app.
5. **Ecosystem alignment** — Starknet's agentic stack explicitly targets agents with wallets, permissions, and reputation.

`[x]` confirmed

### E2. What Starknet does NOT do (honest boundary)
- It does not make the AI smarter or safer. The gate does that.
- It only matters when users should not have to trust the company's server.
- If users are happy trusting the app, adding Starknet is pure friction.

`[x]` confirmed

### E3. Enforcement vs audit distinction
- If the money-moving action still runs entirely through the company's API credentials, Starknet is "audit" not "enforcement."
- Real enforcement requires: the account's authorization to be a precondition of execution (account authorizes → payment executes only if valid).
- This is the critical build debt: if Starknet can't be a hard precondition for actual money/action execution, everything above stays "audit only," not enforcement.

`[x]` confirmed

### E4. Quantum angle (background fact, not a build requirement)
- STARK proofs are hash-based → quantum-friendly at the proving layer.
- Caveat: full-stack quantum safety also depends on signatures, bridges, and Ethereum settlement. Account abstraction makes signature migration possible without a fork.

`[x]` confirmed (background)

---

## F. Positioning conclusions

### F1. AnchorGate's role in all this
- It is the **proof that the pattern works** (deterministic gate between untrusted AI proposals and money).
- It is one vertical implementation — not the platform, and not the next build target.

`[ ]` status

### F2. The umbrella category
- Not "AI purchase gates." The category is: **user-owned authorization for AI agents** — identity, mandates, permissions, approvals, reputation.
- Candidate product names from the conversation: "permission OS", "user-sovereign application skeleton", "portable agent identity and reputation layer".

`[ ]` status

### F3. The strongest single-sentence pitches produced
- "The AI is untrusted. The policy is enforced. The user remains in control."
- "AnchorGate is the interface; your account is the gate."
- "One authority engine, many vertical products."
- "An agent carries proofs, not people."
- "Permissions grow with evidence, not with promises."

`[ ]` status

---

## Open questions (not resolved in the conversation)

1. Which of these layers is THE build? (Permission OS core? Identity/reputation layer? A new vertical? The Starknet account contract itself?)
2. Is the target a hackathon project, a grant proposal, or a long-term product?
3. Does the first build need real money movement, or is sandbox/propose-only enough to prove the concept?
4. Who is the first user: end-consumers, or developers integrating the SDK?
