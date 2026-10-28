# Track 3 — Witness keys that can live a real life

**Status:** CODE-COMPLETE 2026-10-26 — built test-first, 284/284 JS pass,
0 skipped (see "Outcome" at the bottom); the live browser attestation joins
step-10's browser list. Spec: `NEXT.md` §3
("Witness keys that can live a real life"); product context: `product-shape.md`
item 2. House rules apply (`NEXT.md` "House rules for all tracks"): every new
control gets an OBS-08 test, no crypto constant from memory, live proof before
"done" (a skipped check is announced), and what we learn lands in these files.

## The problem, in plain words

An agent's track record (its "résumé") is a list of signed facts. Each fact is
signed by an **app witness** key — the key of the app that watched the agent act.
Today the code assumes **one** witness key per agent, forever:

- `trust.mjs load()` refuses the whole file if any record's witness is not the
  single current key (`evidence-witness-mismatch`).
- The résumé endpoint (`server.mjs`) returns `witnesses: [unique keys]`.
- `app.js` shouts a red danger callout when `witnesses.length > 1`
  ("One app saw all of this, or the file has been assembled from somewhere else").

But **real apps rotate keys** — after a leak, on a schedule, or when a service is
re-provisioned. An honest rotation leaves a history with *two* witness keys. Under
today's code that honest history looks like an attack. That is the bug Track 3 fixes.

## The fix: owner-signed witness attestations

A **witness attestation** is a small owner-signed statement:

> "Witness key `W` speaks for agent `A` from time `T`, superseding key `W_prev`."

The owner is the same key the chain reports (`get_public_key` on the GateAccount) —
the same authority that signs an agent's identity and its ladder promotions. So a
rotation is not a red flag; it is **legitimate, owner-signed history**. This is the
same hybrid model as everything else in Layer D: signatures off-chain, the chain
holds fingerprints (and on-chain registration of attestation fingerprints is an
explicit *later* option, not required for v-next).

### Attestation shape (mirrors the ladder change, `ladder.mjs`)

```
{
  version: 1,
  kind: 'witness-attestation',
  agentId,        // the agent/app this witness speaks for (hex felt)
  seq,            // 1, 2, 3… per agent (append-only chain)
  witness,        // the witness PUBLIC key being attested (hex felt)
  supersedes,     // the previous witness public key, or null for the first
  validFrom,      // ms epoch: this key speaks for the app FROM this time
  reason,         // a plain sentence (why the rotation happened)
  at,             // ms epoch: when the attestation was made
  owner,          // the owner PUBLIC key (hex felt) — signer
  signature       // { r, s } over the attestation digest
}
```

`witnessAttestationDigest(att)` = `hashToFelt({ v:1, kind:'layer-d:witness-attestation',
agentId, seq, witness, supersedes, validFrom, reason, at, owner })` — same
`hashToFelt` (sha256 → 250-bit felt) the identity/evidence/ladder digests use. No
new curve constant; `signDigest`/`verifyDigest` come from `evidence.mjs`.

### Signing scheme (deliberate decision)

`verifyWitnessAttestation(att, ownerPublicKey, context)` mirrors
`verifyLadderChange` — it is **context-aware**, so it accepts BOTH:

- `digest-v1` (raw ECDSA over the digest) — what headless tests and scripts use; and
- `wallet-snip12-v1` / `snip12-v1` (typed-data) — what the **browser wallet** signs.

This matters because of the phase-6 handover (see "Key finding" below): the owner
key is now the user's Ready X wallet, so a *live* attestation must be signable the
same way a live ladder promotion is — in the browser, via the wallet. The spec says
"in the same style as the identity"; conceptually it is (the owner vouches for a
key), but the signature transport follows the ladder so the browser owner can
actually produce one. `context` for an attestation is
`{ kind: 'witness-attestation', accountAddress: <gate>, chainId }`.

### The chain and "valid at the time"

Attestations for one agent form an append-only, seq-ordered chain, each
`supersedes`-linked to the previous witness (first one has `supersedes: null`).
`createAttestationStore` enforces, on append and on `verifyAll`:

- seq is contiguous per agent (1, 2, 3…);
- `supersedes` equals the previous attestation's `witness` (an unbroken chain);
- `validFrom` is non-decreasing along the chain;
- each is owner-signed;
- not dated in the future.

The **attestation in effect at time `T`** is the one with the greatest
`validFrom <= T`. A record verifies iff its `witness` equals the witness of the
attestation in effect at the record's `at`. This gives the four proof properties
directly:

- *Rotated-out key cannot sign new records* — a record dated after the rotation
  carries the old witness, but the attestation in effect is the new key → refused.
- *Old records still verify after a rotation* — a record dated before the rotation
  is checked against the attestation that was in effect *then* (the old key).
- *A foreign app's witness is refused* — no attestation in this agent's chain
  names that key, so no record bearing it can match the attestation in effect.
- *Per-app isolation* — an attestation binds a key to one `agentId`; a key attested
  for agent A is not in agent B's chain, so it cannot sign into B's history.

### Backward compatibility (deliberate decision)

The 254-test suite (and the live demo agent `0x00a852fe…`) construct trust with a
single witness and **no** attestations. Attestations are therefore **additive**:

- **No attestation store / empty chain** → legacy behavior: exactly one witness
  across all records is accepted (the current single-witness assumption). Two or
  more witnesses with no chain is still the contradiction it is today.
- **Attestations present** → every record must be covered by the attestation in
  effect at its `at`; the chain must verify. A witness that appears in records but
  is not in the chain is refused (named, never averaged away).

This keeps every existing test green and makes rotation a new, tested capability
rather than a rewrite that breaks the demo.

## Key finding (recorded, not assumed): the owner key is now the browser wallet

The phase-6 handover rotated the GateAccount's owner from the pasted testnet key to
the user's **Ready X wallet** key (`0x4fb24b55…e7d2`); the pasted key is HISTORICAL
and its private key is deleted-by-design. Consequences for Track 3:

1. **Headless tests** use a synthetic owner key (as `resume.test.mjs`,
   `trust.test.mjs` etc. already do) — the whole mechanism is provable with zero
   network and zero browser. This is the primary proof and it needs nothing from
   the user.
2. **A live, owner-signed attestation** (like a live ladder promotion, and like the
   step-10 wallet-signed relay) can only be produced **in the browser** with the
   Ready X wallet. So the *live* Track-3 demo shares step-10's browser dependency;
   it is not blocked on anything else, and it is not required for the mechanism to
   be correct or tested.
3. **Pre-existing:** `scripts/demo-layer-d.mjs` signs the demo identity/ladder with
   `state.keys.owner.private_key` (the pasted key) and then checks it against the
   chain owner (`chainOwnerPublicKey`). Post-handover those differ, so re-running
   that demo as-is would fail its own "owner key read from Sepolia matches the
   recorded owner" check. This is a consequence of the handover, independent of
   Track 3, and is noted here so it is not mistaken for a Track-3 regression. The
   fix (re-run the demo with the browser owner, or point the demo at an injected
   owner) belongs to the live-demo pass, alongside step-10.

## Plan (test-first, as always)

1. **`src/attestations.mjs`** (new): digest, validate, sign, verify,
   `createAttestationStore` (append/list/verifyAll with the chain rules),
   `witnessChain(...)` (walk + verify the chain, return the witnesses in effect and
   any rejected link), and `witnessForRecord(record, chain)` (the attestation in
   effect at `record.at`, and whether the record's witness matches it).
2. **`tests/attestations.test.mjs`** (new, OBS-08): the primitive (sign/verify raw +
   wallet scheme, tamper refuses), the store (seq/supersedes/validFrom/future/no-
   owner-signature each refuse), and the four proof properties above, each as the
   ONLY thing between a plausible forgery and an accepted record.
3. **`src/trust.mjs`**: accept an attestation source; replace the single-witness
   check with attestation-based verification (backward compatible); `record()`
   refuses to sign with a superseded (rotated-out) witness.
4. **`src/sdk.mjs`**: thread the attestation path/store through `createClient`.
5. **`web/server.mjs`**: `loadTrustView` loads + verifies the chain and returns
   `witnessHistory` (who spoke for the app, when, which records each covered);
   the red flag fires only for records NOT covered by a valid chain. Add
   `/api/witness/attest` mirroring the ladder-sign endpoint (browser owner signs,
   server verifies against the chain-read owner and appends).
6. **`web/app.js`**: `resumeEvidenceCard` renders the witness history (a timeline)
   instead of the single-witness assumption; the danger callout is reserved for a
   genuine uncovered-witness problem.
7. **Docs**: `README.md` + `DEMO-layer-d.md` (witness-key management now built:
   rotation, per-app isolation), `observations.md` (a new OBS entry), and this file
   with the outcome; `TEST-RESULTS.md` reproduce counts.

## Proof (from the spec — what "done" means)

- A rotated-out key cannot sign new records. ✔ tested headless
- Old records still verify after a rotation. ✔ tested headless
- A foreign app's witness is refused. ✔ tested headless
- The résumé shows the history honestly (multiple witnesses + valid chain = no red
  flag; an uncovered witness = named problem). ✔ tested headless
- Live, owner-signed rotation in the browser — deferred with step-10 (browser
  dependency), announced, never silently skipped.

## Outcome (2026-10-26): code-complete, 284/284 green

Everything in the plan above is built and tested: **284/284 JS tests pass,
0 skipped** (266 before this track's integration file + signer cross-check;
snforge 45/45 unchanged), style gate PASS. What shipped:

- **`src/attestations.mjs`** — digest, validate, sign, context-aware verify,
  the append-only store (contiguous seq, unbroken `supersedes`, non-decreasing
  `validFrom`, never future-dated), the chain walk and the record-coverage
  check. 12 primitive tests (`tests/attestations.test.mjs`).
- **`src/trust.mjs`** — loads the chain when present, verifies every record
  against the attestation in effect at the record's own timestamp, and
  `record()` refuses to sign with a rotated-out key (fails at the source
  instead of poisoning the evidence file). No attestation file → the legacy
  single-witness behavior, byte for byte (pinned, incl. the synthetic
  `seq: 0` history entry).
- **`web/server.mjs`** — the résumé returns `witnessHistory`;
  `/api/witness/preview` + `/api/witness/attest` mirror the ladder endpoints
  (the server builds the attestation from the signed state, the browser
  recomputes the digest and refuses on mismatch, the server verifies against
  the chain-read owner key and re-checks coverage at apply).
- **`web/app.js`** — the résumé's evidence card renders the witness timeline;
  a new owner card ("Vouch for the app witness" / "Rotate the app witness")
  with the preview → digest-match → sign flow; a connected wallet now fills
  the ladder AND witness signer slots on the résumé (route-guarded),
  disconnect releases only what the wallet filled, a pasted key is forgotten
  after signing while a wallet slot stays armed, and "Read again" re-arms the
  wallet slots instead of forcing a re-prompt.
- **`web/signer.js`** — `witnessAttestationDigest`, the browser twin of the
  server digest, with a drift test in `tests/signer.test.mjs` covering every
  attestation shape (genesis `supersedes: null`, string numbers, padded and
  uppercase felts, unicode reasons, key order) plus tamper sensitivity and an
  end-to-end sign/verify.
- **`tests/witness-rotation.test.mjs`** — 17 integration tests: the four proof
  properties at the trust level, the console happy paths (legacy view,
  server-built preview, first vouch backdated to the earliest record, an
  honest two-key rotation, the wallet typed-data path end to end), and the
  refusals (unvouched key, broken chain, forged owner, wrong key, foreign
  agent, edited attestation, stale seq, orphaning records at preview AND at
  apply, same-key rotation however spelled, thin reason, malformed key,
  future dating, backward time).

### The latent bug Track 3 flushed out (fixed, pinned)

`createLadderStore` / `currentStage` verified ladder signatures **without** the
typed-data context, so a wallet-signed (`snip12-v1`) ladder change was refused
by the store even though the endpoint had just verified it — and a promotion
applied through a context-less store would have been invisible to
`currentStage`. Post-handover (owner key = the Ready X wallet) that is the
ONLY way an owner can sign, so every live promotion would have broken. Fixed
additively (optional `context` param, threaded from the server exactly like
the attestation store's); the last test in `witness-rotation.test.mjs` is the
regression pin: the same envelope is refused without context and accepted
with it, at store, `currentStage` and endpoint level.

### Repair design: a mismatch is what an attestation repairs

`evidence-witness-mismatch` (a record no attestation covers) is not a dead
end — vouching for the key is the repair. So `loadTrustView` accepts
`{ tolerateWitnessMismatch: true }` and returns the refusal **alongside the
full verified view**; only the two witness endpoints use it, and only for
exactly that error (guard: any other refusal re-throws as a hard stop).
Identity, evidence, ladder and broken-chain refusals stay hard everywhere;
the résumé and the ladder endpoints stay strict. Tested: in the refused
state, preview works and an attestation with an explicit `validFrom`
re-covers the records, turning the résumé green again.

**Accepted gap (Track-4 follow-up):** the résumé screen shows a full-screen
error card when `!ok`, so today the mismatch repair is API-only (tested);
there is no repair button in the UI. Recorded here rather than papered over.

### What the test run itself caught

The first draft of the honest-rotation test backdated the rotation's
`validFrom` *behind* a record the old key had already signed — two keys
claiming to speak for the app at the same moment. The coverage check refused
it, correctly: the implementation was right and the test's timeline was
dishonest. Fixed by modeling a real handover (rotation effective after the
last old-key record; the new key's clock past the handover). Recorded because
it is the mechanism catching the test author's own sloppy timeline — exactly
the job it is for.

### Still open for "done"

The live, owner-signed attestation through the browser (Ready X) — joins
step-10's browser list, announced. And the pre-existing `demo-layer-d.mjs`
re-run issue (pasted key now historical) is unchanged; its fix belongs to the
browser pass.
