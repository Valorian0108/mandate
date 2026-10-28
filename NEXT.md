# What is next, and in what order

Written 2026-10-25, after the Résumé screen (console 05) went live. Three things were
deliberately left out of v1. They are the next work, in this order. Three more items are
parked and are *not* next — they are other layers or later versions.

---

## 1 · The last hop: the browser signs the transaction too

**Where we are.** The browser already signs the *decision* (the resolution digest, the
ladder change). But the final Starknet transaction is signed and sent by the server
spawning `owner-tx.mjs`, which reads the testnet owner key from disk. So the sentence
"the server never holds the owner key" is true for the decision and false for the last
hop.

**Where we want to be.** The browser signs the transaction itself, with the key that is
already in the tab. The server becomes a postbox: it carries the finished, signed
transaction to the chain and nothing else.

**How.**
- Reproduce the chain's transaction-hash maths in `web/signer.js` (the same curve code
  the page already trusts). The rule of this project applies: the maths is never typed
  from memory — `starknet.js` in the test suite is the judge, and a drift test fails
  loudly if browser and library ever disagree on a hash.
- New server endpoint that only broadcasts: it checks the transaction is *from* the
  GateAccount and for *this* chain, then hands the bytes to the RPC and reports the
  chain's answer verbatim. Anything else is refused. It cannot substitute calls,
  because it never builds them.
- The console's Approvals submit and the Résumé anchor button switch to
  browser-signs + server-relays. `owner-tx.mjs` stays for the demo scripts only, and
  stays labelled.

**Proof before claiming done.** Browser hash == library hash for identical calls, nonce
and fees; the relay refuses a wrong-sender transaction, an unsigned one, and a
replayed one; and one live Sepolia submission end to end from the browser, read back
from the chain.

**Status (2026-10-25): ✅ DONE — every proof met, live on Sepolia.**
- Browser hash == library hash: `permission-core/tests/tx-signer.test.mjs`, 7 drift
  tests against starknet.js 10.8.0 as a test-only oracle. The maths lives in
  `web/tx-signer.js` — node-free, served to the page.
- Relay refusals: `permission-core/tests/tx-broadcast.test.mjs`, 21 control tests —
  wrong-sender-but-validly-signed, wrong key, tampered calldata, wrong chain, garbage
  bodies, state self-disagreement, node errors verbatim with nothing recorded,
  double-broadcast after a final receipt, receipt-only final statuses, and the
  anchor's lying-claim / once-only / unconfirmed refusals. Suite: **165/165, 0 skipped**.
- Live end to end from the browser: the amendment 25 → 30 was signed in the tab,
  relayed, the node's hash equalled the signed hash, receipt SUCCEEDED /
  ACCEPTED_ON_L2 (`0x7bdea2e5b1d28830d6b4b5d9eddcafba0557be88566a8bf67f94be2f75b0887`),
  the chain re-read shows cap 30 / spent 0, and the record says SUCCEEDED via `relay`
  — written from the receipt alone.
- Endpoints: `/api/tx/plan`, `/api/broadcast`, `/api/tx/receipt`, `/api/anchor/plan`,
  `/api/anchor/record`. `/api/submit` and `/api/anchor` remain, labelled, for the demo
  scripts. The live run also caught a latent UI regression no test could see (a render
  function that returned its HTML instead of assigning it — OBS-13).

## 2 · Real owner keys (no pasted testnet key)

**Where we are.** The owner pastes a throwaway testnet key into a field. Fine for a
demo, never for money.

**Where we want to be.** The key lives in something built to hold it, and the console
only ever asks it to sign a digest it can see.

**How.** First a fact-check, not an assumption: does Privy actually issue Starknet
keys today? If yes, an embedded wallet plugs in behind the console's existing signer
interface. If no, the more user-sovereign answer is the owner's own Starknet wallet
(Argent / Braavos) reached through the standard wallet connector — the console shows
the exact change, recomputes the digest locally, refuses on mismatch, and the wallet
decides. Either way the console's job does not change; only the signer behind the
interface does. Track 1 builds that interface, which is why this comes second.

**Fact-check result (2026-10-25): Privy DOES issue Starknet keys — and we are still
taking the native-wallet path.** On Starknet, Privy is a raw-hash signing service
whose calls are authenticated with a *backend* app secret; even "user-owned" wallets
sign through a company server holding credentials, with no user-visible confirmation
of the opaque hash. That would make our backend a signing oracle — weaker than the
console's current guarantee that the server cannot produce an owner signature at all.
Full evidence, sources and the sovereignty analysis: `track2-wallet-research.md`.
Decision: **Path B — the owner's real wallet (Argent X first, Braavos fact-checked
later)**. Enabling facts, all verified in source: GateAccount already has
`set_public_key` (one-time owner rotation through the track-1 relay), a public
owner-only `is_valid_signature` (typed-data verification against the chain-read key),
and `upgrade`; and OpenZeppelin v4.0.1 — the exact tag in `Scarb.lock` — ships
`SRC9Component` (SNIP-9 outside execution: signed call authorizations with validity
windows and replay-proof nonces, submittable by anyone, unforgeable by the submitter).

**Plan (six phases, each with its own tests and live proof).**
1. ✅ **SNIP-12 typed-data carrier** (2026-10-25): `web/typed-data.js` pinned by 15
   drift/control tests against starknet.js 10.8.0 (oracle, test-only); server
   envelope gained `snip12-v1` alongside `digest-v1` (old records keep verifying;
   audit re-checks both). Live-proven in the browser: proposal `15416da04fc96790`
   declined with a stored `snip12-v1` signature, human-readable note, valid domain.
2. ✅ **Signer interface** (2026-10-25): `web/signers.js` — one contract
   (`signTypedData`, `signMandateAction`, `authorizeCalls`, `signInvoke`,
   `checkAgainst`); pasted key is implementation #1 with behavior unchanged; the
   four key fields collapsed into `S.signers` slots; 8 control tests (no
   serialisable private copy, chain-binding, envelope verified by the server
   verifier, oracle drift). Suite **192/192, 0 skipped**. Live re-verified (decline
   + ladder/anchor key checks through the new path).
3. ✅ **Wallet connector** (2026-10-25): `web/wallet.js` — vanilla `window.starknet`
   (Wallet Standard + Argent X/Braavos aliases), detect, connect, and refusals that
   are loud and plain-worded: no wallet, declined connection, unreadable network,
   wrong network (naming both), unreadable on-chain key, and the headline
   wrong-wallet refusal (the wallet's key is read FROM THE CHAIN via
   `get_public_key`, never trusted from the extension). Off-chain approvals gained
   the `wallet-snip12-v1` scheme: the server hashes the typed data with the
   envelope's `signerAddress` and verifies raw ECDSA against the chain-read owner
   key; the two typed-data schemes are separated by the address their hash binds.
   22 control tests with an honest mocked wallet (oracle hash maths, string[]/
   decimal/{r,s} shapes, guardian arrays refused) — suite **214/214, 0 skipped**.
   Live-proven in the console with an injected mock: wrong-wallet and
   wrong-network refusals shown, then a full connect → preview → decline loop
   recorded as `wallet-snip12-v1` with `signatureValidNow: true` against the real
   chain-read owner key. The page CSP now allows `chrome-extension:` in
   `script-src` (Chrome applies the page CSP to main-world scripts; without it no
   wallet could ever inject — OBS-14). Real Argent X proof stays flagged for the
   user's browser (phase 6).
4. ✅ **Cairo v0.3: controller-bound SNIP-9** (2026-10-25, LIVE on Sepolia) —
   `wallet_controller` slot settable only through the owner-signature gate;
   `execute_from_outside_v2` hashes with `account_address := wallet_controller`
   and delegates verification to the controller's `is_valid_signature`; nonces,
   windows and caller-binding stay in GateAccount. **snforge 42/42** (t01–t35 +
   7 evidence; controls: happy path, expired window, too-early, replayed nonce,
   substituted calls, wrong key, session-key refusal, unregistered controller,
   registered controller that refuses, controller/upgrade owner-gating, in-place
   upgrade preserving state), **JS 215/215, 0 skipped** (new SNIP-9 pin test).
   Two-hop hash pinning: contract == Cairo mirror (happy paths) == JS (t35 +
   `typed-data.test.mjs` literal `0x5f4becd3...6718c`) == starknet.js oracle;
   canonical vector printed by `tools/snip9-vector.mjs` (frozen v0.2 fixtures —
   a vector pins hash maths, never live state).
   **PLAN CORRECTION (recorded): redeploy, not in-place upgrade.** The v0.2 class
   has NO upgrade entry point, so "declare + in-place upgrade" was impossible.
   Instead: declared v0.3 (class `0x3acf8f1f...b8cb`, tx `0x754667b9...b5c5c`),
   then a fresh `deploy_account` signed by the owner key (salt `GATE_V3`) →
   **new gate `0x7d1d8cad365390adfb2f4f9f89277663c555d2eed790f1c4983c44a002570f1`**
   (tx `0x31deb8db...0bd75`), new ERC20Mock `0x28c46a86...e6148`, mandate
   MIRRORED from live old-gate reads in one owner tx (`0x15e14cb7...0ff23`:
   session, policy 30/100/2592000s, merchant allowlist, `set_wallet_controller(self)`
   — the pasted-key shape), evidence root re-anchored (`0x12c89e07...68aa`).
   v0.3 adds owner-gated `upgrade` (UpgradeableComponent), so this is the LAST
   redeploy — from here on, class changes are ordinary owner-signed actions
   (t34 proves in-place upgrade preserves state). Old gate left live with its
   full history; evidence never removed.
   **Live SNIP-9 proof SUCCEEDED**: owner-key-signed typed data (digest
   `0x1df04e47...9d12b`, nonce `0x1a174f874e4`), RELAYED BY A THIRD PARTY (the
   deployer — different key, different address), tx
   `0x4a26c6b14fe30b3743b6bff2f5c652e47118e49cc2cec5fe0066ee02f99dfc5`:
   merchant balance 5, gate 999,995, nonce consumed. `migrate-v3.mjs --verify`
   **11/11 PASS**, including library-native SNIP-9 detection
   (`Account.getSnip9Version()` → `'2'`). Correction found en route: the
   ISRC9_V2 interface ID `0x1d1144bb...89872` is a SPEC CONSTANT (computed with
   the Cairo v2.5.0-era `Call` struct per the SNIP-9 NOTE), NOT the XOR of the
   two current selectors — the contract registers the OZ-imported constant
   (correct); only the verify tool's first derivation was wrong.
   Full record: `.sepolia/migration-v3.json` + `.sepolia/state.json`
   (`migration_v03` section); console/tools repointed via state.json.
5. ✅ **Wallet-driven final transactions** (2026-10-26, LIVE on Sepolia) — the
   wallet signs a SNIP-9 OutsideExecution authorization (exact calls + expiry,
   bound to the controller the gate names ON CHAIN); the console server relays it
   as an EXTERNAL submitter and records nothing until the receipt is final AND the
   chain says the one-shot nonce is burned.
   **Server:** `POST /api/outside/plan` + `POST /api/outside/submit`, and
   `/api/tx/receipt` extended to read back the nonce burn for outside submissions.
   Every guard mirrors `/api/tx/plan`: proposal executable, no prior final
   submission, approval still verifies against the current chain owner key, calls
   RE-DERIVED from the LIVE mandate and compared field-by-field against the signed
   typed data, controller-bound digest recomputed and verified against the
   controller's chain-read public key, window open, nonce unconsumed, wire packed
   FLAT (OBS-16). Relayer = the gas-only deployer key via starknet.js in-process
   (injectable); controller/key/nonce reads via chainCall (injectable).
   **Controller:** `gate-account/tools/wallet-controller.mjs` deployed a wallet-shaped
   controller — a second UDC instance of the SAME standard OZ account class the
   deployer runs, constructed with the owner public key (`--deploy` tx
   `0x21e1e174...13b2`, wallet `0x5c7b89fe...af5ec`), honesty-probed (`--probe`:
   `is_valid_signature` → `'VALID'` for the owner key, NOT-`'VALID'` for a wrong
   key — the gate's delegation is real, not a rubber stamp), registered with one
   owner tx (`--register` `set_wallet_controller`, tx `0x340c3174...8962`), and
   read back (`--verify` **7/7 PASS**, incl. `getSnip9Version()` → `'2'`). This
   moves the controller off the phase-4 self-controller shape; phase-4 receipts
   stay valid on-chain forever and the slot is owner-gated, so phase 6 repoints it
   at a real Argent X.
   **Tests:** `tests/outside.test.mjs`, 20 controls (OBS-08) — wrong signer vs
   chain controller, wrong wallet key, edited calls, mutated envelope, stale
   mandate, expired window, consumed nonce, cross-chain, specific-caller,
   selector-drift, replay, node-refusal verbatim, no-hash verbatim, REVERTED
   receipt, BROADCAST-only-until-receipt. Full JS suite **235/235, 0 skipped**.
   **LIVE PROOF** (`permission-core/tools/live-outside-proof.mjs`, driving the real
   server with default live-network injectables): over-cap ask 50 → DENY →
   proposal `3e2574924b0e3d1a` → owner execute-once → APPROVED_ONCE → plan
   (controller `0x5c7b89fe...`, fresh nonce `0xf92bc7dd...`) → mock-wallet signs
   `wallet-snip12-src9` → server relays `execute_from_outside_v2` via the deployer
   → tx `0x4b0593048ae51625df461b63359d01fd76143218f91d3330f5cb7a62aea0bfe`
   **SUCCEEDED** (ACCEPTED_ON_L2). Read back from chain: merchant balance 5 → 55
   (Δ 50 = the approved amount), nonce consumed, submission flipped to SUCCEEDED
   only from the receipt. `all_checks_passed: true`.
   Full record: `permission-core/.data/phase5-outside-proof.json`,
   `gate-account/.sepolia/wallet-controller.json`, `.sepolia/state.json`
   (`phase5_outside_relay`).
   **UI wiring (DECIDED 2026-10-26, owner): wire it NOW.** The console's
   final-transaction screen still used the pasted-key `signInvoke` →
   `/api/broadcast` path. The earlier "fold into Track 4" candidate was
   checked against phase 6's wording and REJECTED: after the handover rotates
   the owner key to the real wallet ("the pasted key's last act"), the
   amendment + anchor loop phase 6 proves in the USER's browser can only go
   through the wallet path — folding would block phase 6, which the committed
   order puts before Track 4. So: wire `authorizeCalls` → `/api/outside/submit`
   into the final-transaction screen now (one screen, patched once more),
   prove it in the harness browser with the mock wallet, then hand phase 6
   over. Track 4 later rebuilds the screen around plumbing that works.
    **UI wiring (DONE 2026-10-26) + harness-browser proof (LIVE).** The wallet
    path is wired into the Approvals screen: a connected wallet flips the
    final-transaction panel to the SNIP-9 route (`planMode()` →
    `/api/outside/plan` → `authorizeCalls` → `/api/outside/submit`), the
    authorization facts are shown in plain words (caller, one-shot nonce,
    window, gate, controller, gas-only relayer), the server's controller check
    has a plain-words client mirror, the pasted-key panel gained wallet connect
    buttons (page-reload recovery — after phase 6 the only door), plus escape
    hatches (re-plan / fall back to a pasted key). **Deliberate behavior
    change:** the wallet connection SURVIVES the resolution signature through
    the final transaction (one decision spans two signatures; no key material
    in the tab; the wallet popup per signature IS the deliberate confirmation),
    replacing the old "re-connect for the next one" note; pasted keys are still
    forgotten the moment they are used. The browser proof caught one real bug
    first: resolution notes carried the display ellipsis '…' (from shortened
    addresses) into the SNIP-12 carrier, whose string encoder refuses non-ASCII
    — every wallet signature was dead on arrival. Fixed at the single carrier
    entry point (`mandateActionTypedData` folds typographic look-alikes;
    emoji/accents stay loud refusals; the server re-hashes the carried typed
    data, so both sides agree), pinned by 2 controls — suite **237/237**. Then
    the full loop ran live: proposal `aae8693c90a3adee` (ask 40 > cap 30 →
    DENY) → mock wallet connected → wallet-signed resolution
    (`wallet-snip12-v1`, folded note) → outside plan (nonce `0x9a04440e...`,
    controller = mock wallet) → "Sign in wallet and send"
    (`wallet-snip12-src9`) → server relayed → tx
    `0x3b8bb0758dc96b66f69bd417fe797d19e6e2d10fb7bc7f066240a160b9d16ea`
    **SUCCEEDED** — merchant 55 → 95 (Δ 40), `nonce_consumed: true`, exactly
    two wallet popups, receipts in `.data/submissions.json` +
    `.data/demo-proposals.json`. Full record: `track2-wallet-research.md`
    ("Phase 5 UI wiring"), OBS-22.
6. Handover + live proof in the user's browser: rotate the owner key to the wallet's
   signer key (`set_public_key`, the pasted key's last act), then a full amendment +
   anchor loop with the server never seeing a key. Wrong-wallet refusal shown in
   plain words.

   **Status (2026-10-26): DONE — the live handover executed and verified.**
   Tx `0x2c2b0395f0bf187bdf691683a40c2de123ad957b7f7b70c925c0bfd38888010`
   (SUCCEEDED): one atomic invoke `[set_public_key, set_wallet_controller]`,
   signed by the pasted owner key (its last act). The gate's owner is now the
   user's real Ready X wallet key `0x4fb24b55...e7d2`; the SNIP-9 controller is
   the wallet account `0x0022239D...fCFb`. `--verify`: **9/9 PASS, 0 skips**.
   `keys.owner` marked HISTORICAL in state.json (never deleted). Plain-language
   steps: `phase6-handover-checklist.md`; full record: `track2-wallet-research.md`
   ("Phase 6") + state.json (`phase6_handover`).
   - **Anchor wallet path built and LIVE-proven first** (after the handover the
     pasted key is dead, so the résumé's anchor must go through the wallet):
     `purpose: 'anchor'` branches in `/api/outside/plan` + `/api/outside/submit`,
     one shared `outsideGuardedAnchor()` guard (one definition of
     "anchorable"), anchor wallet panel in `app.js`, anchor submits write no
     submission record by design. 8 controls → suite **245/245, 0 skipped**,
     style gate PASS. Harness-browser proof: honest record #5 via
     `scripts/agent-act.mjs`, exactly 1 wallet popup + 1 contract read, tx
     `0xa68c01dc77a02be47f9f2e44b723ebd791fa2647952001f56fc3cff688cd7d`
     SUCCEEDED, résumé read the chain's copy back (5 records, anchors in slot
     2), independent verifier 8/8 (`VERIFY_RESULT ok:true` — fingerprint
     recomputed from the signed file == chain; sender = gas-only deployer, NOT
     the owner; nonce burned).
   - **Demo re-run with witness persistence** (evidence never removed):
     18/18 for a new agent (`0x00a852fe...`), the OLD agent's 4 records
     preserved in the same file — the tamper check broke on the old agent's
     record; stale hardcoded token replaced with state-file reads (OBS-21
     postscript 2).
   - **Handover mechanics verified from the artifact, never memory** (OZ
     v4.0.1 checkout `87e32f3d`, `account.cairo` L156/L323–338):
     `set_public_key` needs the gate's own `__execute__` (an owner-signed
     invoke) AND the NEW key's signature over
     `poseidon('StarkNet Message', 'accept_ownership', gate, current_owner)`.
     That raw hash is unreachable through the Wallet Standard → the wallet's
     exported key (Ready X, formerly Argent X) signs it LOCALLY, once, and
     the keyfile is deleted — never stored, never sent to the server.
   - **Pins:** `tools/accept-ownership-vector.mjs` prints
     `0x10a910c44899be4514cd5705279c4664852097bcb35a1e75eb3fd844a7ae720`
     (frozen fixtures); Cairo **t36** pins the same literal, **t37** performs
     the REAL rotation (new key validates, replaced key returns 0), **t38**
     refuses a stranger's signature over the correct hash. snforge
     **45/45** (panic tuple observed verbatim — OBS-23).
   - **Tool:** `gate-account/tools/handover.mjs` — `--check` / `--fund` /
     `--prepare` (honesty-probe both directions, keyfile deleted) /
     `--execute` (ONE atomic invoke `[set_public_key, set_wallet_controller]`,
     dry-run estimate first, both facts read back) / `--verify` (incl. the
     negative control: the old pasted key no longer validates on the gate).
     Dry probes passed; balances live-read (gate 1.69 STRK, deployer 46.6
     STRK — funding ready).
   - **Rebrand fact-check (2026-10-26):** Argent X is now **Ready X**
     (Argent → Ready, late 2025; ready.co). Same wallet, same account
     contracts, support/docs still on argent.xyz domains. Console detection
     is standard-first (`window.starknet`), so the rebrand cannot break it;
     `web/wallet.js` gained `starknet_ready`/`starknet_readyX` legacy aliases
     as insurance (KINDS maps them to the cosmetic `'argent-x'`; behavior
     gates only on `kind !== 'pasted-key'`), the no-wallet error names both
     brands, checklist + research doc renamed, guardian warning added.
     Suite re-run after the edits: **249/249, 0 skipped** (three new tests pin
     Ready connect + alias detection), style gate PASS.
     What the extension actually injects gets OBSERVED in the user's browser
     at the connect step, never assumed. Record: `track2-wallet-research.md`
     ("The rebrand").
   - **Real wallet received, guardian removed, handover EXECUTED (2026-10-26):**
     the user's Ready X `0x0022239D...` (ArgentAccount v0.4.0, `get_owner`,
     owner type 0) had its guardian removed before prepare, so the honesty
     probe ran and passed (own key VALID, stranger refused). Signature format
     corrected from `account-0.4.0` source: concise `[r, s]` (no guardian) or
     `[owner_r, owner_s, guardian_r, guardian_s]` (guardian); standard
     `[count, type, pubkey, r, s, …]`. `handover.mjs` adapted (concise probes,
     guardian-aware skips, `norm()` canonicalized via BigInt after a
     leading-zero mismatch caught post-tx). `--prepare` → `--execute` (tx
     `0x2c2b0395...88010` SUCCEEDED) → `--verify` **9/9 PASS, 0 skips**.
     `keys.owner` HISTORICAL. Step-10 console adaptation is now CODE-COMPLETE
     (`normalizeWalletSignature` accepts all four documented shapes; the
     server carries the full array on the wire with a
     `resolveControllerPublicKey` get_owner fallback and refuses r/s-vs-array
     mismatches; JS 254/254, OBS-25). The ACTUAL `signMessage` shape was
     OBSERVED live 2026-10-26 (OBS-29): Ready X returned the STANDARD wrapper
     with one Starknet signer - `[0x1, 0x0, pubkey, r, s]`, five felts,
     `signatureFormat: "standard"` - the exact `standard-1` shape the test
     harness had pre-pinned; the pubkey carried INSIDE the signature equalled
     the chain-read key it was verified against.
   - **Remaining (all need the user's browser - step-10 code is complete):**
     connect Ready X: **DONE 2026-10-26** (OBS-28 - accepted via the console's
     own chain read after the wallet provider's page-origin fetch failed with
     "Failed to fetch"). Observe signMessage shape: **DONE** (OBS-29).
     DONE LIVE (2026-10-27, OBS-33): step 10 on proposal `29dec48f87b015de` -
     the owner exported Ready X's key once, the tab signed the final
     transaction, the server only carried the bytes: tx
     `0x62c0bd18ca50c4fae3a1341d0fa39b8dd4315228b4d09c4a2fdf51acfa1b62b`,
     receipt SUCCEEDED, sender = the gate itself, one call
     set_spending_policy with cap 100, live re-read maxPerCall 100 (was 30),
     tab-computed hash == chain hash. The drift test caught the amendment
     and failed loudly; its over-cap pin is now cap-relative (live cap + 1)
     and the historical 50-unit revert re-decides against today's chain.
     Suite 302/302, 0 skipped.
     DONE LIVE (2026-10-27, OBS-34): the v0.4 design fix. Declared
     `0x663510bc…7070` (class `0x15d47cb5…35ff`, snforge 48/48 incl.
     t39/t40/t41), installed through the console's new "Gate contract" card
     by the owner - price, explicit ack, ONE last pasted Ready X key, signed
     in the tab, relayed with the audit-only action:'upgrade' tag: tx
     `0x55ea5c1f12bcf9130ec1501031a413a12e116ead7491204b0ae33fa6a7566a0`,
     SUCCEEDED / ACCEPTED_ON_L2, nonce 7 → 8. Verified from the node with the
     console out of the loop (verify-upgrade.mjs 15/15): gate class hash ==
     v0.4 class, running ABI carries all eight admin entrypoints +
     execute_from_outside_v2, and session / cap 100 / window / allowlist /
     post-handover owner key all read back unchanged. state.json: v0.4
     everywhere, v0.3 preserved under previous_v03, pending_upgrade → null
     with the full applied record in upgrade_history. OBS-32's circularity
     CLOSED - admin entrypoints now accept self OR the registered
     controller, so future owner actions sign from the wallet, no export.
     Suite 314/314, 0 skipped (twelve new upgrade-path pins).
     DONE LIVE (2026-10-28, OBS-35): the wallet-flow proof. Proposal
     `4883847fbc212efe` (50 units to the stranger, chain-blocked
     recipient-not-allowed) amended by the owner - "allow this recipient"
     signed in Ready X and carried to Sepolia BY THE WALLET ITSELF: tx
     `0x419f306ab0e164fa420b584c0528390d824a271c744e1c59c92fdce5236ebb7`,
     SUCCEEDED / ACCEPTED_ON_L2, sender = the wallet `0x0022239d…b1fcfb`,
     execute_from_outside_v2 on the v0.4 class, inner calls
     is_valid_signature + the gate's allow_recipient, five-felt owner
     signature with the handover key, caller ANY_CALLER, one-shot nonce
     burned. Popup 1's rehearsal passed for the first time (v0.4 made it
     truthful - OBS-32's greyed-out Sign is closed). Tracks 1-3 now have a
     live witness for EVERY path. The same session's three console failures
     were fixed and pinned (321/321 JS, 0 skipped): the false RECORD
     MISMATCH lock card (baseline is now state.json keys.owner_current, the
     handover key - the HISTORICAL owner slot stays as evidence and as the
     fallback), the stuck "Reading…" spinner (AbortSignal.timeout on all
     three fetch seams - mandate-reader call(), server rpcCall(), chainStatus
     - injectable via rpcTimeoutMs, loud "did not answer within Ns" errors,
     pinned against a black-hole node), and the stale allowlist record (the
     stranger is in merchant_allowlist.allowed with a stranger_added note
     citing the wallet tx; the live-alignment stranger pin is now
     chain-relative with a drift alarm).
     PRODUCT GAP found by the two preview refusals (kept as honesty
     evidence): step 10 set per-call cap == window cap == 100, so "raise the
     per-call cap" has NO valid value (150 > window cap refused; 60 <=
     current cap refused) and no form raises the WINDOW cap. FIXED,
     test-first (2026-10-28, same day): amendment kind `raise-window-cap`
     across resolutions.mjs (guards: pointless refused, below-per-call-cap
     refused, token mismatch refused; per-call cap + window seconds preserved
     on the wire; window-restart warning carried), the server allowlist, the
     spending gate's amendmentKinds, and the Approvals form (new option +
     field; the form DEFAULTS to it when the blocked ask exceeds the window
     cap, so the owner is never offered a decision with no valid value). 5
     new pins, suite 326/326, 0 skipped, style PASS; live preview smoke test
     on proposal `97dca512ed101c00` returned the exact wire (100 preserved,
     150 raised, window kept). LIVE PROOF DONE (2026-10-28, OBS-36): the
     owner signed the window amendment in Ready X (popup: "Set spending
     policy", "No balance change", honest ANY_CALLER critical-risk warning
     with its raw i18n key, Sign greyed until "Accept risk") and the wallet
     carried it: tx `0x69b20e5c…fa0d`, SUCCEEDED/ACCEPTED_ON_L2, block
     17267240; chain re-read per-call 100 / window 150 / seconds kept /
     spent 0. A server restart lost the in-flight record, so the hash was
     found by chain-state bisection and adopted via /api/outside/record —
     which 409'd because the record path re-derived against the LIVE policy
     the tx had already moved; fixed test-first with a record-only
     verifyApplied derivation (plan/wire/submit still refuse to SIGN a
     pointless change; tampered tx still refused). 4 new pins, suite
     330/330, 0 skipped. UNLOCKED NEXT: raising the per-call cap to 150 is
     now a valid decision (150 ≤ window 150), then the original 150-unit ask
     can finally be approved once. ALSO DONE (OBS-37, same day): the per-call
     raise to 150 proved live (tx `0x205710f6…1fb`, block 17272013, wallet
     nonce 6, record #8 adopted by bisection — the verifyApplied path's first
     real use). The live policy is now per-call 150 / window 150 / spent 0,
     every value owner-signed and wallet-carried. NEXT: the original 150-unit
     ask is inside the mandate — the agent walks through the gate with no
     human in the loop; then Track 4 demo pass and the standing open
     questions (hackathon/grant/product? first users?).
     THEN the wrong-wallet refusal demo (a different
     wallet must be refused); then a live owner-signed witness attestation
     through the résumé's new witness card (Track 3 is code-complete -
     321/321 JS, OBS-26/28/30/31/32/33/34/35 - its browser half joins this list, still not
     skipped), plus a wallet-signed ladder promotion once the résumé UI can
     reach it. Then Track 4 (plain-language demo pass), public. Layer F last.

**Binding finding (2026-10-25, read from starknet.js 10.8.0 source, decides phases
4–5).** `Account.signMessage(typedData)` passes **the wallet's own address** into
the SNIP-12 hash; a dapp cannot override it. So a native wallet can never sign "as"
the GateAccount. Off-chain approvals are fine (the server hashes with the wallet's
address from the envelope and checks raw ECDSA against the chain-read owner key —
sound once the handover makes the keys equal). On-chain, OZ's `SRC9Component`
hashes with `account_address = self.address`, so it would reject every
native-wallet signature forever. Three options are analysed in
`track2-wallet-research.md` ("Build-time correction"): **(i, recommended)** store an
owner-registered `wallet_controller` address on-chain and verify SNIP-9 signatures
via that controller's `is_valid_signature`; **(ii)** make the owner itself an
address (deep refactor, server loses its local ECDSA gate); **(iii)** keep the
pasted key as on-chain courier (rejected as an end state). **Decided (2026-10-25,
owner): option (i), controller-bound SNIP-9** — phase 4 embeds the SRC9 logic with
the signer parameterised (`wallet_controller` slot, owner-gated registration,
verification delegated to the controller's `is_valid_signature`), plus two extra
snforge controls (unregistered controller; registered controller that refuses).

**Proof.** A key the server never sees, on a real account, doing one live amendment;
and the wrong-wallet refusal shown in plain words. (Unchanged — and now also: the
upgrade preserves the account address, and the rotated-out pasted key demonstrably
stops working.)

## 3 · Witness keys that can live a real life

**Status (2026-10-26): CODE-COMPLETE and green.** Built test-first: owner-signed
witness attestations (`src/attestations.mjs`, 12 primitive tests), trust
integration (records verify against the attestation in effect when each was
made; a rotated-out key cannot sign), console endpoints (`/api/witness/preview`
+ `/api/witness/attest`, with the mismatch-repair tolerate mode), the résumé
witness-history timeline + vouch/rotate card, the browser digest twin with a
drift test, and a 17-test integration file — **284/284 JS, 0 skipped**, style
gate PASS. Building it flushed out a latent bug: the ladder store verified
signatures without the wallet's typed-data context, so a wallet-signed
promotion would have been refused after the endpoint verified it — fixed
additively and pinned (OBS-26, `track3-witness-rotation.md` Outcome).
Remaining: the LIVE owner-signed attestation in the browser (Ready X), which
joins step-10's browser list — announced, never silently skipped. The record
below is the spec as written before the build.

**Where we are.** The app witness (the key that signs evidence records) is generated
per demo run and kept in memory. And the résumé treats two different witnesses on one
agent as a contradiction to shout about.

**Why that is not production.** Real apps rotate keys. After a rotation, an honest
history *has* two witnesses — so today's red flag would fire on legitimate records.

**How.**
- Owner-signed witness attestations, in the same style as the identity: "this key
  speaks for this app from this time, until superseded." Stored with the signed
  records, off-chain, like everything else in the hybrid model.
- Evidence verification checks each record against the attestation that was valid
  *when the record was made*, not against today's key.
- The résumé shows the witness history (who spoke for the app, when) instead of a
  single-witness assumption. Per-app isolation comes free: an attestation binds a key
  to one app, so another app's key cannot sign into this history.
- On-chain registration of attestation fingerprints is an option for later, not a
  requirement for v-next.

**Proof.** A rotated-out key cannot sign new records; old records still verify after a
rotation; a foreign app's witness is refused; the résumé shows the history honestly.

## 4 · The demo a stranger can understand

**Where we are.** The console was built evidence-first: every screen shows
digests, hex addresses and scheme names, because the house rules demanded
receipts — and the receipts became the interface. The owner's verdict after
seeing it (2026-10-25): "i dont understand shit inthere rn… if me cant
understand it how will other do." That is a failed user test from the most
motivated user there is. Recorded, not defended. (Product context:
`product-shape.md` — the console is the public face of infrastructure; if the
face is unreadable, the infrastructure never gets adopted.)

**What it is for.** A visitor should get the story in thirty seconds — *agent
tries to overspend → blocked → you sign → recorded forever* — and the crypto
evidence should be **available, not in their face**.

**How.**
- Two layers everywhere: plain words on the surface ("You are declining: the
  agent asked to pay 35. Nothing will be sent."), receipts behind a "Show the
  proof" toggle (digest, scheme, chain reads). Nothing is deleted — the house
  rules still hold; only the placement changes.
- Plain names for the screens: Mandate → **The rules**; Proposals → **Blocked
  requests**; Approvals → **Your decision**; Audit → **History**; Résumé →
  **Track record**. Internal code and files keep their precise names.
- A guided walkthrough — "Show me how it works" — that runs the story in order
  with safe prefilled values, so a first-time visitor never has to guess what
  to click.
- A jargon sweep with one rule: any word that needs explaining gets replaced,
  or explained inline once, in plain language.

**Order.** After track 3, and before anything is shown publicly: the build
tracks finish their machinery (2 → 3), then ONE clarity pass over the finished
feature set — no screen is rewritten twice, and the demo shows everything,
witness history included. If a real demo deadline ever appears, this track may
be pulled forward to right after track 2; that would be a deliberate swap
recorded here, never track 3 being quietly dropped. If the phase-6 wallet
walkthrough proves too jargon-heavy in the owner's own browser, a quick
labels-only pre-pass is allowed — nothing structural.

**Proof.** The owner can explain each screen back in their own words; a
first-time visitor completes the guided demo without asking a question; and
every screen still passes the house rules — evidence one click away, never
removed. Hallmark governs the pass (audit → redesign, "Calm utility" tone kept).

---

## Parked, not next

- **Category-level merchant rules** — needs its own attested merchant registry. That is
  a different layer, not Layer D.
- **Auto-pay exact-item lists, paymaster/gasless gas** — v1.1.
- **A `set_spending_policy` variant that preserves counters** — v0.3, a Cairo change;
  today restarting the window is warned about before anyone signs, which is honest.

## Why this order

Track 1 is the smallest and closes the last place a key touches our server; it also
builds the signer interface track 2 plugs into. Track 3 changes what the word "trust"
means (rotation becomes legitimate history, not a red flag), so it lands after the
owner-key story is settled, tests first as always. Track 4 (the demo pass) is the
skin on the story: it lands after the machinery is finished (2 → 3), so the pass
happens once over the final feature set, and before anything public, because an
unreadable demo hides real infrastructure (`product-shape.md`).

## House rules for all tracks

- Every new control gets a test where it is the only thing between an attacker and an
  otherwise-successful action (OBS-08). Checks get checked.
- No crypto constant from memory: hashes, specs and limits come from the library, the
  artifact or the chain, with a drift test that fails loudly.
- Live proof on Sepolia before anything is called done; a skipped check is announced,
  never silent.
- What we learn goes into these files, including the failures.

## Repo

- Git repo: https://github.com/Valorian0108/mandate (private, main). First commit 84a44ad = Tracks 1-3 complete + Track 4 mockup.
- Secrets excluded via .gitignore: gate-account/.sepolia/ (private keys), permission-core/.data/demo-agent-runtime.json (witness key), node_modules/, target/. Evidence ledgers (.data, public chain data) ARE committed.
- Workflow from here: commit + push at the end of every work session.
