# permission-core — the permission engine (Layers C and D)

The company-side brain that the on-chain lock (Layer E, `../gate-account/`) plugs into.
Plain-language summary of what this is and why it exists: `../layer-map.md` → Layer C.

## The one idea

An app asks permission in one place, and the answer comes from the user's real rules —
not from the app's own database:

```js
import { createClient } from 'permission-core';   // the whole public surface

const client = createClient();
const { mandate } = await client.loadMandate();    // the user's rules, read off Sepolia

const result = await client.execute({
  user: 'user:sepolia:gate_owner',
  agent: 'agent:session:0x100d...',
  action: 'spend:transfer',                        // namespaced: 'domain:verb'
  resource: `token:${mandate.token}`,
  context: { recipient: '0x079e...', amount: 5, token: mandate.token },
});
// ALLOW       -> { allowed: true, decision }             the app proceeds with its own tool call
// DENY/ASK    -> { allowed: false, decision, proposal }  the block waits for the owner
```

Under the hood it is the same standard question every time:

```js
{ user, agent, action, resource, context } -> { verdict: 'ALLOW' | 'DENY' | 'ASK_USER', code, reason }
```

`reason` is ALWAYS a plain sentence a user could read. `context` holds only structured
facts from the actual tool call (C4) — never prose describing intent.

## Rules baked into the core (and why)

- **Deny by default.** An action whose domain has no registered gate is DENIED. Same
  philosophy as the on-chain merchant allowlist (DESIGN.md deviation #4).
- **C4.** The decision comes only from structured fields (`context.amount`,
  `context.recipient`) — never from model-produced prose. There is no parameter
  through which an AI's *description* of its intent could be judged (test s8).
- **A broken gate is a loud DENY.** A gate that throws, returns an unknown verdict,
  or forgets the plain-word reason produces `DENY / gate-misbehaved`, never a
  silent pass (test e4, OBS-08).
- **The split.** The engine is the fast off-chain half; the on-chain account stays
  the final authority. The spending gate therefore *mirrors* GateAccount's checks in
  the contract's order and quotes its exact error strings — it predicts the lock, it
  doesn't replace it. Gates without a lock must declare `advisoryOnly: true`.

## The front door — exactly four functions

```js
const client = createClient();   // -> { loadMandate, decide, propose, execute }
```

- `loadMandate()` — a fresh read of the live mandate off Sepolia. `decide` caches it until
  the next `loadMandate()`.
- `decide(request)` — verdict only. No writes, no surprises.
- `execute(request)` — the point-of-action call: decide; ALLOW means the app proceeds with
  its own tool call, anything else becomes a proposal automatically.
- `propose(request)` — the explicit version of the same; refuses an ALLOWED request in
  plain words rather than filing a pointless proposal.

The package entry is the door (`"exports": { ".": "./src/sdk.mjs" }`); the module exports
only `createClient`, and the returned client is frozen. The README's import specifier is
tested literally (`import { createClient } from 'permission-core'` resolves by name via
Node's package self-reference), so packaging cannot silently break. Defaults are the live
Sepolia reader and the same append-only proposal file the console reads
(`.data/demo-proposals.json`) — so a block raised by **any** app appears in the owner's
Approvals screen. Injection points (`readMandate`, `readOwnerKey`, `storePath`, `gates`,
`policies`) exist for tests and for companies running their own chain reader. A gate with
lying paperwork cannot enter through the door: `createClient` throws at construction.

## Layer D — identity, evidence, and the ladder

Layer D answers a different question from Layer C: not "may this agent do this?"
but "should this agent be allowed to do more than a brand-new one?" It is
optional — without an identity the door behaves exactly as Layer C.

```js
const client = createClient({
  identity,                  // owner-signed: agentId, owner, purpose, nonce
  witnessPrivateKey,         // the app's key; signs facts, never the owner key
  evidencePath: '.data/evidence.json',
  ladderPath: '.data/ladder.json',
  attestationPath: '.data/attestations.json', // optional: owner-signed witness-key history (Track 3)
});

const simulated = await client.execute(request, { sandbox: true });
// ALLOW -> records 'sandbox-allowed'; no value moves.

const real = await client.execute(request, {
  commit: async () => ({ txHash: '0x...' }),
});
// Only a receipt turns an ALLOW into 'executed'. No receipt, no claim.
```

- **Identity** is signed by the owner key the chain reports. The agent id is
  derived from owner + purpose + nonce, not typed by the app.
- **Evidence** records the raw facts of one action (action, amount, recipient,
  code, reason) and is signed by the app witness. It is never a score or a
  paragraph.
- **The app witness can rotate** (Track 3, optional). With no attestation file
  the legacy single-witness rule holds exactly as before. With one, the owner
  signs attestations ("key W speaks for this app from time T, superseding
  W_prev"), each record verifies against the attestation in effect *when it was
  made*, a rotated-out key cannot sign new records, and a key no attestation
  names is refused by name — so an honest rotation is legitimate history, not a
  red flag. Per-app isolation comes free: an attestation binds a key to one
  agent. See `../track3-witness-rotation.md`.
- **The ladder** is five concrete permission profiles: `new` (propose-only),
  `probation` (5/call, 20/window, 1 delete/day), `trusted` (the live mandate,
  3 deletes/day), `established` (the live mandate, 10 deletes/day, sharing),
  `restricted` (propose-only). Sandbox records count only toward the first step;
  real `executed` / `approved` records are required above it.
- **Promotions are owner-signed and bound to an evidence root.** The owner signs
  `(from, to, evidenceRoot, evidenceCount, ...)`; `currentStage` recomputes the
  Merkle root of that prefix and refuses a change whose root no longer matches.
- **The chain is a witness, not a database.** `EvidenceRegistry` stores only a
  Merkle root + count per `(agent_id, anchorer)`, and counts strictly increase.
  The owner anchors through the GateAccount. Full records stay off-chain;
  signatures establish truth, the chain establishes that the fingerprint existed.

The live run (2026-10-25): a new agent was asked at cold start, produced three
sandbox records, had root `0x025975...` anchored on Sepolia
(`0x75fcabe5...`), was promoted to `probation` by an owner-signed change bound to
that root, was stopped at 6 per call while 5 was allowed, and a single edited
record made the evidence file fail verification. Record: `DEMO-layer-d.md`.

## What's here

| File | What it is |
|---|---|
| `src/engine.mjs` | The core: gate registry + `decide()`. Imports no gates — pluggability is the layer's "done when". |
| `src/sdk.mjs` | The front door: `createClient` → exactly `loadMandate / decide / propose / execute`. Hides the engine, gates, reader and store; exports nothing else. |
| `src/gates/spending.mjs` | Gate #1 (`spend:*`), mirroring the contract proven live on Sepolia. |
| `src/gates/files.mjs` | Gate #2, a deliberately different toy domain (`files:*`) proving a second gate plugs in without touching the core. Also demonstrates `ASK_USER`. |
| `src/mandate-reader.mjs` | Reads the LIVE mandate off Sepolia (zero deps, plain JSON-RPC to Cartridge). Cross-checks the local registration record against the chain and refuses to guess if they drifted. |
| `src/evidence.mjs` | Layer D's off-chain half: owner-signed identity, app-signed evidence records, Merkle root/proof, and an append-only store that rejects sequence gaps, bad signatures, and future dates. |
| `src/ladder.mjs` | Five stages with concrete permission profiles, evidence thresholds, owner-signed ladder changes bound to an evidence root/count, and `currentStage` which recomputes that root. |
| `src/trust.mjs` | The glue the door consults first: cold start, stage caps, files overlay, and conservative evidence recording (`executed` only with a receipt; sandbox labelled). |
| `../gate-account/src/evidence_registry.cairo` | The on-chain fingerprint: Merkle root + count per `(agent_id, anchorer)`, strictly increasing counts. 7 snforge tests. |
| `src/proposals.mjs` | The proposal flow: blocked/deferred actions become proposals; only a signature from the **owner key read from the chain** can resolve one (execute-once / amend / decline). Digests bind the signature to the exact request + resolution, so approvals can't be replayed or hand-edited. |
| `src/resolutions.mjs` | Pure converter: a RESOLVED proposal → the exact wire-level calls (`{to, entrypoint, calldata}`) + `sideEffects` warnings the UI must show **before** signing (e.g. v0.2's window restart on `set_spending_policy`). Refuses pointless/impossible amendments and never touches the network. |
| `src/gate-schema.mjs` + `GATE-FORMAT.md` | The gate registration format: the paperwork every gate carries (actions, context fields, codes, approvals, on-chain lock), validated at registration and cross-checked against behaviour by tests. |
| `scripts/demo-cap-raise.mjs` | The live end-to-end demo: engine DENY → proposal → owner-signed amendment → **real owner transaction on Sepolia** → chain re-read → engine ALLOW → agent retry succeeds on-chain. Record: `DEMO-cap-raise.md`. |
| `scripts/demo-layer-d.mjs` | The live Layer D demo: cold start → three sandbox records → **real anchor on Sepolia** → owner-signed promotion → probation limits → tamper check. 18/18 self-checks. Record: `DEMO-layer-d.md`. |
| `examples/toy-app.mjs` | The second toy app: a whole application in one file whose only import is the door. Proves the SDK is sufficient, not just present. Record: `DEMO-toy-app.md`. |
| `tests/engine.test.mjs` | 16 unit tests. Every control has a test where it is the ONLY thing standing between the agent and an otherwise-allowed action (OBS-08). |
| `tests/proposals.test.mjs` | 11 tests incl. the theater test (p5: a valid signature from the wrong key must NOT approve), tamper (p7), cross-resolution replay (p8), double-resolve (p9), and a live test where the real agent key is rejected and the real owner key accepted — with the owner key fetched from Sepolia at verification time. |
| `tests/resolutions.test.mjs` | 9 tests pinning the wire format (transfer + set_spending_policy + allow_recipient calldata), u256 splitting above 2^128, and the refusals (cap not raised, cap > window, PENDING/DECLINED, unknown kind, token mismatch). |
| `tests/gate-schema.test.mjs` | 10 tests: both shipped gate documents valid, 25 broken documents rejected with readable errors, engine refuses gates whose paperwork contradicts their code (and the namespace stays deny-by-default), plus behaviour cross-checks proving each document's `codes` and required context fields equal what the gate actually does. |
| `tests/sdk.test.mjs` | 10 tests holding the door to its promise: exactly four functions and one module export; the package name resolves to the same door; the toy app imports nothing else (static check); ALLOW leaves no proposal, DENY/ASK_USER writes one in the console's own store format; mandate caching; prose changes nothing (C4); a lying gate cannot enter. |
| `tests/live-alignment.test.mjs` | Replays the three real Stage 2 transactions against the live chain state and asserts the engine's verdicts match what Starknet actually did. Skips loudly if offline — never a silent pass. |
| `tests/evidence.test.mjs` | 15 tests: identity signatures, fact tampering, witness mismatch, Merkle proofs for trees of size 1–7, proof replay, sequence gaps, future dates, and append-only store verification. |
| `tests/ladder.test.mjs` | 12 tests: stage thresholds (sandbox counts only for the first step), three-strike restriction, reinstatement, legal transitions, concrete profiles, and owner-signed changes bound to the exact evidence root. |
| `tests/trust.test.mjs` | 22 tests: cold start, wrong owner/witness, tampered evidence, wrong promotion root, probation/trusted/established caps, restricted mode, files overlay, the door's `sandbox` / `commit` behavior, and malformed input being denied rather than thrown. |
| `web/server.mjs` | The console server: `node:http`, static files + `/api/*` (mandate, proposals, preview, resolve, audit, resume, ladder preview/apply, witness preview/attest) and the relay (`/api/tx/plan`, `/api/broadcast`, `/api/tx/receipt`, `/api/anchor/plan`, `/api/anchor/record`) — it re-checks browser signatures against the chain and carries signed bytes verbatim, so it never builds a transaction and cannot substitute one. Owner key never touches it. The old `/api/submit` + `/api/anchor` harness paths remain for the demo scripts, labelled. |
| `web/app.js`, `web/index.html`, `web/tokens.css`, `web/style.css` | The five screens (Mandate · Proposals · Approvals · Audit · Résumé), vanilla JS, Hallmark-designed. See `SCREENS.md`. |
| `web/signer.js` | The browser half of the signing path: recomputes the digest locally so the tab signs what it can see, derives the pubkey and refuses a non-owner key. |
| `web/tx-signer.js` | The browser half of the final hop: compiles calls, computes the invoke-v3 transaction hash and signs it in the page (node-free, served to the page). The hash maths is pinned against starknet.js by drift tests — never typed from memory. The server imports it too, to recompute the hash from the finished RPC body and re-verify the signature before relaying. |
| `tests/server.test.mjs` | 10 console-control tests (each control is the only thing between the agent and an otherwise-successful action). |
| `tests/signer.test.mjs` | 9 tests: browser digest == server digest for every resolution shape, **every ladder change shape and every witness-attestation shape**, tamper sensitivity, browser signature verifies via the server's chain-key check, and a walk of the real served import graph proving no `node:` module reaches the page. |
| `tests/tx-signer.test.mjs` | 7 drift tests: the browser's invoke-v3 hash and signature equal starknet.js's (the oracle, a test-only dependency) for identical calls/nonce/fees, every envelope field is covered by the hash, and the signer refuses to build nonsense instead of signing it. |
| `tests/tx-broadcast.test.mjs` | 21 relay-control tests, each the only thing between an attacker and an otherwise-successful broadcast: byte-identical relay, a validly-signed wrong sender, wrong key, calldata tampered in flight, wrong chain, garbage bodies, state self-disagreement, node errors verbatim with nothing recorded, double-broadcast refusals, receipt-only final statuses, and the anchor's price / already-anchored / lying-claim / once-only / unconfirmed refusals. |
| `tests/resume.test.mjs` | 13 résumé-control tests: the stage is recomputed from signatures; forged, rotated-key, stale-snapshot, illegal, foreign and mis-sequenced ladder writes are each refused; anchoring writes the exact fingerprint once and never records a reverted transaction. |
| `tests/attestations.test.mjs` | 12 witness-attestation primitives (Track 3): the digest, sign/verify (raw + wallet typed-data), the append-only store's chain rules (contiguous seq, unbroken supersedes, non-decreasing validFrom, never future-dated, owner-signed), and the four proof properties — each the ONLY thing between a plausible forgery and an accepted record. |
| `tests/witness-rotation.test.mjs` | 17 integration tests: witness-key rotation end to end. The four proof properties at trust level; console happy paths (legacy résumé, server-built preview, first vouch backdated to the earliest record, an honest two-key rotation, the wallet typed-data path); the refusals (unvouched key, broken chain, forged owner, wrong key, foreign agent, edited attestation, stale seq, orphaning records at preview AND apply, same-key rotation, thin reason, malformed key, future/backward dating); and the regression pin for the latent wallet-context ladder bug. |

## Run it

```
cd "C:\Users\USER\demi the builder\permission-core"
node --test
```

165/165 passing as of 2026-10-25 (75 Layer C + 62 Layer D + 28 for the browser-signed
relay), including live tests against Sepolia (engine↔chain verdict alignment, and
proposal approvals verified against the on-chain owner key).

## The console — five screens, signing in the browser

```
cd "C:\Users\USER\demi the builder\permission-core"
node web/server.mjs        # http://127.0.0.1:4173
```

Mandate · Proposals · Approvals · Audit · Résumé — what the agent may do, what it asked
for, your signature, the record in order, and what the agent has earned. Every figure
on screen is a chain read or a signed record; the owner key is typed into the page and
signs **in the browser** (`web/signer.js`), so the server never holds it. The browser
recomputes the digest before signing and refuses on any mismatch with the server's
preview; the server re-verifies the signature against the owner key read from the chain
at that moment. **The final Starknet transaction is signed in the browser too**
(`web/tx-signer.js`): the server prices a plan, the tab builds and signs it, and the
server only re-checks the signature and relays the bytes verbatim — the tab insists the
node's hash equals the hash it signed, and final statuses are written solely from
receipts read back from the chain (a submission honestly says `BROADCAST` until then).
The Résumé screen recomputes the agent's trust stage from the signed identity, evidence
and ladder records on every read — never from a stored field — and signs ladder changes
and the evidence anchor in the browser the same way proposals are approved.
Design, trust split and honest verification notes (remaining known limits: the pasted
testnet key — track 2 in `../NEXT.md` — and the browser-tooling flakiness recorded as
OBS-11): `SCREENS.md`.

On 2026-10-25 the full console loop ran live twice. First through the labelled harness
path: browser-signed amendment → AMENDED → owner transaction
`0x1492ec9c50a52ef8728941477c9b594a111d01043711a78ba6f046ee957b682` SUCCEEDED (cap
raised to 25). Then, the same day, through the relay that replaced it: ask 30 → blocked
by the live cap 25 → proposal `7c4e86b5b602d1f8` → amend to 30 → digest match →
resolution signed in the tab → **the transaction itself signed in the tab** → relayed
verbatim → the node's hash equalled the signed hash → receipt SUCCEEDED /
ACCEPTED_ON_L2 (`0x7bdea2e5b1d28830d6b4b5d9eddcafba0557be88566a8bf67f94be2f75b0887`)
→ record written from the receipt: SUCCEEDED via `relay`. The chain now reads
**per-call cap 30, spent 0** (the amendment restarted the window, exactly as the
preview warned), window cap 100, calls used 2/10, one allowlisted recipient. A new
amendment must raise the cap above 30 and at most to 100.

The same day the Résumé screen ran live end to end: it read the demo agent's stage
(`probation`) from the signed records and the chain's copy of the evidence fingerprint,
previewed a `probation → trusted` change with a digest-match check and a loud override
warning, signed it in the browser, and applied it after re-verifying against the
chain-read owner key. The agent now reads `trusted`; ladder step 2 binds the same root
the chain holds.

## The live cap-raise demo (the loop, closed on Sepolia)

```
cd "C:\Users\USER\demi the builder\permission-core"
node scripts/demo-cap-raise.mjs
```

Agent blocked at 15 (cap 10) → proposal → owner signs the amendment (verified against the
key read from the chain) → **real owner transaction** raises the cap to 20 → chain re-read
proves it → engine now ALLOWs → **agent's session-keyed retry succeeds on-chain**. Full
record with both transaction hashes, the honest window-restart note, and the BigInt bug the
first run caught: `DEMO-cap-raise.md`.

## The live Layer D demo (trust earned, fingerprint anchored)

```
cd "C:\Users\USER\demi the builder\permission-core"
node scripts/demo-layer-d.mjs
```

A new agent is held at cold start (a real proposal, not a silent spend), runs three
sandbox transfers, has its evidence Merkle root anchored on Sepolia through the
GateAccount, is promoted to `probation` by an owner-signed change bound to that
root, is then stopped at 6 per call while 5 is allowed, and finally has one record
edited — which makes the whole evidence file fail verification. 18/18 checks
passed. Anchor transaction: `0x75fcabe5e9aada5bbda0ede33ca12262f7599abc5a1dc343b6f562f03724265`;
evidence root: `0x02597520b6aa02a102ef12e361be5c3e24974355d40b4a52828595c4f995125b`.
Full record: `DEMO-layer-d.md`.

## The second toy app — proof the door is enough

```
cd "C:\Users\USER\demi the builder\permission-core"
node examples/toy-app.mjs
```

`examples/toy-app.mjs` is a whole application in one file whose only import is
`../src/sdk.mjs` — a test enforces that statically. It reads the live mandate, then makes
three calls through the door. Live run on 2026-10-25:

| Call | Answer | What happened |
|---|---|---|
| transfer 5 | ALLOWED | inside per-call 25 / window 100 / spent 0 |
| transfer 100000 | DENY `over-per-call-cap` | proposal `29dec48f87b015de` |
| share a file | ASK_USER `approval-required` | proposal `08fb9bafe43551ae` |

Both proposals appeared immediately in the console's `/api/proposals` as PENDING, alongside
the earlier ones — the toy app never touched the engine, the store or the digest maths. Full
record: `DEMO-toy-app.md`.

## Deliberately deferred (not v1)

- Real owner keys via a wallet — the Privy Starknet fact-check first, else native
  Argent/Braavos behind the same signer interface (track 2 in `../NEXT.md`). Today's
  keys are throwaway testnet keys pasted into the page. The final transaction itself
  **is** browser-signed as of 2026-10-25; the server is only a relay.
- Category-level merchant rules (needs an attested merchant registry — not part of this
  Layer D; Layer D is agent identity and earned trust).
- Production witness-key **storage**. Witness-key *rotation* and *per-app isolation*
  ARE built as of 2026-10-26 (Track 3): owner-signed witness attestations let an app
  rotate its signing key as legitimate, owner-vouched history instead of a red flag,
  each record verifies against the attestation in effect when it was made, and a key
  no attestation names is refused by name. What the demo still lacks is durable key
  storage — it generates a witness per run and keeps it in memory. See
  `../track3-witness-rotation.md`.
- Auto-pay exact-item lists, paymaster/gasless gas (v1.1).
- A `set_spending_policy` variant that preserves counters (v0.3; today it restarts the
  window, and the preview warns before signing).
