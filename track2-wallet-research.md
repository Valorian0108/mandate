# Track 2 fact-check: where should the owner key live?

Written 2026-10-25. NEXT.md track 2 starts with a question, not an assumption:
**does Privy actually issue Starknet keys today?** This file records the answer,
the catch that came with it, what our own contract already supports (checked in
the source, not from memory), and the two real paths forward.

---

## The short answer

**Yes — Privy issues Starknet keys today.** Confirmed from three independent
sources:

- starknet.io blog, June 2026: "Privy Brings Seamless Embedded Wallets to
  Starknet". StarkWare is building an official SDK on top of it ("what's coming
  next").
- Starknet's own docs (docs.starknet.io → StarkZap → Privy integration): a full
  working pattern — create a Starknet wallet, sign transaction hashes, deploy an
  Argent account preset with the Privy key as its signer.
- Privy's docs: Starknet is a supported chain in their "sign" tier — create a
  wallet, sign arbitrary hashes along the chain's curve (for Starknet: the
  STARK curve, so signatures verify with the same maths our server already uses).
- Context: Privy is Stripe-owned since mid-2025, actively shipping (XRPL added
  Oct 2026). Key export is documented for every tier — users can leave.

So the decision tree in NEXT.md ("if yes, embedded wallet") fires on its literal
condition. But the fact-check surfaced something the tree could not have known,
and it changes the recommendation.

## The catch: on Starknet, Privy signs through YOUR backend

How Privy's Starknet signing actually works (from their docs and the Starknet
integration page):

1. The private key lives in Privy's infrastructure (hardware-isolated). Nobody's
   app ever sees it. Good.
2. Signing is a **raw-sign API call**: `POST /v1/wallets/{id}/raw_sign` with a
   hash, authenticated with the **app secret** — i.e., a server-side credential.
   Their Node SDK is explicitly "server-only".
3. Their React SDK has a client-side hook (`useSignRawHash`), but it is
   React/React-Native only, and the official Starknet integration example routes
   signing through the **developer's own backend** (`/api/wallet/sign`). The
   vanilla-JS SDK (`js-sdk-core`) is an *auth* client — and Privy's own docs say
   "do not attempt to use this library without first reaching out to the Privy
   team". Our console is vanilla JS with no build step.
4. Two ownership models: **server-managed** (the backend signs anything, anytime
   — custodial) and **user-owned** (signing requires the user's login token).
   Even in the user-owned model, on Starknet the signing call is made by a
   backend holding app credentials plus the user's token.

### Why this matters for THIS project

Our founding claim (Layer B): **zero authority items on the company side.** The
console today is stronger than it looks: the owner key lives in the browser tab,
is never sent anywhere, and the server *cannot produce an owner signature even
if it wanted to* — track 1 made the server a postbox for bytes it can verify but
never forge.

Privy-on-Starknet in the user-owned model would mean: our backend becomes the
signing oracle, gated only by "the user has a valid login session". A malicious
or compromised backend could ask Privy to sign **any hash** while the user is
logged in — and because Starknet is raw-hash tier, Privy sees an opaque hash,
shows the user nothing, and their transaction-level policy engine (which needs
decoded transactions, a higher tier) cannot help. That is a *downgrade* from the
guarantee the console already provides, dressed up as an upgrade.

Honest counterpoints, recorded for fairness:

- The key itself is safer than a pasted testnet string: professional custody,
  social login, no key management for the user, documented export escape hatch.
- Privy's quorum/policy features can require both user and server to agree —
  but those are enterprise-tier controls, and per-signature policies need
  decoded transactions, which raw-hash Starknet signing does not provide.
- "The company can request signatures during your session" is still much better
  than "the company holds your key". It is just worse than what we have.

## What our own contract already supports (checked in `gate-account/src/lib.cairo`)

These facts decide what the native-wallet path costs:

- **`set_public_key` exists** (OpenZeppelin key management is embedded, owner-only
  via `assert_only_self`). So the GateAccount's owner key can be rotated: the
  current throwaway key signs one last transaction handing ownership to a new
  public key — through the track-1 relay that already exists.
- **`is_valid_signature` is public and owner-only** (line ~266): the account
  verifies arbitrary typed-data signatures against the owner key. This is the
  natural verification point for signatures made by a real wallet.
- **The account is upgradeable** (`upgrade` is an entrypoint; it is on the admin
  blocklist so session keys can never call it).
- **SNIP-9 "outside execution" is NOT implemented.** The selector
  `execute_from_outside_v2` appears only in the session-key blocklist, and the
  contract's own comment says: *"canonical SNIP-12 typed data arrives with the
  SNIP-9 / paymaster integration in v1.1"*. This matters because browser
  extensions (Argent X, Braavos) will **not** sign a raw transaction hash for
  someone else's account — they sign their own transactions, or typed-data
  messages the user can read. Without SNIP-9 there is no way for a native wallet
  to authorize a transaction on the GateAccount.

## The two real paths

### Path A — Privy embedded wallet (user-owned model)

- **What works immediately:** everything, mechanically. `rawSign(hash)` signs
  exactly the hashes we already compute in the browser (resolution digests,
  invoke-v3 transaction hashes). The GateAccount owner key becomes the Privy
  wallet's public key via one `set_public_key` rotation. No Cairo changes.
- **What it costs:** a signing endpoint in our backend holding app credentials —
  the sovereignty downgrade argued above; a Privy developer account (app id +
  secret — a signup, and a third party now inside Stripe); a React or hand-rolled
  REST client in a deliberately framework-free console; user login flow (email /
  social) before any signing.
- **Live proof:** fully drivable from our own browser (no extension needed).

### Path B — the owner's real wallet (Argent X first, Braavos fact-checked later)

- **How it works:** the wallet's *signer public key* (readable on-chain from the
  wallet's own account) becomes the GateAccount's owner key via the same one-time
  `set_public_key` rotation. From then on:
  - **Resolutions and ladder changes** work *without any contract change*: they
    are off-chain digests. We express each digest as SNIP-12 typed data (a
    standard structured message the wallet displays to the user in readable
    form), the wallet signs it after the user confirms, and the server verifies
    the signature against the owner key it reads from the chain — the same check
    it does today, with a standardized carrier instead of a custom digest.
  - **Final transactions** need SNIP-9 outside execution: the wallet signs a
    typed-data authorization that binds the exact calls, a nonce, and an
    expiry time; anyone (our relay) may then submit `execute_from_outside_v2`
    to the GateAccount, which verifies the signature against the owner key.
    The relay cannot substitute calls — they are inside the signed message —
    and it cannot wait: the authorization expires. This is Cairo v0.3: add
    OpenZeppelin's `OutsideExecutionComponent`, snforge tests, then upgrade the
    deployed account in place (address, owner and policies all preserved).
    A small "courier" account submits and pays gas, so the GateAccount itself
    needs no STRK for owner actions.
- **What it costs:** the Cairo v0.3 work above; a vanilla-JS wallet connector
  (extensions inject `window.starknet` — no framework needed); SNIP-12 typed-data
  hash maths implemented in the browser and pinned by drift tests against
  starknet.js, exactly like the invoke-v3 hash was in track 1.
- **Live proof:** needs a real browser with Argent X installed — ours (the
  automation browser) cannot install extensions, so the final live click is
  yours, with exact steps prepared. Testnet wallet + faucet STRK are free.
- **Sovereignty:** maximal. The key never exists outside the user's own wallet
  (a separate product); every signature is a deliberate confirmation showing
  what is being signed; our server can never produce a signature, not even
  during a session. NEXT.md already called this "the more user-sovereign answer".

### Unchecked assumptions (flagged, to verify at build time — not from memory)

- That Argent X's `signMessage` signs with the same key its account exposes via
  on-chain `get_public_key`, and that the signature is plain STARK-curve ECDSA
  our existing verifier accepts. (Expected yes; must be proven against a live
  wallet + chain read before anything is claimed.)
- Braavos compatibility: its accounts may combine a STARK key with a
  second factor (WebAuthn), which might not verify as a single-key ECDSA
  signature. Braavos is a follow-up fact-check, not a promise.

### Verified since writing (same day)

- **OpenZeppelin cairo-contracts v4.0.1 — the exact tag we already depend on
  (commit `87e32f3d`, checked in the local Scarb checkout, not from memory) —
  ships `SRC9Component`** (SNIP-9 outside execution): `execute_from_outside_v2`,
  per-message nonces (replay-proof), `execute_after` / `execute_before` validity
  windows, caller binding, and SNIP-12 typed-data hashing. It is documented
  "account agnostic, as long as the contract implements the ISRC6 interface" —
  our GateAccount already does (`is_valid_signature`, owner-only), already has
  SRC5, and its session-key blocklist already refuses
  `execute_from_outside_v2`. Cairo v0.3 is therefore a component embed plus
  tests, not hand-rolled crypto.

## Decision (2026-10-25): Path B — the owner's real wallet, Argent X first

Chosen because the fact-check showed Path A on Starknet today routes signing
through a company backend — a downgrade from the guarantee the console already
provides. Phase order (each phase has its own controls-tested, live-proven
definition of done):

1. **SNIP-12 typed-data carrier.** `web/typed-data.js` (node-free) implementing
   the typed-data hash, pinned by drift tests against starknet.js 10.8.0 as the
   oracle — same discipline as `tx-signer.js`. Resolution and ladder digests
   ride inside typed-data messages (the existing poseidon digest stays the
   binding; typed data is the carrier the wallet can display). The server gains
   a versioned signature envelope (`digest-v1` for existing records, `snip12-v1`
   for new ones) — old signatures must keep verifying; the audit screen re-checks
   both.
2. **Signer interface in the console.** The four key fields collapse behind one
   abstraction (`signTypedData`, `signInvoke`, `authorizeCalls`); the pasted key
   becomes its first implementation, unchanged in behavior (165 tests stay
   green).
3. **Wallet connector, vanilla JS.** `window.starknet` (Wallet Standard):
   detect, connect, chain check (SN_SEPOLIA), and the wrong-wallet refusal —
   the wallet's on-chain signer pubkey must equal the GateAccount's on-chain
   owner key, in plain words, before anything can be signed. Mocked-window
   control tests for every refusal; live checks flagged for the user's browser.
4. **Cairo v0.3: embed `SRC9Component`** + snforge tests (happy path, expired
   window, replayed nonce, substituted calls, session-key refusal, wrong
   signature) + declare + **upgrade the deployed account in place** through the
   existing relay. Provable end to end with the pasted key (it can sign SNIP-9
   typed data like any owner key) — no wallet needed to validate the on-chain
   half.
5. **Wallet-driven final transactions.** Wallet signs the SNIP-9 authorization
   (user sees the exact calls and the expiry), then submits — either the wallet
   itself sends the wrapping invoke (server fully out of the path; new
   record-external-submission endpoint verifies the tx from the chain, never
   from the client's claim), or a labelled courier relays it. Decision at build
   time, documented either way.
6. **Ownership handover + live proof (user's browser, exact steps prepared).**
   Argent X on Sepolia + faucet STRK; connect; show the wrong-wallet refusal;
   rotate the GateAccount owner to the wallet's signer key via `set_public_key`
   signed by the pasted key through the track-1 relay (its last act); then run
   a full amendment + anchor loop with the server never seeing a key or a
   signature the user did not approve in the wallet UI.

Braavos stays a follow-up fact-check (its signature scheme may include a second
factor). Privy stays recorded as a future convenience option, conditional on
client-side Starknet signing that never transits a company backend.

## Build-time correction (2026-10-25, phases 1–2 done): the wallet signs as ITSELF, never as the GateAccount

Phases 1 and 2 are code-complete and live-verified (SNIP-12 carrier in
`web/typed-data.js` + `snip12-v1` envelope, both proven in the browser with a real
declined proposal; Signer contract in `web/signers.js` with the pasted key as
implementation #1; suite 192/192, 0 skipped). While wiring phase 3, one assumption
in the plan above was checked against the library source — and it does not survive
contact. Recorded here because it changes phases 4 and 5.

**The fact** (read from `starknet.js` 10.8.0 `dist/index.mjs`, not from memory):

- `Account.signMessage(typedData)` (L12184) calls
  `this.signer.signMessage(typedData, this.address)` — the account passes **its own
  address** into the signer.
- `Signer.signMessage(typedData, accountAddress)` (L10124) computes
  `getMessageHash(typedData, accountAddress)` and signs that. The SNIP-12 hash is
  `poseidonMany('StarkNet Message', domainHash, accountAddress, messageHash)` —
  the signing address is **inside the hash**.
- A dapp calls `wallet.account.signMessage(...)` (or `wallet.signMessage` via the
  connector) and has **no parameter** to override that address. There is no way to
  ask Argent X to sign a message "as" some other account. The signature is always
  bound to the wallet's own address.

### What still works (off-chain approvals — phases 3 and 6, unaffected)

Resolutions, ladder changes and anchors are off-chain records. The wallet signs the
SNIP-12 message bound to *its* address; the server verifies by:

1. taking the `signerAddress` from the envelope (the wallet's real address),
2. recomputing the SNIP-12 hash **with that address**, and
3. checking the raw STARK-curve ECDSA signature against the GateAccount owner key
   **read from the chain**.

After the phase-6 handover (owner key = the wallet's signer key) this verifies. It
is sound: a forged envelope would need a signature over `hash(fakeAddress, message)`
by the owner key — only the true owner can produce that, and the wallet itself only
ever signs hashes over its own real address. The server never trusts the wallet
contract's `is_valid_signature` or `get_public_key` as *proof* (a malicious contract
can lie about both); raw ECDSA against the chain-read key stays the only gate. New
envelope scheme: `wallet-snip12-v1`.

### What breaks (on-chain SNIP-9 — phases 4 and 5)

OpenZeppelin's `SRC9Component` computes the OutsideExecution hash with
`account_address = self.address` — the GateAccount. A native wallet's signature is
bound to the wallet's address instead. The hashes can never match, so
`execute_from_outside_v2` would **reject every native-wallet signature, forever**.
The straight component embed planned in phase 4 does not achieve the goal. Three
ways out were identified:

- **(i) Controller-bound SNIP-9 (recommended).** GateAccount v0.3 stores a
  `wallet_controller: ContractAddress`, settable only through the existing
  owner-signature gate (owner signs the registration off-chain; relay submits).
  `execute_from_outside_v2` then computes the SNIP-9 v2 hash with
  `account_address := wallet_controller` and verifies the signature by calling
  `wallet_controller.is_valid_signature(hash, sig)` and requiring `'VALID'`.
  Nonces, time windows, the signed calls and every spending-policy check stay in
  the GateAccount. Trust chain: owner key → on-chain registration → controller's
  own key. The registration passes the same raw-ECDSA gate as everything else, so
  nothing becomes trustless-trust. Bonus: because the *wallet contract* verifies
  the signature internally, Argent X key rotations or guardian setups keep working
  without us re-pinning any key. Cost: phase 4's Cairo scope changes from "embed
  SRC9Component" to "embed it with the signer parameterized" (the OZ component
  hardcodes `self.address`), plus two extra snforge controls: unregistered
  controller, and a registered controller whose `is_valid_signature` says no.
- **(ii) Owner becomes an address.** The GateAccount's owner stops being a public
  key and becomes the wallet contract's address; every owner proof delegates to
  `owner.is_valid_signature`. Conceptually the cleanest account-abstraction shape,
  but it is a deep refactor: every `assert_only_owner` path in Cairo changes, the
  deployed storage migrates, and — worse — the *server* loses its deterministic
  local check: every off-chain approval would need an RPC call to the wallet
  contract (slow, node-dependent, and exactly the "trust the contract's answer"
  pattern rejected above), or a pinned pubkey that silently breaks the day the
  user rotates their wallet key.
- **(iii) Keep the pasted key as an on-chain courier.** The wallet signs off-chain
  approvals only; a pasted key still signs the actual invokes. This defeats track
  2's whole purpose (the key the server-side process can touch is the key that
  matters) and is rejected as an end state. It remains available as a labelled
  stopgap — it is what the console does today.

**Decision (2026-10-25, owner): option (i) — controller-bound SNIP-9.** Phase 4's
Cairo scope is therefore: `SRC9Component` logic with the signer parameterised —
a `wallet_controller` storage slot settable only through the owner-signature gate,
OutsideExecution hashing against that controller, and signature verification
delegated to the controller's `is_valid_signature`. snforge controls gain two
cases: unregistered controller, and a registered controller that says no. Phase 3
(connector, wrong-wallet refusal, `wallet-snip12-v1` approvals) was identical
under all three options and proceeds.

### Phase 3 status (2026-10-25): code-complete, controls-tested, live-proven with an honest mock

- `web/wallet.js`: detection (`window.starknet` + `starknet_argentX` /
  `starknet_braavos` aliases, deduped), `connectWallet` with plain-word refusals
  (no wallet / declined / no address / unknown or wrong network / unreadable
  on-chain key / wrong wallet), and a Signer-contract implementation whose
  envelopes carry `signerAddress`. The wallet's key is read FROM THE CHAIN
  (`get_public_key` on the wallet's own account) — a test proves a wallet that
  lies about its key still cannot forge, because the server's raw-ECDSA gate is
  the only thing that decides.
- `wallet-snip12-v1` in `src/proposals.mjs`: same field checks as `snip12-v1`,
  hash bound to the envelope's `signerAddress`; tests prove the two schemes are
  separated by the address their hash binds (relabelled envelopes fail both ways).
- 22 control tests (`tests/wallet.test.mjs`), suite 214/214, 0 skipped. The mock
  wallet is honest: it hashes with the oracle bound to its own address and
  returns Wallet-Standard `string[]` signatures; decimal and `{r,s}` shapes are
  accepted, guardian/multisig arrays refused loudly.
- Live in the console (injected mock, real server, real chain reads): the
  wrong-wallet refusal named both keys, the wrong-network refusal named both
  networks, and a full connect → preview → decline loop was recorded as
  `wallet-snip12-v1` with `signatureValidNow: true` against the chain-read owner
  key (proposal `6a5fa41e075425bf`).
- **CSP finding (from Chrome's own docs, not memory):** "When a content script is
  injected into the main world, the CSP of the page applies." Wallet extensions
  inject `window.starknet` into the main world, so our strict
  `script-src 'self' 'nonce-…'` would have blocked every native wallet silently —
  untestable in the harness browser (no extensions), discoverable only in the
  user's browser. `script-src` now also allows the `chrome-extension:` scheme;
  the reasoning is recorded where the header is built in `web/server.mjs`.
- Still flagged for the user's browser (phase 6): that the REAL Argent X
  `signMessage` signs with the key its account exposes via on-chain
  `get_public_key` as plain STARK-curve ECDSA (the mock proves our side of the
  loop; only the live wallet proves its side), and that its injection works
  through the amended CSP.

### Phase 4 status (2026-10-25): controller-bound SNIP-9 built, tested, MIGRATED LIVE, third-party relay proven

- **The contract (v0.3).** `wallet_controller: ContractAddress` slot, settable
  only through the owner-signature gate; `execute_from_outside_v2` computes the
  SNIP-9 v2 hash with `account_address := wallet_controller` and delegates
  verification to the controller's `is_valid_signature`; one-shot nonces,
  exclusive time windows and caller-binding stay in GateAccount (never in the
  controller). Plus owner-gated `upgrade` (UpgradeableComponent) — see the plan
  correction below. **snforge 42/42** including every promised control: happy
  path (real ECDSA signature verified by the contract), expired window,
  too-early, replayed nonce, substituted calls, wrong key, session-key refusal
  (a session signature can NEVER authorize outside execution), unregistered
  controller, registered controller that refuses (t28: refusing controller
  blocks even a perfect owner signature), owner-gating of both new entry points,
  and in-place upgrade preserving state (t34).
- **Cross-language hash pinning (two hops, the t17 pattern).** Happy paths pin
  contract == Cairo mirror; t35 + `tools/snip9-vector.mjs` +
  `permission-core/tests/typed-data.test.mjs` pin mirror == JS == starknet.js
  on one frozen vector (`0x5f4becd3a2815731f6f378ac9dab8a193bb80a2a4b4b992ddf3703bba66718c`).
  Suite: **JS 215/215, 0 skipped**.
- **PLAN CORRECTION, recorded honestly.** The plan said "declare + in-place
  upgrade through the existing relay". The v0.2 class turned out to have NO
  upgrade entry point — in-place was impossible. Corrected course: declare v0.3,
  then a fresh `deploy_account` signed by the owner key (exercising
  `__validate_deploy__` live), new gate
  `0x7d1d8cad365390adfb2f4f9f89277663c555d2eed790f1c4983c44a002570f1`, mandate
  MIRRORED from live reads of the old gate (never retyped) in one owner tx, and
  `set_wallet_controller(self)` — the pasted-key shape: the owner key validates
  through the gate's own owner-only `is_valid_signature`. Because v0.3 DOES have
  owner-gated `upgrade`, this is the last redeploy. Old gate and its history
  stay live on-chain (evidence never removed). Full receipts:
  `gate-account/.sepolia/migration-v3.json`, summary in `state.json`
  (`migration_v03`).
- **The live proof (the point of the whole phase).** tx
  `0x4a26c6b14fe30b3743b6bff2f5c652e47118e49cc2cec5fe0066ee02f99dfc5`
  SUCCEEDED on Sepolia: an owner-signed SNIP-9 authorization (digest
  `0x1df04e47b2c89875a172bbfb068bb8f7dce299360ce11191e494c2660f9d12b`) was
  submitted by **a third party** — the deployer account, a different key at a
  different address — and the gate executed exactly the signed call (5 tokens to
  the merchant) and consumed the nonce. This is the mechanism phase 5/6 will
  hand to a real wallet: the wallet signs, anyone may relay, the gate enforces.
  `migrate-v3.mjs --verify`: **11/11 PASS**.
- **Standard-detail correction (found live, pinned in state.json).** The
  ISRC9_V2 interface ID `0x1d1144bb2138366ff28d8e9ab57456b1d332ac42196230c3a602003c89872`
  is a SPEC CONSTANT (SNIP-9 NOTE: computed with the Cairo v2.5.0-era `Call`
  struct), NOT the XOR of the two current selectors — an XOR derivation fails.
  The contract registers the OZ-imported constant (correct from the start);
  detection in tools is library-native: `Account.getSnip9Version()` → `'2'`.
- What phase 5 adds on top: the WALLET signs the same SNIP-9 authorization
  (`wallet_controller` pointed at the wallet contract in phase 6 handover) and
  an external-submission endpoint records it only after chain verification.

### Phase 5 status (2026-10-26): wallet-signed SNIP-9 relayed by the server, LIVE-proven end to end

Phase 5 is **built, control-tested, and proven on Sepolia**. The wallet now signs
the final action and an external submitter (the server's gas-only deployer key)
carries it — the exact shape a real Argent X uses in phase 6.

- **A wallet-shaped controller, deployed and honesty-probed.**
  `gate-account/tools/wallet-controller.mjs` deployed a second UDC instance of the
  SAME standard OZ account class the deployer runs, constructed with the owner
  public key (wallet `0x5c7b89fe...af5ec`, deploy tx `0x21e1e174...13b2`). Before
  registering it, `--probe` confirmed the property the gate's delegation relies on:
  `is_valid_signature` returns `'VALID'` for the owner key and NOT-`'VALID'` for a
  wrong key — an honest verifier, not a rubber stamp. `--register` set it as the
  gate's `wallet_controller` in one owner tx (`0x340c3174...8962`); `--verify`
  reads everything back (**7/7 PASS**, incl. library-native `getSnip9Version()` →
  `'2'`). This moves the controller off the phase-4 self-controller shape; phase-4
  receipts stay valid on-chain forever and the slot is owner-gated, so phase 6
  repoints it at the user's real wallet.
- **Two new endpoints, every guard mirrored from the owner relay.**
  `POST /api/outside/plan` (reads the chain-named controller, draws a fresh nonce
  verified unused on chain) and `POST /api/outside/submit`. Submit re-runs the
  full `/api/tx/plan` guard set (executable, no prior final submission, approval
  still verifies against the current chain owner key), then RE-DERIVES the calls
  from the LIVE mandate and compares them field-by-field to the signed typed data,
  recomputes the controller-bound digest and verifies it against the controller's
  chain-read public key, checks the window is open and the nonce unconsumed, packs
  the wire FLAT (OBS-16), and relays via the deployer key. `/api/tx/receipt` was
  extended so an outside submission's record is only complete when the chain also
  reports the nonce burned. The relayer and every chain read are injectable, so
  all controls are proven network-free.
- **Controls (OBS-08), 20 of them** in `tests/outside.test.mjs`: wrong signer vs
  the chain controller, wrong wallet key, calls edited after signing, envelope
  mutated after signing, stale mandate, expired window, consumed nonce,
  cross-chain message, specific-caller message, recorded-selector drift, replay,
  node-refusal verbatim, no-hash verbatim, REVERTED receipt, and
  BROADCAST-only-until-receipt. Full JS suite **235/235, 0 skipped**.
- **LIVE PROOF.** `permission-core/tools/live-outside-proof.mjs` drives the REAL
  console server (default live-network injectables) on an ephemeral port with a
  throwaway store: over-cap ask 50 → DENY → proposal `3e2574924b0e3d1a` → owner
  execute-once → APPROVED_ONCE → plan (controller `0x5c7b89fe...`, nonce
  `0xf92bc7dd...`) → mock-wallet signs `wallet-snip12-src9` → server relays
  `execute_from_outside_v2` → tx
  `0x4b0593048ae51625df461b63359d01fd76143218f91d3330f5cb7a62aea0bfe`
  **SUCCEEDED**. Read back from chain: merchant 5 → 55 (Δ 50 = the approved
  amount), nonce consumed, submission flipped to SUCCEEDED only from the receipt.
  `all_checks_passed: true`. Record: `permission-core/.data/phase5-outside-proof.json`.
- **The honest limit this leaves.** The mock wallet holds the OWNER key, so the
  owner private key signs for it exactly as a wallet's own key signs for a real
  wallet — this proves every line of OUR side (connector scheme, server controls,
  relay, chain verification). The one thing it cannot prove is the real Argent X
  extension's own signing behavior, which the harness browser cannot install. That
  is precisely phase 6's handover, in the user's browser.
- **Was OPEN (owner's call), now RESOLVED 2026-10-26: the console UI wiring.** The final-transaction screen
  still uses the pasted-key `signInvoke` → `/api/broadcast` path; wiring the
  connected wallet's `authorizeCalls` → `/api/outside/submit` into that screen is
  the remaining step. Because the current console is the pre-Track-4 artifact the
  owner has said they cannot understand, it is a candidate to fold into Track 4's
  plain-language rebuild rather than patch twice. **Superseded the same day:**
   the owner chose "wire it NOW" (phase 6 depends on it — after the handover
   rotates the owner key to the real wallet, the amendment + anchor loop phase 6
   proves in the user's browser can only go through the wallet path), the wiring
   is built, and the harness browser proved it live on Sepolia — next section.

### Phase 5 UI wiring (2026-10-26): the wallet button is live in the console, proven in the harness browser

- **The wiring (`web/app.js`).** The wallet is one thing: `S.wallet = { info,
  signer }`. Its presence chooses the submission mode (`planMode()`): a
  connected wallet flips the final-transaction panel from the pasted-key
  `signInvoke` → `/api/broadcast` route to the SNIP-9 route
  (`/api/outside/plan` → `authorizeCalls` → `/api/outside/submit`); any mode
  change drops and re-fetches the plan because the plan shapes differ. The new
  outside panel shows the authorization facts in plain words (chain, caller,
  one-shot nonce, window, gate, controller with its chain-read key, gas-only
  relayer), mirrors the server's controller check client-side in plain words
  (wrong wallet → refusal before any popup), and the pasted-key panel gained
  wallet connect buttons as a page-reload recovery path — after phase 6 that is
  the only door left open. Escape hatches: re-plan, or disconnect and fall back
  to a pasted key.
- **Deliberate behavior change.** The wallet connection now SURVIVES the
  resolution signature through the final transaction, replacing the old
  "re-connect for the next one" hygiene note. Reason: one decision spans two
  signatures; the tab holds no key material; the wallet's own popup per
  signature IS the deliberate confirmation. Pasted keys are still forgotten the
  moment they are used.
- **The browser proof caught a real bug before any chain action** (the exact
  thing the proof exists for). Resolution notes are built with the UI's
  shortened addresses, which contain '…' (U+2026) — and the SNIP-12 `string`
  encoder packs text into felts, refusing non-ASCII rightly and loudly. Every
  wallet-signed resolution was dead on arrival: "Refused. typed data: string is
  not ASCII". Fix at the single carrier entry point (`mandateActionTypedData`):
  typographic look-alikes fold to ASCII ('…'→'...', em/en dashes, smart quotes,
  NBSP) — what the owner reads is unchanged — and anything with no look-alike
  (emoji, accents) stays a loud refusal. Sound on both sides because the server
  re-hashes the CARRIED typed data and never rebuilds the note (checked before
  editing). Pinned by two controls (fold semantics + surviving refusal); suite
  235 → **237/237**. The canonical resolution digest is note-independent — the
  preview digest was byte-identical before and after the fix. OBS-22.
- **LIVE walkthrough (harness browser, injected mock wallet, real server, real
  Sepolia).** Over-cap ask 40 (> cap 30) → DENY → proposal `aae8693c90a3adee`
  → connect mock Argent X (enable, chain felt, `get_public_key` chain-read,
  owner-key match) → preview digest `0x0269e25c...3a5d` → **sign resolution in
  the wallet** (`wallet-snip12-v1`, carried note `'Approve once: 40 to
  0x079e...cf38.'` — folded) → server: "verified against the owner key on
  chain" → wallet persisted → outside plan auto-loaded (fresh nonce
  `0x9a04440e...`, controller = mock wallet, 16-minute window) → **Sign in
  wallet and send** (`wallet-snip12-src9`) → server re-verified and relayed via
  the gas-only deployer key → tx
  `0x3b8bb0758dc96b66f69bd417fe797d19e6e2d10fb7bc7f066240a160b9d16ea`
  **SUCCEEDED**. Read back: merchant 55 → 95 (Δ 40 = the approved amount),
  `nonce_consumed: true`, submission record `kind: outside / via:
  outside-relay`. Exactly two wallet popups fired (the mock logs every
  `signMessage`). Independent witnesses that cannot lie to each other: page
  panel + flash, network log (preview / resolve / outside-plan /
  outside-submit / tx-receipt all 200), server records
  (`.data/submissions.json`, `.data/demo-proposals.json`), the chain balance,
  the mock's own signature log.
- **Harness traps hit and recorded** (observations.md): the accessibility
  snapshot was blind to the re-rendered screen (OBS-12 — the walkthrough was
  driven by dispatching the page's own events, the same listeners a user's
  mouse reaches); navigating to the SAME url is a hash-only navigation that
  does NOT reload modules — the stale `typed-data.js` repeated the pre-fix
  error until a real reload plus an in-page module-version probe (`typeof
  foldNoteAscii === 'function'`) proved the new code was live (OBS-22
  postscript); screenshots need a physically visible window, which the harness
  browser does not have — that witness is recorded as blind, and the tab stays
  live in the Review pane.
- **The honest limit is unchanged.** The mock wallet holds the owner key, so
  this proves every line of OUR side including the full UI path — but not the
  real Argent X extension's own signing behavior. That is phase 6, in the
  user's browser, and the door it needs is now open.

### Phase 6 (2026-10-26): the handover is pinned, tooled and dry-probed — the live act awaits the user's browser

- **The anchor wallet path came first (deliberate ordering).** The amendment +
  anchor loop phase 6 proves in the user's browser must work AFTER the
  handover, when the pasted key is dead (t37 proves the replaced key stops
  validating). So the résumé's anchor gained the wallet route first: a
  `purpose: 'anchor'` branch in `/api/outside/plan` + `/api/outside/submit`;
  the guards extracted into one shared `outsideGuardedAnchor()` used by
  `/api/anchor`, `/api/anchor/plan` and both outside endpoints (ONE definition
  of "anchorable" — controls 1–4 plus flat wire packing in
  `verifyOutsideAuthorization()`); `renderAnchorWalletPanel`/`onAnchorOutside`
  in `app.js` with plan invalidation on lifecycle changes. Anchor submits
  deliberately write NO submission record — the anchor record is the only
  record. 8 new controls (OBS-08), suite 237 → **245/245, 0 skipped**, style
  gate PASS.
- **Live proof (harness browser, mock wallet, real server, real Sepolia) +
  an independent verifier.** `scripts/agent-act.mjs` appended honest record #5
  (real engine, persisted witness, chain deliberately behind) → the résumé's
  wallet anchor: plan facts all chain-read (registry `0x03484789...`, entry
  `anchor`, calldata `[agent, root, 5]`, fresh nonce `0x5af95b36...`,
  controller `0x5c7b89fe...` with its chain-read key, gas-only relayer),
  **exactly 1 popup** (OutsideExecution over that nonce) + 1 contract read
  (`get_public_key`) → tx
  `0xa68c01dc77a02be47f9f2e44b723ebd791fa2647952001f56fc3cff688cd7d`
  **SUCCEEDED** (ACCEPTED_ON_L2, INVOKE v3) → the résumé's fresh chain read
  shows "The chain holds this exact fingerprint … 5 records", anchors in slot
  2; `state.json` gained the anchor (`source: "console-relay"`);
  `submissions.json` correctly gained nothing. Independent of the console
  entirely: `proof-anchor-verify.mjs` recomputes the fingerprint from the
  signed evidence file and reads the chain raw — `VERIFY_RESULT ok:true`, 8/8
  checks, including sender-is-the-gas-only-deployer-AND-NOT-the-owner and
  nonce-burned (`is_valid_outside_execution_nonce` → `0x0`).
- **The handover mechanics, read from the artifact — never from memory.** OZ
  v4.0.1 (scarb checkout `87e32f3d`), `packages/account/src/account.cairo`:
  `set_public_key` (L156) requires `assert_only_self()` — only inside the
  gate's own `__execute__`, i.e. an owner-signed invoke on the gate (t06
  already proves a session key can never produce one) — AND
  `assert_valid_new_owner` (L323–338): the NEW key must sign
  `poseidon('StarkNet Message', 'accept_ownership', gate, current_owner_pub)`,
  verified via `is_valid_stark_signature`; failure `'Account: invalid
  signature'`. That is a RAW hash — unreachable through the Wallet Standard
  (`signMessage` signs SNIP-12 typed data only; the binding finding behind
  phases 4–5) — so the signature must come from Argent X's EXPORTED private
  key, used once locally in the tool, never stored, never sent to any server.
  starknet.js 10.8.0 exposes no poseidon (probed: top-level
  `poseidonHashMany` undefined, `crypto` empty of it); `@scure/starknet` —
  already a `gate-account/tools` dependency — provides `poseidonHashMany`, and
  the console's own `typed-data.js` provides `shortStringEncode`. Both
  primitives are already pinned to the starknet.js oracle in
  `typed-data.test.mjs`.
- **The cross-language pin (t36–t38; snforge 42 → 45/45).**
  `tools/accept-ownership-vector.mjs` prints
  `0x10a910c44899be4514cd5705279c4664852097bcb35a1e75eb3fd844a7ae720` for the
  frozen fixtures (the v0.3 gate + the pre-handover owner pub — a vector pins
  hash maths, never live state); t36 pins the Cairo mirror against that
  literal; **t37 performs the REAL rotation** on a live account
  (`set_public_key [new_pub, 2, r, s]` via `owner_execute`; afterwards the
  chain names the new key, the new key validates `VALIDATED`, and the replaced
  key returns `0` — the pasted key's death, proven before it happens); t38 is
  the OBS-08 negative: a stranger signs the CORRECT hash inside an
  otherwise-perfect owner invoke → refused (panic tuple observed verbatim,
  OBS-23). If the JS and Cairo maths ever diverged, the rotation would revert
  on chain after the old key was already gone; this pin makes that impossible
  to miss.
- **The handover is ONE atomic invoke — the pasted key's last act.**
  `[set_public_key(wallet_pub, [r, s]), set_wallet_controller(wallet_addr)]`,
  signed by the pasted owner key through the gate itself. Starknet invoke
  atomicity means no partial states: either the wallet owns the gate AND is
  its SNIP-9 controller, or nothing changed. `__validate__` checks the OLD key
  once, before either call executes; both calls are caller-gated, safe in
  either order.
- **The tool: `gate-account/tools/handover.mjs`** (wallet-controller.mjs's
  conventions: `*_RESULT` lines per OBS-19, padBounds per OBS-10, receipts
  over exit codes, every step read back from the chain). `--check <addr>`:
  deployed? what key does the chain say? STRK balances of wallet/gate/
  deployer; refuses the gate, deployer and mock addresses by name. `--fund
  <addr> <strk>`: deployer → wallet, plus a gate top-up below the minimum (the
  handover invoke is sent BY the gate and pays from its balance). `--prepare
  <addr> <keyfile>`: the one moment the exported key exists — derive its pub,
  match the chain's copy, compute the accept-ownership hash from CHAIN-READ
  facts (gate owner read live, cross-checked against the record), sign
  locally, honesty-probe the wallet account both directions (own key →
  `'VALID'`, stranger → refused — the gate will delegate SNIP-9 verification
  to it, so a rubber stamp would make the whole story theater), then DELETE
  the keyfile before anything else can happen; the prep file holds `{r, s}` +
  facts only. `--execute`: re-checks that nothing drifted since `--prepare`
  (gate owner, pasted-key derivation, wallet key), dry-run estimate (a would-be
  revert fails HERE, before anything lands), padded bounds, receipt, then
  reads BOTH facts back. `--verify`: full sweep including the negative control
  — a signature by the OLD pasted key must NOT validate on the gate anymore.
  Dry probes passed: usage exit 2; the mock-wallet address is refused ("the
  handover needs the user's REAL Argent X address"); an undeployed address is
  detected with live balances (gate 1.69 STRK, deployer 46.6 STRK — funding
  ready).
- **Demo re-run with witness persistence (evidence never removed,
  demonstrated live).** The original demo's witness keys were ephemeral and
  lost; the honest fix was persistence plus a re-run, never staging.
  `demo-layer-d.mjs` now writes the app-witness runtime
  (`permission-core/.data/demo-agent-runtime.json` — the witness signs facts
  only, can never move funds) and re-ran **18/18** for a NEW agent
  (`0x00a852fe...`, witness `0x75d6344c...`). The OLD agent's 4 records stay
  in the same evidence file (8 total), and the run's own tamper check broke on
  the OLD agent's record — the file's integrity spans generations. `scripts/
  agent-act.mjs` (new) keeps the SAME agent acting between runs with real
  engine decisions (record #5: `sandbox-allowed`, ALLOW within-mandate). The
  demo's stale hardcoded token was replaced with state-file reads — the
  spending gate denies token mismatch, so a re-run would otherwise have failed
  its own checks (OBS-21 postscript 2).
- **What remains (the user's browser — the only witness the harness cannot
  be).** Install Ready X (Argent X's new name since late 2025 — see "The
  rebrand" below) → Sepolia → share the address → `--fund` → deploy
  the account in Ready X → the wrong-wallet refusal shown BEFORE the handover
  (connect where the console asks for the owner key: it must refuse and name
  both keys, in plain words) → export the private key to a local file →
  `--prepare` / `--execute` / `--verify` → re-connect (accepted — the chain
  now names the wallet's key) → the full amendment + anchor loop with wallet
  popups only, receipts recorded. Plain-language steps:
  `phase6-handover-checklist.md`. After `--execute` lands, `keys.owner` in
  state.json is marked HISTORICAL (never deleted), and phase 6 closes with the
  strongest proof this project can make: a key the server never saw, in a real
  wallet, doing a live amendment and a live anchor.

### Real-wallet probe (2026-10-26): Ready X is ArgentAccount v0.4.0 — get_owner, 4-felt signatures

The user's wallet (`0x0022239D...`) was checked live before any key existed.
Facts, all read from the chain:

- deployed; class `0x36078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f`;
  `get_name` = "ArgentAccount"; `getVersion` = "0.4.0".
- owner `0x4fb24b55f25e2018a28d1f62ad37d43a366d1282d875d438987a82cf951e7d2`,
  read via **`get_owner`**; `get_owner_type` = 0 (`SignerType::Starknet`). The
  account exposes **no `get_public_key` at all**.
- guardian configured: `get_guardian` = `0x7d2f7457441fa778c23e4c0150ae3c854dbae5bb24efa668739576c8f25822b`,
  `get_guardian_type` = `Some(Starknet)` (`[0x0, 0x0]`). Informational for the
  handover (pure ECDSA on the gate); relevant to the later SNIP-9 delegation
  only insofar as the owner key must still validate.
- `is_valid_signature` format — **corrected from source** (`account-0.4.0` tag,
  `src/presets/argent_account.cairo` `parse_signature_array` +
  `is_valid_span_signature`; `docs/argent_account.md` "Signature format"):
  * **Concise (legacy):** 2 felts `[owner_r, owner_s]` (owner pubkey from
    storage) — valid ONLY when no guardian. 4 felts
    `[owner_r, owner_s, guardian_r, guardian_s]` — both pubkeys from storage.
  * **Standard:** `Array<SignerSignature>` = `[count, signer_type, pubkey, r, s, …]`.
    One Starknet signer = 5 felts (`count=1` + 4). Span must be fully consumed.
  * `is_valid_span_signature` asserts **exactly 2** SignerSignatures when
    `has_guardian()`, else exactly 1.
  * This wallet **HAS a guardian**, so owner-only signatures can never return
    `VALID`. Observed reverts/zeros all match: 2-felt concise -> 1 sig ->
    `invalid-signature-length`; 3 felts -> `invalid-signature-format`;
  4-felt `[0x0, OWNER_PUB, r, s]` parsed as CONCISE owner+guardian
  (owner_r=0, owner_s=pubkey, guardian_r=r, guardian_s=s) -> `0x0`;
  5-felt standard count=1 -> `invalid-signature-length`.
  * The earlier "4-felt `[signer_type, pubkey, r, s]`" reading was WRONG for
    this account — it was concise-format misinterpretation.
- wallet balance at check time: **74.9222 STRK**, deployed — no funding needed.

Tool change: `handover.mjs` now resolves the owner through `get_public_key`
(OZ) or `get_owner`+`get_owner_type` (Ready X); probes with the CONCISE
`[r, s]` format; detects `has_guardian` and **SKIPS the honesty probe loudly**
when set (recorded as `honestyProbe.skipped` in the prep, `SKIP` lines in
`--verify` — never a silent pass); records `walletOwnerGetter` /
`walletOwnerType` / `walletSignatureFormat` / `walletHasGuardian` in the prep;
refuses non-Stark owner types. `--check` reports `accountName`,
`accountVersion`, `guardianPublicKey`, `hasGuardian`. The handover math is
unchanged: the gate's `set_public_key` verifies pure ECDSA over the
accept-ownership hash with the new pubkey — it never calls the wallet's
`is_valid_signature`.

Open flag (recorded, not assumed): the console's `normalizeWalletSignature`
accepts 2-value shapes and loudly refuses longer arrays. With a guardian set,
Ready X's `signMessage` must produce a combined owner+guardian signature
(concise 4-felt or standard 9-felt). The ACTUAL output must be OBSERVED at the
connect step before the step-10 wallet-signed SNIP-9 demo; this is now a known
blocker for the outside path, not a hypothetical.

## The rebrand (2026-10-26): Argent X is now "Ready X"

**What happened.** The user reported that Argent wallet is now known as Ready.
Fact-checked the same day via six web searches plus fetching ready.co: Argent
rebranded to **Ready** in late 2025. The mobile app is now **Ready**
(ready.co), and the Starknet browser extension formerly known as **Argent X**
has been renamed **Ready X** (also written "Ready Wallet"). Same company, same
product, same smart contract accounts — just a new name.

**Sources (all retrieved 2026-10-26):**

- blockspot.io/wallet/argent — "In 2025 the company rebranded: the main mobile
  product is now distributed under the Ready brand at ready.co, while the
  Starknet browser extension previously known as Argent X has been renamed
  Ready X. Both products retain the same..."
- changelly.com best-ethereum-wallets — "Ready mobile app and Ready Wallet
  browser extension (formerly Argent X) for Starknet"
- mexc.com glossary — "Argent X ... is now commonly presented as Ready Wallet
  or Ready X in official branding"
- spendnode.io/crypto-cards/ready — "Ready (formerly Argent) is a
  self-custodial Starknet wallet"
- pixelwebsolutions.com best-defi-wallets — "Argent rebranded to Ready in
  2025, and the Starknet extension formerly called Argent X is now Ready X.
  It remains a smart contract wallet"
- x.com/ready_co — "Rebrand: Rebranded from Argent to Ready"
- ready.co itself (fetched) — current homepage; support at help.ready.co;
  developer docs still at docs.argent.xyz/wallet-connect-and-argent; Ready X
  terms of service/privacy linked from the footer.

**What did NOT change (why all phase 1-6 research remains valid):**

- Same account contracts (OZ-based smart accounts), so the SNIP-9 findings,
  controller binding, `set_public_key`/`accept_ownership` mechanics, and the
  export/deploy paths all carry over as-is.
- Support still at support.argent.xyz; developer docs still at
  docs.argent.xyz — the argent.xyz domain is still alive, the rebrand is at
  the name level.

**Impact on our code (edited + re-tested the same day):**

1. `web/wallet.js` — the console's wallet detection is **standards-first**: it
   enumerates `window.starknet` (Wallet Standard) and whatever id the wallet
   declares. A rebrand cannot break detection — any injected object is
   enumerated regardless of name. As insurance for legacy alias surfaces,
   added `window.starknet_ready` and `window.starknet_readyX` alongside
   `window.starknet_argentX`/`window.starknet_braavos`.
2. `KINDS` in `web/wallet.js` — ready/readyX ids map to the existing
   `'argent-x'` kind. This is a **cosmetic classifier only**: the sole place
   kind is load-bearing is `kind !== 'pasted-key'` (wallet vs. pasted-key
   behavior), and one kind means records stay stable across the rebrand. The
   UI shows the wallet's own declared `walletName` — whatever the extension
   calls itself ("Ready X") — never a hardcoded brand.
3. The no-wallet error now reads "Install Ready (formerly Argent X) or
   Braavos."
4. Suite re-run after the edits: **249/249 pass, 0 skipped** (three new tests
   pins Ready alias detection); style gate PASS. No test pinned the old
   brand string.

**What is OBSERVED, not assumed.** What the rebranded extension actually
injects (`window.starknet` only? Legacy aliases too? What `id`/`name` does it
declare?) will be read from the user's live browser at the phase-6 connect
step and recorded — per the project-wide rule that facts come from
artifacts/chain/live observation, never from memory or docs (OBS-08/OBS-18
family).

**Checklist + docs renamed.** `phase6-handover-checklist.md` now uses Ready X
naming throughout, and warns: **do not add a guardian** — guardian/multisig
setup produces >2-value signatures that the console loudly rejects by design
(`normalizeWalletSignature` in `web/wallet.js`); one signer is what the demo
needs.

## Recommendation

**Path B — the native wallet — with the shared signer interface built first.**

1. The fact-check flipped the premise: the embedded option, on Starknet today,
   is *less* sovereign than the console we already shipped. Track 2 exists to
   remove the pasted key, not to re-introduce a company-side signing oracle.
2. Path B's typed-data half (resolutions, ladder) needs **no contract change**
   and delivers the visible win early: "signed in your Argent X — our server
   never saw a key".
3. The Cairo work (SNIP-9) was already on the contract's own roadmap comment,
   uses the standard OpenZeppelin component, and unlocks the parked v1.1
   paymaster/gasless item later.
4. Either way the first step is identical: refactor the console's four key
   fields into one **Signer interface** (`signDigest`, `authorizeCalls`) with
   the pasted key as its first implementation — track 1 built exactly the seam
   NEXT.md predicted.

Path A stays recorded as a legitimate future option (e.g., for users with no
wallet who want email login), but only if Privy later ships client-side
Starknet signing that never transits a company backend.

## Sources (retrieved 2026-10-25)

- https://www.starknet.io/blog/privy-brings-seamless-embedded-wallets-to-starknet
- https://docs.starknet.io/build/starkzap/integrations/privy
- https://docs.privy.io/wallets/using-wallets/other-chains (raw signing: REST +
  server SDKs; React/RN client hooks)
- https://docs.privy.io/recipes/use-tier-2 (backend-signs pattern)
- https://docs.privy.io/wallets/wallets/export (export available on every tier)
- https://docs.privy.io/recipes/core-js (js-sdk-core = auth client, "reach out
  to the Privy team" warning)
- Privy tier table (via cavos.xyz comparison, Oct 2026): Starknet in the
  sign-only tier
- `gate-account/src/lib.cairo` (our own source: embedded OZ key management,
  `is_valid_signature`, upgradeability, SNIP-9 absent, v1.1 comment)
