# Layer Map: What Each Layer Needs

**Purpose:** For each layer of the build, what it needs (inputs), what it produces (deliverables), what must be decided, and how you know it's done.
**Build order:** B (concept) → E (lock) → C (engine) → D (résumé) → F (sign).

---

## Layer B — Ownership model (decisions, no code)

**What it is:** The map of who owns what. Must be settled before coding, because everything else follows from it.

**Needs (inputs):**
- Full list of every component in the product (rules, UI, logs, agent keys, approvals, payments...)

**Produces (deliverables):**
- One ownership table: every component marked **Company** or **User**
- The authority list: exactly which items MUST be user-owned (rules, limits, permissions, revocation)

**Decisions to make:**
- [x] Which rule fields go on-chain (cap, categories, allowlist) vs stay in your DB (UI prefs, analytics)? **Anything with authority goes on-chain** — per-call cap, rolling window cap, selector whitelist, merchant allowlist, session-key registry, nonces, evidence fingerprints. The DB holds records and convenience (proposals, evidence details, UI) and is never the authority — the mandate reader refuses to guess when the local record drifts from the chain.
- [x] One account per user, or one account per agent-per-user? **One GateAccount per owner.** Agents hold scoped, revocable session keys inside it — firing an agent never touches the owner's account.

**Done when:** You can point at any feature and say instantly: "company owns this" or "user owns this" — with zero authority items on the company side.

**Status (settled before coding, re-verified 2026-10-25): ✅ DONE — every layer since was built on this table.**
User-owned (all the switches): rules/limits (on-chain, owner-signed changes only), permissions
(session keys: issue/revoke), approvals (owner signature only, re-verified against the key read
from the chain), trust-ladder changes (owner-signed, bound to the exact evidence root), evidence
anchoring (an owner-authorized action), and — from track 2 onward — the owner's signing key
itself, which lives in the owner's wallet, never on our server.
Company-owned (zero authority): the relay, the console UI, the decision engine (a speed layer),
the proposal store, evidence storage. Every one of those can be ignored or replaced without the
user losing control of anything.
Proven by tests, not vibes: the server cannot produce an owner signature; agent/forged signatures
are rejected; an out-of-policy tx is reverted **by the contract itself** even when our own
submitter pushes it (Stage 2, Layer E); a lying wallet cannot forge an approval
(`permission-core/tests/wallet.test.mjs`).

---

## Layer E — Starknet smart account (the lock)

**What it is:** The Cairo contract that encodes the user's policy and physically cannot be bypassed — not by the agent, not by your server, not by you.

**Needs (inputs):**
- Layer B's authority list (what the contract must enforce)
- Cairo toolchain: Scarb (build), Starknet testnet/devnet (deploy & test)
- A base to build on: OpenZeppelin Cairo account contracts (don't write from scratch)
- Wallet UX decision: external wallet (ArgentX/Braavos) vs embedded wallet

**Produces (deliverables):**
- Smart account contract with:
  - Policy storage: monthly cap, allowed categories/merchants, auto-pay allowlist, approval-required default
  - `__validate__` logic: any transaction outside policy is rejected by the account itself
  - Session keys: issue (scoped: allowed actions, spending cap, expiry), revoke
  - Owner-only policy changes (server can suggest, only user signs)
- The E3 decision: how execution binds to the account (see below)

**Decisions to make:**
- [x] **E3 bridge:** server requires a signed Starknet authorization before executing (middle option), or funds held in account-controlled structure (strongest)? **Strongest — and both at once.** Funds live in the GateAccount, which enforces policy itself (Stage 2: the contract reverted out-of-policy txs even when our own submitter pushed them), and every owner action is a signature re-verified against the chain-read owner key. The server is a pure relay of browser-signed bytes.
- [x] Where does the user sign — in your UI (embedded) or an external wallet? **In our UI, but never with a key we hold:** signatures are made in the browser — today with a pasted testnet key (the honest limit written in SCREENS.md), being replaced by the user's real wallet (Argent X first) in track 2. The server never holds the owner key either way.

**Done when:** On testnet, an agent transaction that exceeds policy is **rejected by the contract**, even when your server tries to push it through. That single test proves theater-vs-enforcement is solved.

**Status (2026-10-24): ✅ DONE WHEN MET — on Starknet Sepolia, with receipts.**
Contract built — `gate-account/`, v0.2, compiles clean, **17/17 snforge tests passing** (t17 pins
the JS↔Cairo session-hash agreement). Policy fields delivered: monthly (rolling window) cap,
per-call cap, selector whitelist, per-recipient merchant allowlist, session keys with expiry +
call budget + revocation, owner-only policy changes. Approval-required default is structural: a
session signature simply cannot express anything out of scope, so "ask the user" = "get an owner
signature".

**Update (2026-10-25): Layer E is now v0.3 — 42/42 snforge tests, live-migrated.** Controller-bound
SNIP-9 `execute_from_outside_v2` (owner-level authority a third party can relay — proven live, tx
`0x4a26c6b1...dfc5`) + owner-gated `upgrade` (in-place class changes preserve state; the migration
to gate `0x7d1d8cad...2570f1` was the last redeploy because v0.2 had no upgrade entry point).
Cross-language hash pinning: contract == Cairo mirror == JS == starknet.js (t35 + `snip9-vector.mjs`).
Full record: `gate-account/TEST-RESULTS.md` (v0.3 section), `.sepolia/migration-v3.json`,
`.sepolia/state.json` (`migration_v03`). The v0.2 gate stays live with its history (evidence never
removed).
The former gap — simulation vs live network — is closed. GateAccount is deployed on Sepolia
(`0x2502f82a...73d25`, SRC-5 ISRC6 ✓), the mandate was registered by three owner-signed invokes,
and an agent holding only a session key, signing through our own submitter
(`tools/agent-tx.mjs` — no wallet produces the 4-element session signature):
- transferred 5 tokens to a listed merchant **inside** policy → SUCCEEDED (`0x59e507bb...`);
- tried 50 against a per-call cap of 10 → **REVERTED by the network**: `"GateAccount: amount
  over per-call cap"` (`0x58b47001...`);
- tried 5 to an unlisted recipient → **REVERTED by the network**: `"GateAccount: recipient not
  allowed"` (`0x566f35c9...`).
Reverts consumed no call budget and moved no funds (state read back from the chain). Full record:
`gate-account/STAGE2-agent-tx.md` + `.sepolia/state.json`; lessons in OBS-09.
Deliberately *not* delivered: category-level merchant rules (needs an attested merchant registry —
Layer D), auto-pay exact-item list (v1.1), paymaster/gasless (v1.1). Next: Layer C.

---

## Layer C — Permission core (the engine)

**What it is:** The generic decision engine + the shape every gate plugs into. The company-side brain that coordinates with the on-chain lock.

**Needs (inputs):**
- Layer E's contract interface (what the engine can ask the account)
- The universal schema from the breakdown: `user → agent → action → resource → policy → decision`

**Produces (deliverables):**
- Authorization contract/schema: `{user, agent, action, resource, context}` → `ALLOW / DENY / ASK_USER` with plain-word reasons
- Namespace system: `anchor:purchase`, `travel:book` — gates can't leak into each other
- Gate registration format (resources, actions, policy fields, approval requirements)
- SDK function developers call at the point of action
- The four screens: **Mandate · Proposals · Approvals · Audit** (Layer D later added a
  fifth, **Résumé** — what the agent has earned; see the Layer D block below)
- C4 rule baked in: action/resource derived from the actual tool call, never from model text

**Decisions to make:**
- [x] First gate's domain (what's the first vertical, if not AnchorGate-shaped?) **The spending gate** (`spend:*`) — the domain already proven on-chain in Layer E, quoting GateAccount's exact error strings. Gate #2 `files:*` (toy) proved the plug-in shape with zero core changes.
- [x] Where decisions evaluate: off-chain engine for speed + on-chain account as final authority (the split we agreed) **Confirmed as built:** the engine decides fast (ALLOW/DENY/ASK_USER) and the chain has the final word — an ALLOW the contract dislikes still reverts on-chain.

**Done when:** A second, different gate (even a toy one) plugs in without changing the core — proving it's a permission OS, not a purchase app.

**Status (2026-10-24): PROPOSAL LOOP CLOSED LIVE — core + gates + proposals + on-chain resolutions.**
First-gate decision made: the **spending gate** (the domain already proven on-chain in
Layer E). Built: the decision engine (`{user, agent, action, resource, context}` →
ALLOW/DENY/ASK_USER with plain-word reasons, deny-by-default, C4 baked in — no prose
channel), gate #1 `spend:*` mirroring GateAccount's checks and quoting its exact error
strings, gate #2 `files:*` (toy domain, plugs in with zero core changes, demonstrates
ASK_USER), and a live mandate reader (zero deps) that pulls the real policy off Sepolia
and refuses to guess if the local record drifted from the chain. **Proposal flow built**:
blocked actions become proposals; the only thing that can resolve one is a signature from
the owner key *read from the chain at verification time* (execute-once / amend / decline);
digests bind each approval to the exact request + resolution (no replay, no hand-editing).
**Resolutions now move the chain** (`src/resolutions.mjs` pure call-converter +
`gate-account/tools/owner-tx.mjs` owner submitter): the live cap-raise demo ran end to end
on Sepolia — agent blocked at 15 (cap 10) → proposal → owner-signed amendment → real owner
tx `0x728c64fe...` raised the cap to 20 → engine ALLOW → agent retry `0x414f0ddd...`
SUCCEEDED, counters moved exactly as predicted (`permission-core/DEMO-cap-raise.md`).
**Status (2026-10-25): THE FOUR SCREENS ARE BUILT AND VERIFIED.** The console
(`permission-core/web/`, `node web/server.mjs`) shows the live mandate, turns blocked
requests into proposals, and lets the owner resolve them with a signature made **in the
browser** — the server never sees the owner key, and re-verifies every signature against
the key read from the chain at resolution time. The full loop ran live: browser-signed
amendment → AMENDED → owner tx `0x1492ec9c...` SUCCEEDED; the chain now reads per-call
cap 25 / spent 0 (the amendment restarted the window, exactly as the preview warned).
**74/74 tests passing**, including: engine verdicts match the three real Stage 2 on-chain
outcomes; the theater test (a valid signature from the agent's real key is rejected, the
owner's real key is accepted); wire-format pins for every resolution kind; browser-vs-
server digest equality; and a walk of the served import graph proving the page loads no
Node-only code. The **gate registration format** shipped the same day as a written
spec (`permission-core/GATE-FORMAT.md`) plus a validator (`src/gate-schema.mjs`) the
engine runs at registration - a gate with wrong or self-contradicting paperwork is
refused, and tests cross-check every document against the gate's actual behaviour.
**Layer C is complete:** the **SDK front door** (`src/sdk.mjs`) is the package entry -
`createClient` returns exactly `loadMandate / decide / propose / execute`, writes blocked
actions into the same append-only store the console's Approvals screen reads, and exports
nothing else. The **second toy app** (`examples/toy-app.mjs`) imports only the door and ran
live on Sepolia: transfer 5 ALLOWED; transfer 100000 DENY `over-per-call-cap` → proposal
`29dec48f87b015de`; `files:share` ASK_USER → proposal `08fb9bafe43551ae`; both PENDING in
the console immediately (`permission-core/DEMO-toy-app.md`).
**Status (2026-10-25, later): THE LAST HOP IS BROWSER-SIGNED.** The final Starknet
transaction is now built and signed in the tab (`web/tx-signer.js`, invoke-v3 hash
pinned against starknet.js by 7 drift tests) and the server is only a relay: it
re-verifies the signature against the chain-read owner key, checks sender and chain,
carries the bytes verbatim (`/api/broadcast`), and writes final statuses only from
receipts (21 relay-control tests; suite 165/165, 0 skipped). Proven live on Sepolia:
tx `0x7bdea2e5...b0887` raised the per-call cap 25 → 30, SUCCEEDED / ACCEPTED_ON_L2,
recorded as SUCCEEDED via `relay`. `owner-tx.mjs` remains for the demo scripts,
labelled. Honest limits are written down in `permission-core/SCREENS.md` (the owner
still pastes a testnet key — NEXT.md track 2 replaces it with a real wallet;
browser-tooling flakiness = OBS-11). Deliberately deferred: wallet-held owner keys
(track 2), category merchants (Layer D), auto-pay exact-item + paymaster (v1.1), and a
preserve-counters `set_spending_policy` variant (v0.3).

---

## Layer D — Agent identity & reputation (the résumé)

**What it is:** Stable identity + signed evidence + the ladder. Comes after C/E because there must be real executions to record.

**Needs (inputs):**
- Layer C's decision records (every ALLOW/DENY/ASK with reason)
- Layer E's session keys (identity anchor)

**Produces (deliverables):**
- Agent identity: stable ID, owner field (pseudonymous by default — OBS/disclosure dial), purpose
- Evidence records: signed by the witnessing app, domain-tagged (`shopping: 50 clean`), raw facts not scores
- The ladder logic: stages (New → Probation → Trusted → Established → Restricted) mapped to concrete permissions ($0/propose-only → capped → broader)
- Cold-start default in the SDK: unknown agent = minimum permission, enforced by the **receiver** (OBS-03)
- Privacy walls: per-user sessions, no shared private memory, selective disclosure (OBS/D2)
- Sandbox/shadow mode so the builder can self-train (OBS-04: you are user #1)

**Decisions to make:**
- [x] Where evidence lives: **signed off-chain records + a Merkle root/count anchored on-chain** (the middle option). Full records stay off-chain; the chain proves a fingerprint existed and who anchored it.
- [x] Who signs evidence: **the app signs facts; the owner signs ladder changes.** The app cannot promote its own agent.

**Done when:** A brand-new agent automatically gets propose-only/$0 at the gate, then earns its first ladder step from sandbox records — with every record verifiably signed.

**Status (2026-10-25): ✅ DONE WHEN MET — on Starknet Sepolia, with a live anchor and a live promotion.**
The on-chain half is `gate-account/src/evidence_registry.cairo` + 7 snforge tests
(24/24 Cairo tests total). `EvidenceRegistry` is deployed at
`0x03484789c7e0212a8ea8a398cb5b92ab9bacb01155db929e117efece9ec7e88c`
(class `0x16daed2c...e79e`, declare tx `0x75115472...7bad`, deploy tx
`0x0506801c...24f`). It stores only a Merkle root + count per
`(agent_id, anchorer)`; counts must strictly increase, so each anchorer has an
isolated append-only slot. The owner anchors through the GateAccount, so an anchor
is an owner-authorized action like any other.

The off-chain half is `permission-core/src/evidence.mjs`, `ladder.mjs`, and
`trust.mjs`:
- **Identity:** owner-signed; the agent id is derived from owner + purpose + nonce,
  not typed by the app. A different owner key, an edited purpose, or a changed
  nonce all fail verification.
- **Evidence:** app-witness-signed records of raw facts (action, amount, recipient,
  code, reason), never scores or prose. Merkle proofs verify for trees of size 1–7.
  The append-only store rejects sequence gaps, bad signatures, and future dates.
  A real ALLOW becomes `executed` only when the app supplies a receipt; no receipt
  means no claim. Sandbox runs are labelled `sandbox-*`.
- **Ladder:** five concrete profiles — `new` (propose-only), `probation` (5/call,
  20/window, 1 delete/day), `trusted` (live mandate, 3 deletes/day), `established`
  (live mandate, 10 deletes/day, sharing), `restricted` (propose-only). Sandbox
  records count only toward the first step; real `executed`/`approved` records are
  required above probation. Three strikes only *suggest* `restricted`; three clean
  real actions suggest reinstatement.
- **Owner-signed changes:** a promotion binds `(from, to, evidenceRoot,
  evidenceCount, ...)` and is signed by the owner key. `currentStage` recomputes the
  Merkle root of that prefix and refuses a change whose root no longer matches.
  Editing history after the fact invalidates the promotion, loudly.
- **Trust prechecks:** cold start and stage caps run **before** the domain gate and
  return plainly-labelled `ASK_USER` (`cold-start`, `ladder-cap`, `ladder-window`,
  `ladder-share`, `ladder-delete`). The spending gate therefore never falsely
  quotes GateAccount's cap for a limit the chain does not have. A files overlay
  narrows deletes/sharing to the stage.
- **SDK:** Layer D is optional. With an identity + witness, the same four functions
  (`loadMandate / decide / propose / execute`) gain `sandbox` and `commit`; without
  them the door behaves exactly as Layer C.

**Live run:** a fresh agent (`0x01bd3b9f...941be`) was held at cold start (proposal
`48fdef7f88af7601`, evidence `asked`), produced three `sandbox-allowed` records,
had root `0x02597520...5125b` / count 4 anchored on Sepolia through the GateAccount
(tx `0x75fcabe5...24265`, read back from the chain), was promoted to `probation` by
an owner-signed change bound to that exact root (digest
`0x038637d9...1a488`), was then allowed 5/call but asked at 6 (`ladder-cap`) and
before sharing (`ladder-share`), and finally had one record edited in a copy —
which made the evidence file fail with `evidence-unverified`. 18/18 checks passed.
Full record: `permission-core/DEMO-layer-d.md`; machine-readable run:
`permission-core/.data/demo-layer-d-run.json`; anchor entry:
`gate-account/.sepolia/state.json` → `layer_d.anchors`.

**Console résumé (screen 05), live 2026-10-25:** the same agent's résumé was read in
the browser from the signed records and the chain (stage `probation`, chain holding the
exact fingerprint), a `probation → trusted` change was previewed with a digest-match
check and a loud override warning (the sandbox records had not earned it), signed **in
the browser** with the testnet owner key, and applied after the server re-verified the
signature against the chain-read key and re-checked the bound root/count. Ladder step 2
is on disk binding root `0x02597520...5125b`; the agent now reads `trusted`.

**Tests:** 165/165 JS tests (75 Layer C + 62 Layer D + 28 for the browser-signed
relay) and 24/24 Cairo tests.

**Honest limits / deferred:** the console's anchor button is browser-signed like every
other owner action — the tab signs, the server only relays the bytes (the demo
*script* still anchors through the labelled `owner-tx.mjs` harness); production
witness-key management
(rotation, storage, per-app isolation) is not built; full records remain off-chain, so
losing them loses the details even though the fingerprint survives; the keys are
testnet keys. Category-level merchant rules still need a separate attested merchant
registry — that is not this layer.

---

## Layer F — Positioning (the sign)

**What it is:** Name, pitch, first-user decision. Last, because you pitch what exists.

**Needs (inputs):**
- A working E+C+D slice to demo

**Produces (deliverables):**
- The name (category: "user-owned authorization for AI agents")
- One-liner (candidates already banked in breakdown F3)
- The pitch doc: problem → gate → ownership → earned trust
- First-user decision: end-consumers, or developers integrating the SDK?

**Done when:** A stranger understands the product in one sentence and asks "can I plug my agent into it?"

**Status (2026-10-25): NOT STARTED — deliberately last ("you pitch what exists").**
Its first input now exists: `product-shape.md` (two customers, the webpage-is-not-the-product
point, the ordered gap list). Track 4 ("the demo a stranger can understand", NEXT.md) is the
bridge to this layer's done-when test. Name / one-liner / pitch and the first-user decision
come after tracks 2–4.

---

## Cross-layer dependencies (the "doesn't work without" chain)

```
B (who owns) ──defines──▶ E (the lock)
E (the lock) ──enforces──▶ C (the engine)
C (the engine) ──produces records──▶ D (the résumé)
D (the résumé) ──gives the gate more apps to honor──▶ back to C (more plugins)
E+C+D working ──makes pitchable──▶ F (the sign)
```

## Standing open questions (from convo-breakdown.md)
1. Target: hackathon project, grant proposal, or long-term product? — **OPEN (owner's call).**
2. First build scope: sandbox/propose-only enough, or real value movement? — **ANSWERED by the build: both.** Sandbox/propose-only is the cold-start default, and real value movement was proven live on Sepolia (in-policy transfer SUCCEEDED, out-of-policy REVERTED by the contract).
3. First user: consumers or developers? — **OPEN (owner's call).** `product-shape.md` currently assumes infrastructure for builders + a reference console, which leans developers — but the decision is not recorded as made.
4. E3 bridge: middle option or strongest option for v1? — **ANSWERED: strongest** (see Layer E decisions — funds live in the policy-enforcing account; the server is a pure relay).
