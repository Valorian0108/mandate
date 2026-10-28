# Layer D live run — an agent earns its first step, and Starknet remembers it

**Date:** 2026-10-25
**Network:** Starknet Sepolia
**Result:** 18/18 checks passed. A brand-new agent was held at propose-only, earned
its first step from three sandbox runs, had its evidence fingerprint anchored
on-chain by the owner, and was promoted by an owner-signed change bound to that
exact fingerprint. Editing one record afterward made the evidence file fail
verification.

This is the live record. The machine-readable copy is
`permission-core/.data/demo-layer-d-run.json`; the on-chain anchor is also in
`gate-account/.sepolia/state.json` under `layer_d.anchors`.

---

## The short version

A new agent is not trusted just because an app says it is. It starts at **new**:
every action becomes a proposal. It can practice in a sandbox, where no money
moves and the records say `sandbox-allowed`. Three clean sandbox runs earn a
*suggestion* for the first step. The owner then signs a promotion — but the
promotion is tied to a specific evidence snapshot, and that snapshot's
fingerprint is written to Starknet first.

The chain does not store the records. It stores a **fingerprint**: a Merkle root
and the number of records it covers. The full records stay off-chain. The app
signs the facts; the owner signs ladder changes. If someone edits a record later,
the fingerprint no longer matches, and the promotion stops applying.

---

## The agent

| Field | Value |
|---|---|
| Agent id | `0x01bd3b9f890b7a660ae0158b4e29d548eb0c5c014ef7beaaaddf3088a41941be` |
| Owner (from the chain) | `0x3166ad27f1bedee6af7520d71ee60e1bb3719ab2d26d52fc7fdfc5a3cb4fed0` |
| Purpose | `Layer D demo: book travel within the owner mandate` |
| App witness (signs facts) | `0x1855f8e48996429380080edcce9972b2504ce336e062fddc940b0f7acd075c6` |

The identity is signed by the owner key. The agent id is derived from the owner,
purpose, and nonce — the app does not type an id and then claim it. The witness
key belongs to the app and only signs evidence; it cannot promote the agent or
touch the owner's money.

---

## What happened, step by step

### 1. Cold start: the door asks instead of spending

The agent asked to transfer **5** to the allowlisted merchant. The live mandate
would have allowed it, but the agent had no track record. The door returned:

```
ASK_USER  cold-start
"this agent has no track record yet - every action needs the owner's approval
until it earns a first step"
```

A real proposal was filed for the owner (`48fdef7f88af7601`), and the evidence
record says `asked` — not `executed`.

### 2. Three sandbox runs

Three simulated transfers of 5 were allowed. No value moved. The records are
explicitly labelled:

| Sequence | Outcome |
|---|---|
| 1 | `asked` (the cold-start proposal) |
| 2 | `sandbox-allowed` |
| 3 | `sandbox-allowed` |
| 4 | `sandbox-allowed` |

Sandbox records count toward the **first step only**. They can never earn
`trusted` or `established`; those require real `executed` / `approved` records.

### 3. The evidence fingerprint

The four records were hashed into one Merkle root:

```
count: 4
root:  0x02597520b6aa02a102ef12e361be5c3e24974355d40b4a52828595c4f995125b
```

The root is a 250-bit felt. It is not a score, a rating, or a paragraph of
praise. It is a fingerprint of the exact records.

### 4. The owner anchors it on Starknet

The owner acted through the GateAccount, so the anchorer is the account, not a
company server:

| Field | Value |
|---|---|
| Registry | `0x03484789c7e0212a8ea8a398cb5b92ab9bacb01155db929e117efece9ec7e88c` |
| Anchor transaction | `0x75fcabe5e9aada5bbda0ede33ca12262f7599abc5a1dc343b6f562f03724265` |
| Finality | `ACCEPTED_ON_L2` |
| Read back root | `0x2597520b6aa02a102ef12e361be5c3e24974355d40b4a52828595c4f995125b` |
| Read back count | `4` |
| Anchor count in this slot | `1` |

The read-back is a separate call to the chain, not a copy of what the script
sent. The registry is keyed by `(agent_id, anchorer)`, so this agent's slot
belongs to this GateAccount and no other anchorer can overwrite it. Counts must
strictly increase, so an earlier history cannot be rewritten.

### 5. The owner signs the promotion

The owner signed a ladder change:

```
seq:            1
from -> to:     new -> probation
reason:         three clean sandbox runs, anchored on-chain
evidence root:  0x02597520b6aa02a102ef12e361be5c3e24974355d40b4a52828595c4f995125b
evidence count: 4
digest:         0x038637d9a066292bd498b244a875ed84f108a2b9379b784dcfb06fd2beb1a488
```

When the trust layer reloaded, it recomputed the Merkle root of the first four
records and compared it to the root in the signed change. They matched, so the
stage became **probation**. If the root had not matched, the change would have
been rejected and the agent would have stayed at **new**.

### 6. Probation's limits are real

Probation is not a label. It is a concrete permission profile:

| Request | Answer | Why |
|---|---|---|
| Transfer 5 | `ALLOW` | inside probation's 5-per-call limit |
| Transfer 6 | `ASK_USER` `ladder-cap` | probation allows at most 5 per call |
| Share a file | `ASK_USER` `ladder-share` | sharing needs approval at this stage |
| Delete files | 1 per day | the ladder narrows the company policy from 10 to 1 |

The per-call limit is enforced **before** the spending gate. That matters: the
spending gate mirrors GateAccount and quotes its exact error strings. If the
ladder quietly lowered the cap, the gate would say "GateAccount: amount over
per-call cap" for a transfer the chain would actually allow. Instead the door
says plainly: "this agent's probation stage allows at most 5 per call; 6 needs
the owner's approval."

### 7. Tamper check

The script copied the evidence file, changed one record's amount from 5 to 9999,
and asked the trust layer to load the copy. It refused:

```
evidence-unverified
"the evidence file failed verification: record 0: signature does not verify
against 0x1855f8e48996429380080edcce9972b2504ce336e062fddc940b0f7acd075c6"
```

The original file was untouched. A single edited fact breaks the signature, and
a broken evidence file stops the whole trust state — it does not silently ignore
the bad record and carry on.

---

## What the chain proves, and what it does not

**The chain proves:** this fingerprint existed at this time, anchored by this
GateAccount, and the count only moved forward.

**The signatures prove:** the app witnessed these facts; the owner authorized
this identity and this ladder change.

**The chain does not prove:** that the records are true. A malicious app could
sign false facts. That is why the app is a witness, not an authority, and why
ladder changes need the owner's key. The model separates "what happened" (signed
records) from "what it earned" (owner-signed changes bound to a fingerprint).

Full records stay off-chain because they are detailed and private. The trade-off
is honest: if the records are lost, the fingerprint still proves something
existed, but not what it said.

---

## Honest limits (not hidden)

- **Testnet keys only.** The owner key in this run is a harness key. Production
  owner keys belong in an embedded wallet (Privy), not a JSON file.
- **The app witness key is generated per run and kept in memory.** The
  witness-key *mechanism* now exists (Track 3, 2026-10-26): owner-signed
  attestations make a key rotation legitimate history instead of a red flag,
  and per-app isolation comes free with them — the console's Track-record
  screen has the vouch/rotate card, and every signed record verifies against
  the attestation that was in effect when it was made. What this demo still
  lacks is production key *storage*: the witness dies with the process.
- **The console's Résumé screen now exists** (screen 05, `SCREENS.md`) and reads
  exactly these signed records plus the chain. On 2026-10-25 it was used live to
  promote this demo agent one further step (`probation → trusted`, ladder step 2,
  signed in the browser), so the ladder file now carries two changes and the agent
  reads `trusted`. Re-running the demo creates a fresh agent and does not reuse
  these files' agent.
- **The demo itself still signs its promotion in Node** with the harness owner key;
  the browser-signed path is the console's, not the demo script's.
- **The anchor step in this demo script is a labelled harness action.** `owner-tx.mjs`
  submits it with the testnet owner key on disk. (Update, 2026-10-25: the console's
  Résumé anchor button no longer uses this path — the browser signs the anchor
  transaction and the server only relays the bytes; see `SCREENS.md`.)
- **Promotions are suggestions until the owner signs.** Three strikes only
  *suggest* `restricted`; they do not move the agent automatically.
- **Sandbox records are not real experience.** They count only toward the first
  step. Real `executed` / `approved` records are required above probation.
- **The registry stores a fingerprint, not the evidence.** Availability and
  privacy of the full records are the app/owner's responsibility.

---

## Reproduce it

```
cd "C:\Users\USER\demi the builder\permission-core"
node scripts/demo-layer-d.mjs
```

The script reads the owner key from `gate-account/.sepolia/state.json`, reads the
owner public key from Sepolia, creates a fresh agent identity and witness, runs
the steps above, anchors through `gate-account/tools/owner-tx.mjs`, verifies the
read-back, and writes:

- `permission-core/.data/demo-layer-d-identity.json`
- `permission-core/.data/demo-layer-d-evidence.json`
- `permission-core/.data/demo-layer-d-ladder.json`
- `permission-core/.data/demo-layer-d-run.json`
- a new entry in `gate-account/.sepolia/state.json` under `layer_d.anchors`

It exits non-zero if any check fails. A run that "looked fine" but skipped a
check is not evidence.

---

## Test counts at this point

| Suite | Count | Status |
|---|---|---|
| JS (`node --test` in `permission-core`) | 165/165 | passing |
| Cairo (`snforge`, GateAccount + EvidenceRegistry) | 24/24 | passing |

(At the time of this demo run the JS suite was 137/137; it has since grown by the 28
browser-signing/relay tests of NEXT.md track 1 — see `SCREENS.md`.)

The JS suite includes 91 Layer D tests: identity signatures, evidence
tampering, Merkle proofs for tree sizes 1–7, sequence gaps, future dates,
ladder thresholds, owner-signed transitions, root binding, cold start, stage
caps, witness mismatch, the door's `sandbox` / `commit` behavior, thirteen
résumé-control tests (stage recomputed from signatures; forged, rotated,
stale-snapshot, illegal, foreign and mis-sequenced ladder writes refused;
anchor written once and never recorded when reverted), and — Track 3 — 12
witness-attestation primitives plus 17 rotation-integration tests (a
rotated-out key cannot sign, old records still verify, a foreign witness is
refused, per-app isolation, and every console refusal).
