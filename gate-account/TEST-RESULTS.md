# gate-account test results

> **Latest: v0.3 — 42/42 snforge + 215/215 JS, migrated live to Sepolia 2026-10-25.
> See "v0.3 results" at the bottom.** The v0.1 record below is kept unchanged
> (evidence never removed).

Date: 2026-10-24
Command: `snforge test` (Starknet Foundry 0.64.1, Scarb 2.21.0, Ubuntu 26.04 on WSL2)
Result: **12 passed, 0 failed, 0 ignored**

```
Tests: 12 passed, 0 failed, 0 ignored, 0 filtered out
```

| # | Test | Layer E claim | Result |
|---|------|---------------|--------|
| 1 | owner sets session + spending policy | owner configures the agent | PASS |
| 2 | agent transfers 10 (cap 10) | agent can spend within mandate | PASS |
| 3 | agent transfers 11 (cap 10) | per-call cap enforced in `__execute__` | PASS |
| 4 | agent spends past window cap (25) | rolling window cap enforced | PASS |
| 5 | agent calls `add_or_update_session_key` | agent cannot raise its own limits | PASS |
| 6 | agent calls `set_public_key` | agent cannot take over the account | PASS |
| 7 | owner revokes, agent retries | revocation takes effect immediately | PASS |
| 8 | session expires, agent retries | expiry enforced in `__validate__` | PASS |
| 9 | `max_calls` exhausted | call budget enforced | PASS |
| 10 | owner performs policy/session/revocation | owner keeps full control | PASS |
| 11 | spend with no policy for token | deny-by-default | PASS |
| 12 | signature claims longer expiry | expiry cannot be extended by the agent | PASS |

## What this does and does not prove

**Proven by execution:** given a transaction whose signature is `[session_pubkey, r, s,
valid_until]`, the account rejects:

- amounts above the per-call cap,
- amounts above the rolling window cap,
- any spend on a token with no policy,
- calls to privileged selectors (`add_or_update_session_key`, `set_public_key`, ...),
- sessions that are revoked, expired, or out of call budget,
- a signature claiming an expiry longer than the registered one.

and accepts an in-budget transfer, moving the tokens and consuming one call from the budget.
The message hash binds account, chain id, nonce, expiry and the exact call list, so a captured
signature cannot be replayed for a different call.

**Not proven (by design of v0.1):**

- Not tested on a real network — this is the snforge simulated VM. No paymaster, no real gas,
  no sequencer-level signature semantics.
- `__validate__` sees a protocol-rounded timestamp (±1h), so expiry is precise only in
  `__execute__`.
- Recipient/merchant allowlists are not implemented (selector + amount control only).
- The harness cheats `caller = 0`, tx version, nonce, chain id and signature. Those cheats
  model protocol behaviour; they are not the contract's own code.

## Reproduce

```
wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/run-tests.sh"
```

---

# v0.3 results (2026-10-25) — controller-bound SNIP-9 + owner-gated upgrade

Date: 2026-10-25
Commands: `snforge test` via `scripts/run-tests.sh` (same toolchain as above);
`pnpm test` in `permission-core` (node --test)
Result: **snforge 42 passed, 0 failed, 0 ignored, 0 skipped** · **JS 215 passed,
0 failed, 0 skipped** · live migration to Sepolia verified **11/11 PASS**
(`gate-account/tools/migrate-v3.mjs --verify`)

## The 35 GateAccount tests

t01–t17 are the v0.1/v0.2 suite (session keys, spending policies, allowlists,
revocation, expiry, call budget, owner control, deny-by-default, session-hash
pin) — unchanged and still passing on the v0.3 contract. New in v0.3:

| # | Test | Claim it pins | Result |
|---|------|---------------|--------|
| 18 | outside execution happy path (self-controller) | a real ECDSA signature over the SNIP-9 hash, verified by the contract through the controller's `is_valid_signature`, executes the signed calls | PASS |
| 19 | named caller passes | `caller` binding accepts the exact signed caller | PASS |
| 20 | wrong caller rejected | a different submitter than the signed `caller` is refused (`'ANY_CALLER'` excepted) | PASS |
| 21 | expired window rejected | `execute_before` is exclusive and enforced | PASS |
| 22 | not-yet-valid rejected | `execute_after` is exclusive and enforced | PASS |
| 23 | replayed nonce rejected | one-shot nonces — replay is impossible even with the same valid signature | PASS |
| 24 | substituted calls rejected | changing the calls changes the hash and breaks the signature | PASS |
| 25 | wrong key rejected | a signature from any other key never validates | PASS |
| 26 | session key cannot authorize outside execution | outside execution is OWNER-level authority; a session signature is refused even over the correct hash | PASS |
| 27 | without controller rejected | no registered `wallet_controller` → refusal, not silent acceptance | PASS |
| 28 | refusing controller blocks even a perfect owner signature | verification is truly delegated: a controller that says no means no | PASS |
| 29 | rubber-stamp controller proves delegation | a controller that says yes to everything makes the signature check pass — delegation is real, not decorative | PASS |
| 30 | `set_wallet_controller` requires owner path | stranger/direct call refused | PASS |
| 31 | session cannot set wallet controller | the agent can never point the controller slot anywhere | PASS |
| 32 | session cannot upgrade | class changes are owner-level | PASS |
| 33 | `upgrade` requires owner path | stranger/direct call refused (`'Account: unauthorized'`) | PASS |
| 34 | owner CAN upgrade in place, storage survives | the migration promise v0.2 could not make — from v0.3 on, upgrades are owner-signed actions that preserve state | PASS |
| 35 | outside-execution hash matches the JavaScript vector | mirror == JS literal `0x5f4becd3...6718c` (printed by `tools/snip9-vector.mjs`, itself pinned to starknet.js 10.8.0 in `permission-core/tests/typed-data.test.mjs`) | PASS |

Plus the 7 EvidenceRegistry tests (anchor read-back, counts only move forward,
rewrites refused, per-caller slots, empty root/count refused) — unchanged.

**Panic-shape rule (found this session, documented in `tests/lib.cairo`):**
GateAccount's own errors are ByteArrays (`assert!(cond, "msg")` house style,
pinned as string literals); errors raised INSIDE OpenZeppelin code are felt252
shortstrings (`assert_valid_signature` takes `invalid_signature_error: felt252`,
`assert_only_self` panics `'Account: unauthorized'`) and must be pinned as felt
tuples `('msg', 'ENTRYPOINT_FAILED')` through dispatchers.

## The cross-language pinning chain

contract == Cairo mirror (every SNIP-9 happy path verifies a signature over a
mirror-produced hash) == JS (t35 literal) == starknet.js oracle
(`typed-data.test.mjs`). Same two-hop pattern as t17 for session hashes. The
vectors use FROZEN v0.2 fixture addresses on purpose: a vector pins hash maths,
never live state, so it must not change when the gate is redeployed.

## Live on Sepolia (the final oracle)

v0.3 declared (class `0x3acf8f1f...b8cb`), fresh `deploy_account` signed by the
owner key → new gate `0x7d1d8cad...2570f1`, mandate mirrored from LIVE old-gate
reads in one owner tx, evidence root re-anchored, and the headline proof:
**`execute_from_outside_v2` SUCCEEDED with a third-party relayer** (the deployer
account — different key, different address — submitted what only the owner
signed), tx `0x4a26c6b1...dfc5`, nonce consumed, balances read back.
Full receipts: `.sepolia/migration-v3.json` and `.sepolia/state.json`
(`migration_v03`). `--verify` re-reads everything from the chain: 11/11 PASS,
including `Account.getSnip9Version()` → `'2'` (library-native SNIP-9 detection;
the ISRC9_V2 interface ID is a spec constant, NOT an XOR of selectors).

## Reproduce (v0.3)

```
wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/run-tests.sh"
cd permission-core && pnpm test
cd gate-account/tools && node snip9-vector.mjs && node migrate-v3.mjs --verify
```

# Phase 5 results (2026-10-26) — wallet-signed SNIP-9 through an external relay

No Cairo changed in phase 5: the v0.3 class (snforge 42/42, above) already had
everything — the owner-gated `wallet_controller` slot and
`execute_from_outside_v2`. Phase 5 moved the controller slot off the gate itself
(the phase-4 pasted-key shape) onto a SEPARATE wallet-shaped account, and taught
the console server to carry wallet-signed authorizations.

## The wallet-shaped controller (deployed, probed, registered, read back)

`gate-account/tools/wallet-controller.mjs` — a second UDC instance of the SAME
standard OZ account class the deployer runs, constructed with the owner public
key (wallet `0x5c7b89fe...af5ec`, deploy tx `0x21e1e174...13b2`). Honesty-probed
BEFORE registering: `is_valid_signature` → `'VALID'` for the owner key,
NOT-`'VALID'` for a wrong key — the gate's delegation is real, not a rubber
stamp. Registered in one owner tx (`set_wallet_controller`,
`0x340c3174...8962`). `--verify` re-reads everything from the chain: **7/7
PASS** (owner key, ISRC6, class hash, both probe directions, controller
read-back, `getSnip9Version()` → `'2'`). Receipts: `.sepolia/wallet-controller.json`.

## The relay controls (JS, network-free)

`permission-core/tests/outside.test.mjs` — **20 controls**, each the ONLY thing
between a wallet-signed authorization and the chain (OBS-08): wrong signer vs
the chain-named controller, wrong wallet key, calls edited after signing,
envelope mutated after signing, stale mandate, expired window, consumed nonce,
cross-chain message, specific-caller message, recorded-selector drift, replay of
a finalized proposal, node-refusal verbatim, no-hash verbatim, REVERTED receipt,
BROADCAST-only-until-receipt. Every chain read and the relayer are injected; the
typed data is really built and really signed by `web/typed-data.js` — the same
module the browser runs. Full JS suite **235/235, 0 skipped**.

## Live on Sepolia (the final oracle)

`permission-core/tools/live-outside-proof.mjs` drives the REAL console server
(default live-network injectables, ephemeral port, throwaway store): over-cap
ask 50 (> live per-call cap 30) → DENY → proposal `3e2574924b0e3d1a` → owner
execute-once → `/api/outside/plan` (controller + fresh nonce `0xf92bc7dd...`
read from chain) → mock wallet signs `wallet-snip12-src9` → server re-verifies
everything, packs the wire FLAT (OBS-16), relays `execute_from_outside_v2` via
the gas-only deployer key → tx
`0x4b0593048ae51625df461b63359d01fd76143218f91d3330f5cb7a62aea0bfe`
**SUCCEEDED** (ACCEPTED_ON_L2). Read back from the chain: merchant balance 5 →
55 (Δ 50 = the approved amount), nonce consumed, submission flipped to
SUCCEEDED only from the receipt — never from the relay's own claim.
`all_checks_passed: true`. Receipt:
`permission-core/.data/phase5-outside-proof.json`; state.json
(`phase5_outside_relay`).

What this does NOT prove (honest limit): the mock wallet holds the owner key, so
it proves every line of OUR side — connector scheme, server controls, relay,
chain verification — but not the real Argent X extension's own signing
behavior. That is phase 6, in the user's browser.

## Browser proof (2026-10-26) — the wired UI, the mock wallet, live Sepolia

The phase-5 machinery, driven through the REAL console UI in the harness
browser (injected mock wallet on `window.starknet`, real server, real chain):
over-cap ask 40 → DENY → proposal `aae8693c90a3adee` → wallet connected
(enable, chain felt, `get_public_key` chain-read, owner-key match) → preview
digest `0x0269e25c...3a5d` → resolution signed IN THE WALLET
(`wallet-snip12-v1`) → wallet persisted through the signature → outside plan
auto-loaded (fresh nonce `0x9a04440e...`, controller = mock wallet) → "Sign in
wallet and send" (`wallet-snip12-src9`) → server re-verified and relayed via
the gas-only deployer key → tx
`0x3b8bb0758dc96b66f69bd417fe797d19e6e2d10fb7bc7f066240a160b9d16ea`
**SUCCEEDED**. Read back: merchant 55 → 95 (Δ 40 = the approved amount),
`nonce_consumed: true`. Exactly two wallet popups fired (the mock logs every
`signMessage`). Receipts: `.data/submissions.json`, `.data/demo-proposals.json`.

The first run of this path caught a real bug before any chain action: the
resolution note carried the display ellipsis '…' into the SNIP-12 carrier,
whose ASCII encoder refused it — every wallet-signed resolution was dead on
arrival. Fixed at the single carrier entry point (`mandateActionTypedData`
folds typographic look-alikes; non-foldables stay loud refusals), pinned by two
controls in `tests/typed-data.test.mjs` (fold semantics + surviving refusal);
the suite grew 235 → **237/237, 0 skipped**, and the canonical resolution
digest is unchanged by the fold (note-independent, verified byte-identical).
Full story: OBS-22, `track2-wallet-research.md` ("Phase 5 UI wiring").

What this still does NOT prove (unchanged honest limit): the mock wallet holds
the owner key, so the real Argent X extension's own signing behavior remains
unproven until phase 6, in the user's browser.

## Reproduce (phase 5)

```
cd permission-core && pnpm test
cd gate-account/tools && node wallet-controller.mjs --verify
cd permission-core && node tools/live-outside-proof.mjs
```

# Phase 6 results (2026-10-26) — handover crypto pins, anchor wallet path, tooling ready

No contract change in phase 6: the v0.3 class already carries everything —
`set_public_key` (embedded OZ AccountComponent, owner path only), the
owner-gated `wallet_controller` slot, and `execute_from_outside_v2`. Phase 6
pins the rotation crypto cross-language, builds the handover tool, and proves
the anchor wallet loop live. The handover itself runs in the USER's browser
(the harness cannot install extensions) — status: **tooling complete, awaiting
the user's real Argent X** (`phase6-handover-checklist.md`).

## snforge: 45/45 (38 GateAccount + 7 EvidenceRegistry) — new t36–t38

| # | Test | Claim it pins | Result |
|---|------|---------------|--------|
| 36 | accept-ownership hash matches the JavaScript vector | Cairo mirror == JS literal `0x10a910c4...a7ae720` (printed by `tools/accept-ownership-vector.mjs` for the frozen fixtures; JS = `@scure/starknet poseidonHashMany` + `web/typed-data.js shortStringEncode`, themselves pinned to the starknet.js oracle) | PASS |
| 37 | owner rotates the key with an accept-ownership signature | the REAL rotation on a live account: `set_public_key [new_pub, 2, r, s]` through `owner_execute`; afterwards the chain names the new key, the new key validates (`VALIDATED`), and the replaced key returns `0` — the pasted key's death, proven | PASS |
| 38 | rotation refused without the NEW key's signature | negative control (OBS-08): a stranger signs the CORRECT hash inside an otherwise-perfect owner invoke → refused by the contract itself (`'Account: invalid signature'`) — the new key must prove it controls the key it is handed | PASS |

Panic-shape note (OBS-23): t38's pinned tuple is `('Account: invalid
signature', 'ENTRYPOINT_FAILED', 'ENTRYPOINT_FAILED')` — one wrapper per
failed entrypoint hop (the dispatcher's `__execute__` call wraps the inner
self-call's failure), and snforge matches panic data EXACTLY. Observed
verbatim from the runner, then pinned — never guessed from a sibling test.

## The cross-language pinning chain (extended)

contract == Cairo mirror (t36–t38) == JS vector
(`tools/accept-ownership-vector.mjs`) == primitives already oracle-pinned in
`typed-data.test.mjs`. Same two-hop pattern as t17 (session hash) and t35
(SNIP-9 hash). The vector uses FROZEN fixtures (the v0.3 gate + the
pre-handover owner pub): hash maths, not live state — it must never change
when the owner rotates. starknet.js 10.8.0 exposes NO poseidon (probed:
top-level `poseidonHashMany` undefined, `crypto` empty of it), which is why
`@scure/starknet` — already a tools dependency — is the primitive.

## The anchor wallet path (server + UI + controls + live proof)

The loop phase 6 runs in the user's browser: after the handover the pasted key
is dead, so the résumé's anchor MUST go through the wallet. Built and proven
FIRST, this session:

- **Server:** `purpose: 'anchor'` branches in `/api/outside/plan` +
  `/api/outside/submit`; the guards extracted into one shared
  `outsideGuardedAnchor()` used by `/api/anchor`, `/api/anchor/plan` and both
  outside endpoints — one definition of "anchorable". Anchor submits write NO
  submission record by design: the anchor record is the only record.
- **Controls:** 8 new anchor-purpose tests in `tests/outside.test.mjs` (28
  there), each the only thing between an agent and an otherwise-successful
  anchor (OBS-08). Full JS suite **245/245, 0 skipped**. Style gate PASS
  (readout x17, label x28).
- **Live harness-browser proof:** `scripts/agent-act.mjs` appended honest
  record #5 (real engine, persisted witness; the chain deliberately BEHIND) →
  the résumé's wallet anchor with chain-read plan facts (registry, entry
  `anchor`, calldata `[agent, root, 5]`, fresh nonce `0x5af95b36...`,
  controller + chain-read key, gas-only relayer) → **exactly 1 popup**
  (OutsideExecution over that nonce) + 1 contract read (`get_public_key`) →
  tx `0xa68c01dc77a02be47f9f2e44b723ebd791fa2647952001f56fc3cff688cd7d`
  **SUCCEEDED** (ACCEPTED_ON_L2) → the résumé's fresh chain read: "The chain
  holds this exact fingerprint", 5 records, anchors in slot 2; state.json
  gained the anchor (`source: console-relay`); submissions.json gained
  nothing (correct). All 8 API calls 200, zero console errors.
- **Independent verification** (`proof-anchor-verify.mjs`, trusts nothing the
  console claims — recomputes the fingerprint from the signed evidence file,
  reads the chain raw): `VERIFY_RESULT ok:true`, 8/8 — fingerprint matches
  chain, receipt SUCCEEDED, sender is the gas-only deployer AND NOT the owner,
  tx carried `execute_from_outside_v2` on the gate, one-shot nonce burned
  (`0x0`).

## The handover tool (dry-probed; live run awaits the user's wallet)

`gate-account/tools/handover.mjs` — `--check` (deployed? chain-read key? STRK
balances; refuses gate/deployer/mock addresses), `--fund` (deployer → wallet
STRK + gate gas top-up below the minimum), `--prepare` (derive the exported
key's pub, match it against the chain's copy, compute the accept-ownership
hash from CHAIN-READ facts, sign locally, honesty-probe the wallet account
both directions, then DELETE the keyfile — the private key is never stored and
never sent anywhere), `--execute` (the atomic invoke — the pasted key's last
act: dry-run estimate first, padded bounds per OBS-10, receipt per OBS-19,
read BOTH facts back), `--verify` (full sweep incl. the negative control: the
old pasted key must NOT validate on the gate anymore). Dry probes passed:
usage exit 2; the mock-wallet address is refused by name; an undeployed
address is detected with live balances (gate 1.69 STRK — enough for the
handover invoke; deployer 46.6 STRK — enough to fund the user).

## Demo re-run with witness persistence (evidence never removed, demonstrated)

`demo-layer-d.mjs` re-ran **18/18** for a NEW agent (`0x00a852fe...`) with the
app-witness runtime persisted (`.data/demo-agent-runtime.json`) so
`scripts/agent-act.mjs` can keep acting as the SAME agent between runs. The
OLD agent's 4 records stay in the same evidence file (8 total), and the run's
own tamper check broke on the OLD agent's record — the file's integrity spans
generations. The demo's stale hardcoded token was replaced with state-file
reads (OBS-21 postscript): the spending gate denies token mismatch, so a
re-run would otherwise have failed its own checks.

### Rebrand note (2026-10-26, after the phase-6 tooling was frozen)

Argent X was rebranded to Ready / Ready X in late 2025 (fact-checked with
sources in `track2-wallet-research.md`, "The rebrand"). `web/wallet.js` gained
`starknet_ready`/`starknet_readyX` legacy aliases as insurance — detection was
already standards-first, so the rebrand cannot break it — and a new detection
test pins the aliases (including dedupe when the same object appears under old
and new slots). JS suite re-run: **249/249, 0 skipped**; style gate PASS. No
contract, handover-math, or wire-format change: the snforge 45/45 pins stand.

### Real-wallet probe (2026-10-26) — Ready X is ArgentAccount v0.4.0

`node tools/handover.mjs --check 0x0022239D...` now reports: deployed, class
`0x360783...`, name `ArgentAccount`, version `0.4.0`, owner `0x4fb24b55...` via
`get_owner` (owner type 0 = Starknet; **no `get_public_key`**), guardian
`0x7d2f7457...`, supportsISRC6 true, wallet 74.92 STRK. **Guardian is set**, so
`is_valid_signature` requires owner+guardian signatures (source: `account-0.4.0`
tag, `parse_signature_array` + `is_valid_span_signature`). Concise format:
2 felts `[owner_r, owner_s]` (no guardian only); 4 felts
`[owner_r, owner_s, guardian_r, guardian_s]`. Standard: `[count, type, pubkey, r, s, …]`.
With a guardian, owner-only probes can never return VALID. `handover.mjs` was
adapted: probes use concise `[r, s]`; when `has_guardian` is true the honesty
probe is **SKIPPED loudly** (prep records `honestyProbe.skipped`; `--verify`
prints `SKIP` lines — never a silent pass). The exported key is still hard-checked
against `get_owner`. The handover math is unchanged (gate `set_public_key`
verifies raw ECDSA, not the wallet's `is_valid_signature`). Open blocker for
step 10: the console's `normalizeWalletSignature` must be adapted to Ready X's
actual combined owner+guardian `signMessage` output.

### Handover executed + verified (2026-10-26)

The user removed the guardian from `0x0022239D...`, re-exported the key, and
ran the full sequence:

- `--check`: `hasGuardian: false`, owner `0x4fb24b55...` via `get_owner`.
- `--prepare`: honesty probe PASSED (own key → `VALID`, stranger → refused);
  keyfile deleted; prep saved with `walletHasGuardian: false`.
- `--execute`: tx `0x2c2b0395f0bf187bdf691683a40c2de123ad957b7f7b70c925c0bfd38888010`
  SUCCEEDED. One atomic invoke `[set_public_key, set_wallet_controller]`.
  Post-tx read-back initially failed on a leading-zero string mismatch
  (`norm()` only lowercased); fixed to canonicalize via BigInt, record
  finalized manually from chain-read facts.
- `--verify`: **9/9 PASS, 0 skips** — wallet key is gate owner, pasted key is
  NOT owner, controller is the wallet, wallet deployed, stranger refused,
  accept-ownership sig validates at wallet, old key negative control fails on
  gate, SNIP-9 V2 advertised, gate holds gas.

`keys.owner` in state.json marked **HISTORICAL** (private key kept permanently,
never used again). Phase 6 complete.

### Step-10 console adaptation (2026-10-26)

The step-10 blocker from the probe above (console `normalizeWalletSignature` +
server outside path) is resolved in code, rewritten from the `account-0.4.0`
source. The console now accepts all four documented wallet signature shapes
(the `{r,s}` object, concise 2-felt owner, concise 4-felt owner+guardian, and
standard `[count, then (type, pubkey, r, s) repeated count times]`), carries
the FULL array on the wire (the gate calls the controller's `is_valid_signature`
with exactly what the wallet produced), pre-verifies the owner r/s against the
chain-read controller key (`resolveControllerPublicKey`: `get_public_key` then
`get_owner` + `get_owner_type` fallback, non-Starknet refused), and refuses an
r/s-vs-array mismatch (409). New tests: the signature shapes, controller-key
fallback + non-Stark refusal, the full-array wire (4-felt concise and 5-felt
standard), r/s-vs-array mismatch refusal, and the post-handover live test
(chain owner == the recorded Ready X key; the old pasted key AND the agent key
both refused). JS suite: **254/254, 0 skipped**; style gate PASS. Detail:
`observations.md` OBS-25.

**Still to OBSERVE (not assume):** Ready X's actual `signMessage` shape at the
first browser connect - the normalizer records which of the four arrived
(`signatureFormat` in the envelope); an unknown shape refuses loudly.
**OBSERVED 2026-10-26 (OBS-29):** the standard five-felt wrapper
`[0x1, 0x0, pubkey, r, s]` - the pre-pinned `standard-1` shape. The live
step-10 run (over-cap ask, wallet popup approval, SNIP-9 plan, wallet-signed
relay via the deployer, receipt SUCCEEDED, nonce burned) is the remaining
proof and needs the browser.

## Reproduce (phase 6, tooling half)

```
wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/run-tests.sh"   # 45/45
cd gate-account/tools && node accept-ownership-vector.mjs   # prints the t36 literal
cd permission-core && pnpm test && node tools/check-style.mjs   # 254/254, 0 skipped; style PASS
cd permission-core && node scripts/agent-act.mjs   # honest record; then anchor via the console's wallet path
```

## Track 3 - witness-key rotation (2026-10-26, code-complete)

Owner-signed witness attestations make an honest app-key ROTATION legitimate
history instead of a red flag: "key W speaks for agent A from time T,
superseding W_prev", signed by the same chain-read owner key that signs
identities and ladder promotions. Every record verifies against the
attestation in effect WHEN IT WAS MADE; a rotated-out key cannot sign new
records (refused at the source); a key no attestation names is refused by
name; with no attestation file the legacy single-witness behavior is
unchanged. Built test-first:

- `src/attestations.mjs` + `tests/attestations.test.mjs` (12): digest,
  validate, sign, context-aware verify, the append-only store (contiguous seq,
  unbroken supersedes, non-decreasing validFrom, never future-dated), chain
  walk, coverage - each refusal the ONLY thing between a plausible forgery
  and an accepted record.
- `tests/witness-rotation.test.mjs` (17): the four proof properties at trust
  level; console happy paths (legacy résumé view, server-built preview, first
  vouch backdated to the earliest record, honest two-key rotation, wallet
  typed-data end to end); refusals (unvouched key, broken chain - even an
  honest next link onto it, forged owner, wrong key, foreign agent, edited
  attestation, stale seq, orphaning records at preview AND apply, same-key
  rotation however spelled, thin reason, malformed key, future dating,
  backward time); and the regression pin for the latent wallet-context bug
  (a wallet-signed ladder change refused by a context-less store, accepted by
  a context-aware one - at store, currentStage and endpoint level).
- `tests/signer.test.mjs` (+1 = 9): the browser's `witnessAttestationDigest`
  equals the server's for every attestation shape (genesis null supersedes,
  string numbers, padded/uppercase felts, unicode reason, key order), tamper
  sensitivity on every signed field, and an end-to-end browser-sign /
  server-verify.
- Console: `/api/witness/preview` + `/api/witness/attest` (the server builds
  the attestation from the signed state; the browser recomputes the digest
  and refuses on mismatch; coverage re-checked at apply). Both load the trust
  view in tolerate mode for `evidence-witness-mismatch` ONLY - that refusal
  is the state an attestation repairs; every other refusal stays a hard stop.
  Résumé UI: witness-history timeline + vouch/rotate card; a connected wallet
  fills the ladder and witness signer slots on the résumé.

JS suite: **284/284, 0 skipped**; style gate PASS. snforge unchanged (45/45).
Detail: `observations.md` OBS-26, `track3-witness-rotation.md` (Outcome).

**Post-Track-3, live browser pass (same day):** the first real Ready X
connect refusal exposed latent bug #2 - the JSON-RPC BigInt seam
(`selectorFromName` BigInts reached `JSON.stringify` in `mandate-reader`'s
`call()`, killing the server's `get_owner` fallback on real Ready X
controllers). Fixed at both ends, pinned by 3 new wire tests
(`tests/mandate-reader.test.mjs`) plus JSON-strict fakes in the
`outside.test.mjs` fallback tests; the wallet.js refusal now surfaces the
provider's underlying errors verbatim. Suite is now **287/287, 0 skipped**.
Detail: `observations.md` OBS-27.

**Same day, second live-pass finding:** the diagnosable refusal showed both
getter calls dying with "Failed to fetch" - the wallet's injected provider
fetches from the PAGE's origin and can be transport-blocked there while the
wallet app itself reads the chain fine. Connect now has a second, server-side
chain reader (`GET /api/chain/key?address=…`, CORS-free, names the getter that
answered); fallback fires only on transport failures, semantic chain answers
stay final, and `info.keySource` records which reader answered. Suite now
**294/294, 0 skipped**. Detail: `observations.md` OBS-28.

**Same night, root cause of "Failed to fetch" found (OBS-30):** the console's
own CSP header. `connect-src 'self'` blocked the wallet's in-page code
(`inpage.js`) from fetching its own RPC
(`https://rpc.starknet-sepolia.lava.build`) - the same block also killed
Ready X's signing simulation ("Tx not executed: Argent multicall failed",
Sign greyed): ONE root cause for both live failures. Probes cleared the
non-causes first: the controller's `is_valid_signature` answers VALID for
both the five-felt wrapper and the inner `[r, s]`, and the relayer holds
46.6 STRK. Fix: a bounded connect-src allowlist (the wallet's RPC host +
Cartridge; never a bare `https:`; pinned byte-exact by a server test) and a
refusal NOTE naming the console's CSP when the provider's error text does.
Suite now **295/295, 0 skipped**; server restarted (pid 10868) and the live
header verified.

**Next morning, the wallet's own error text closed the loop (OBS-31):** with
the CSP fix live, Ready X's simulation reached its node and reported the real
reason for "Argent multicall failed": it replays the authorized calls FROM
THE WALLET, and our self-call answers any non-gate caller with
`('Account: unauthorized', 'ENTRYPOINT_FAILED')` - the exact panic our snforge
suite pins for an outsider touching a self-only entrypoint. The fix keeps
every control and drops the relayer from the wallet flow: `/api/outside/wire`
re-runs the relay's guard and four controls and hands the wire back
unrelayed; the wallet sends execute_from_outside_v2 as its own transaction
(it holds 54.88 STRK - probed from the chain, not assumed);
`/api/outside/record` writes the record from the chain's copy of that tx and
completes it from the receipt via the same helper the relay path uses. Suite
now **302/302, 0 skipped**; server pid 1396.

**Corrected the same night (OBS-32):** the refusal the owner saw on retry sat
on popup 1 - the SIGNING request ("Data to be signed"), Sign greyed out.
Ready X rehearses an OutsideExecution message's calls from the wallet at
SIGNING time, regardless of who would submit - so the wallet-submitted path
fixed popup 2, which was never the blocker (its machinery stays, tested, and
the record path uses it). Because every real call on the v0.3 gate is
self-only (`assert_only_self`), NO SNIP-9 message with content can be signed
by Ready X on this gate - upgrade included (same guard), nested messages
included (the innermost signing rehearses the same calls). Verified dead
ends and the open door are recorded in OBS-32: the gate's owner key IS the
wallet's key, its `__validate__` owner branch is plain OZ ECDSA over the
invoke hash, the phase-4 pasted-key final-tx machinery is alive
(`/api/tx/plan` -> tab signs -> `/api/broadcast` -> receipt), and the gate
holds 1.66 STRK for its own gas (probed) - so step 10 can run as an
owner-signed invoke once the owner confirms Ready X's key export.

**And the owner confirmed, the same morning (OBS-33):** Ready X did expose
the export. The pasted-key owner transaction executed the amended mandate
live: tx `0x62c0bd18ca50c4fae3a1341d0fa39b8dd4315228b4d09c4a2fdf51acfa1b62b`,
receipt SUCCEEDED / ACCEPTED_ON_L2, sender = the gate itself, one call =
set_spending_policy with cap 100; live re-read maxPerCall 100 (was 30); the
tab-computed hash equals the chain's hash byte for byte. **Step 10 DONE.**
The live-alignment drift test caught the amendment and failed loudly (its
50-unit over-cap pin was true under the old cap only); the pin is now
cap-relative (live cap + 1) and the historical revert is re-decided against
today's chain. Suite back to **302/302, 0 skipped**; style gate PASS.

**The v0.4 fix is LIVE (OBS-34, same day):** declared `0x663510bc…7070`
(class `0x15d47cb5…35ff`, snforge 48/48 incl. t39/t40/t41), then installed by
the owner through the console's new "Gate contract" card — price, explicit
ack, ONE last pasted Ready X key, signed in the tab, relayed with the
audit-only `action:'upgrade'` tag: tx
`0x55ea5c1f12bcf9130ec1501031a413a12e116ead7491204b0ae33fa6a7566a0`,
SUCCEEDED / ACCEPTED_ON_L2, nonce 7 → 8. Verified from the node with the
console out of the loop (verify-upgrade.mjs 15/15): the gate's class hash IS
the v0.4 class, the running ABI carries all eight admin entrypoints plus
`execute_from_outside_v2`, and session, cap 100, window, allowlist and the
post-handover owner key all read back unchanged — code replaced, state and
sovereignty intact. OBS-32's circularity is CLOSED: from v0.4 the admin
entrypoints accept self OR the registered controller, so future owner actions
sign from the wallet with no export. Suites at install: **snforge 48/48,
JS 314/314, 0 skipped** (twelve new upgrade-path pins); style gate PASS.

**The wallet-flow proof is LIVE (OBS-35, 2026-10-28):** proposal
`4883847fbc212efe` (50 units to the stranger, chain-blocked
`recipient-not-allowed`) was amended by the owner — "allow this recipient"
signed in Ready X, carried to Sepolia BY THE WALLET ITSELF: tx
`0x419f306ab0e164fa420b584c0528390d824a271c744e1c59c92fdce5236ebb7`,
SUCCEEDED / ACCEPTED_ON_L2, sender = the wallet `0x0022239d…b1fcfb`,
`execute_from_outside_v2` on the v0.4 class, inner calls
`is_valid_signature` + the gate's `allow_recipient`, five-felt owner
signature `[0x1, 0x0, 0x4fb24b55…e7d2, r, s]`, caller ANY_CALLER, one-shot
nonce burned. Popup 1's signing-time rehearsal passed for the first time —
v0.4 made it truthful (OBS-32's greyed-out Sign is closed). Tracks 1–3 now
have a live witness for EVERY path. The same session surfaced three console
failures, all fixed and pinned (OBS-35): the false RECORD MISMATCH lock card
(wrong baseline — the HISTORICAL owner slot; now `keys.owner_current`), the
stuck "Reading…" spinner (no timeout on any of the three fetch seams; now
loud bounded failures, pinned against a black-hole node), and the stale
allowlist record (chain allowed the stranger, the record didn't name it;
record follows chain, live-alignment pin is now chain-relative with a drift
alarm). Plus two preview refusals kept as honesty evidence, and the dead
corner they exposed: with per-call cap == window cap == 100, "raise the
per-call cap" has no valid value. **The product fix is BUILT (same day,
test-first):** a third amendment kind `raise-window-cap` — raises the window
cap, preserves the per-call cap, same guards philosophy (pointless changes
refused, self-contradiction refused), same honest window-restart warning;
the form defaults to it when the blocked ask exceeds the window cap, so the
owner is never offered a decision with no valid value. Pinned by 5 new tests
(r10/r11/r12 wire + guards, server resolve→submit seam, unknown-kind refusal
still 400): **JS 326/326, 0 skipped**, style gate PASS, and a live preview
smoke test on fresh proposal `97dca512ed101c00` (150 to the merchant)
returned the exact wire: set_spending_policy [session, token, 100 preserved,
150 raised, 2592000s kept] with all three side effects. **The LIVE wallet
proof is DONE (same day, OBS-36):** the owner signed the window amendment in
Ready X — popup decoded "Set spending policy / No balance change" with the
honest ANY_CALLER critical-risk warning (raw i18n key shown), Sign greyed
until "Accept risk" — and the wallet carried it to Sepolia: tx
`0x69b20e5c…fa0d`, SUCCEEDED/ACCEPTED_ON_L2, block 17267240; chain re-read
per-call 100 / window 150 / seconds kept / spent 0. A server restart lost
the in-flight record write; the hash was recovered by chain-state bisection
and adopted via `/api/outside/record`, which first exposed the last seam:
the record path re-derived against the LIVE policy the tx had already moved,
so the pointless-change guard refused adoption. Fixed test-first with a
record-only `verifyApplied` derivation (plan/wire/submit still refuse to
sign pointless changes; a tampered tx is still refused): 4 new pins,
**JS 330/330, 0 skipped**, style PASS. Record #7 written: wallet-submitted,
relayer null, nonce consumed. **Follow-up (OBS-37, same day):** the per-call
raise to 150 also proved live (tx `0x205710f6…1fb`, block 17272013, record
#8) - the `verifyApplied` adoption path's first real use, hours after being
built. Still 330/330; no new code was needed for either live run.

**Still to OBSERVE (browser list):** the wrong-wallet refusal (a different
wallet must be refused), the live owner-signed witness attestation through
the résumé's witness card, and a wallet-signed ladder promotion once the
résumé UI can reach it. Observed so far in the browser:
the Ready X connect (OBS-28), the first live signature -
`signatureFormat: "standard"`, five felts `[0x1, 0x0, pubkey, r, s]`
(OBS-29) - Ready X's signing-time rehearsal refusal, decoded twice (OBS-31's
relay-model reading, corrected by OBS-32), the live step-10 pass - the
owner-signed invoke from the gate, tx `0x62c0bd18…b62b`, cap re-read 100 from
the chain (OBS-33) - the live v0.4 install through the upgrade card, tx
`0x55ea5c1f…66a0`, card flipping to "the chain itself says the gate now runs
the declared class" (OBS-34) - and the wallet-flow proof above, tx
`0x419f306a…ebb7` (OBS-35) - and the live window-cap amendment proof, tx
`0x69b20e5c…fa0d`, window cap re-read 150 from the chain, record adopted
after a restart by bisection + `/api/outside/record` (OBS-36) - and the live
per-call raise, tx `0x205710f6…1fb`, cap re-read 150, the adoption path's
first real use (OBS-37). Announced, never silently skipped.

## Reproduce (Track 3)

```
cd permission-core && pnpm test && node tools/check-style.mjs   # 330/330, 0 skipped; style PASS
wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/run-tests.sh"   # 48/48 (v0.4: +t39/t40/t41)
```
