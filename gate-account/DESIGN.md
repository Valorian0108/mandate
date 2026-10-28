# GateAccount — Design (v0.3)

**What this is:** The Layer E lock. A Starknet smart account contract that encodes a user's
spending policy and enforces it at the protocol level — the network itself calls `__validate__`
before anything executes, so an over-policy transaction is REJECTED regardless of any server.

**Position in the stack:** Layer E of the build (see `../layer-map.md`, `../layer-e-research.md`).

---

## Decisions encoded here (from Layer B, confirmed 2026-10-24)

1. **v1 on-chain policy fields:** monthly cap, per-call cap, selector whitelist,
   merchant allowlist. The first three shipped in v0.1; the merchant allowlist (the
   "merchant/category allowlist" from the Layer B decision) is implemented in v0.2 as a
   per-recipient allowlist — see "Merchant allowlist" below.
   Auto-pay exact-item list deferred to v1.1.
2. **One account per user; one session key per agent.** Revoking an agent kills only its key.
3. **Owner key comes from Privy embedded wallet** (external to this contract — the contract
   only stores the owner public key, like any standard account).

## Architecture

```
GateAccount (single contract, user-owned)
├── AccountComponent (OpenZeppelin 4.0.1)     → owner signature validation, key mgmt
│     embedded: PublicKeyImpl, PublicKeyCamelImpl, DeployableImpl, SRC6CamelOnlyImpl
│     internal: initializer / assert_only_self / validate_transaction / _is_valid_signature
├── SRC5Component (OpenZeppelin 4.0.1)        → interface detection (SRC-5)
└── Session/policy logic (custom, spec-compliant)
    ├── starknet::account::AccountContract    → __execute__ / __validate__ / __validate_declare__
    │     (std trait with MUTABLE self — needed because spending counters and the call
    │      budget are updated inside __execute__; OZ's ISRC6 is snapshot-only)
    ├── ISessionKeyManager                    → follows the Session Keys SNIP (chipi-pay)
    ├── 4-element session signatures          → [session_pubkey, r, s, valid_until]
    ├── 8-step validation in __validate__     → expiry, call limit, blocklist, whitelist, ECDSA
    ├── Admin selector blocklist (13)         → session keys can NEVER call privileged fns
    │     (SNIP's 9 + set/remove_spending_policy + allow/disallow_recipient)
    ├── Self-call block                       → no calls to the account itself (empty whitelist)
    ├── Spending policy (per session+token)   → max_per_call, rolling monthly window,
    │                                           DENY-BY-DEFAULT (see deviations)
    └── Merchant allowlist (session+token+recipient)
                                              → WHO may be paid; DENY-BY-DEFAULT, enforced in
                                                __execute__ alongside the amount caps
```

### Deviations from the SNIP (deliberate, stricter)
1. **Deny-by-default spending:** a transfer/approve with NO policy for (session, token) is
   REJECTED. The SNIP treats "no policy" as unrestricted; for an agent account the safe
   default is "the owner explicitly allowed this token, with caps."
2. **Session expiry clamp:** the signature's `valid_until` cannot exceed the owner-registered
   session expiry — an agent cannot claim a longer session than it was granted.
3. **Blocklist extended** with this contract's own policy setters (SNIP only lists account
   primitives).
4. **Deny-by-default merchant allowlist:** a spend to a recipient the owner never listed is
   REJECTED even when the amount sits inside every cap. The SNIP has no notion of recipient.

### Merchant allowlist (v0.2)

Answers *who* the agent may pay, where the spending policy answers *how much*.

- Storage: `(session_key, token, recipient) -> bool`. Owner-only `allow_recipient` /
  `disallow_recipient`; `is_recipient_allowed` is a view. Absence means denied.
- Enforced in `__execute__` for the same four spend selectors (`transfer`, `approve`,
  `increase_allowance`, `increaseAllowance`). `calldata[0]` is the recipient for `transfer` and
  the spender for the allowance calls — either way it is the address being handed value or
  spending power, so the same check covers all four.
- Check order inside `enforce_spending`: policy exists → recipient allowed → per-call cap →
  window cap. Policy-first keeps "no policy" and "unlisted merchant" as distinct, readable
  failures.
- `allow_recipient` / `disallow_recipient` are on the admin blocklist, so a session key can never
  edit its own merchant list — **the blocklist outranks the entrypoint whitelist** (t16 proves
  this by having the owner whitelist `allow_recipient` for the agent anyway).
- Enforcement lives in `__execute__`, not `__validate__`, so a blocked payment still *validates*
  and then reverts. That is deliberate: `__validate__` state changes are discarded, and the
  revert is what stops the money. t15 asserts both halves of that split.
- Scope limit: this is per-address, not per-brand. "Only Amazon" means listing the addresses the
  user pays; category-level rules ("any grocery merchant") need an attested merchant registry
  and belong to Layer D, not here.

### Signature = verdict (the elegant part)
- **2-element signature `[r, s]`** → owner (the user, via Privy). Full control.
  This is literally "the user approved."
- **4-element signature `[session_pubkey, r, s, valid_until]`** → agent session key.
  Only works inside scope. Anything outside scope fails validation unless the owner signs.
  This is literally "ASK_USER" — built into the protocol, not our code.

### Enforcement split (protocol constraint)
- `__validate__`: expiry, call limits, blocklists, whitelist, signature.
  (Cannot mutate state reliably — reverts are possible; timestamp rounded to ±1h here.)
- `__execute__`: spending counters update here (per SNIP Part H — state changes in
  validate would be reverted on execution failure). Exact timestamp available here.

### Known limits (deliberate)
- ~~No SNIP-9 `execute_from_outside_v2`~~ **SHIPPED in v0.3 (2026-10-25)** —
  controller-bound SNIP-9: a `wallet_controller` slot (settable only through the
  owner-signature gate) provides the address the OutsideExecution hash binds to,
  and signature verification is delegated to that controller's
  `is_valid_signature`. Nonces (one-shot), exclusive time windows and
  caller-binding stay in GateAccount. Proven live on Sepolia with a third-party
  relayer (tx `0x4a26c6b1...dfc5`, see `.sepolia/migration-v3.json`). Outside
  execution is OWNER-level authority: the session spending policy deliberately
  does not apply to it (matching the owner `__execute__` path), and a session
  signature can never authorize it (snforge t26). The selector stays
  blocklisted for session keys.
- Merchant allowlist is per-address, not per-category (see scope limit above). The
  wrapper-contract strategy from the research gap analysis is therefore no longer needed for
  recipient control; it stays relevant only for protocols where moving value is not an ERC-20
  call we can read `calldata[0]` from.
- ~~No upgradeability~~ **v0.3 adds owner-gated `upgrade`** (OZ
  UpgradeableComponent): only the owner path can change the class; sessions and
  strangers are refused (t32/t33), and an in-place upgrade preserves storage
  (t34). v0.1/v0.2 had no upgrade entry point at all — which is why the v0.3
  migration was a fresh `deploy_account` (recorded plan correction, see
  `state.json` `migration_v03`). From v0.3 on, this is the LAST redeploy.

## Test plan (Track 2 — runs under WSL + snforge)

The thesis test (E3 "done when"):
1. Owner sets policy: monthly cap 100, per-call cap 10, session for agent.
2. Agent session key sends transfer of 10 → passes.
3. Agent session key sends transfer of 11 → **REJECTED in __execute__** (per-call cap;
   amount checks live in execute because they must update counters atomically).
4. Agent session key sends transfer of 10 x N until window cap → next one REJECTED in __execute__.
5. Agent session key calls `add_or_update_session_key` (raise own limits) → REJECTED in __validate__ (blocklist).
6. Agent session key calls `set_public_key` (take over account) → REJECTED in __validate__ (blocklist).
7. Owner revokes session → agent's next tx REJECTED in __validate__.
8. Expired session → REJECTED in __validate__.
9. `max_calls` exhaustion → REJECTED in __validate__.
10. Owner 2-element signature can do everything (policy changes, revocation).
11. Spend selector with NO policy for that token → REJECTED (deny-by-default).
12. Signature claiming valid_until longer than the registered session → REJECTED.

Merchant allowlist (v0.2) — tests 13–16:
13. In-cap transfer to a recipient the owner never listed → **REJECTED in __execute__**.
    Selector whitelisted, amount inside both caps, signature valid: only WHO is wrong.
14. Owner controls the list: unlisted reads as denied → `allow_recipient` → allowed →
    `disallow_recipient` → denied.
15. Delisting a merchant kills an otherwise-valid agent transfer, and the enforcement split is
    visible: `__validate__` returns VALIDATED, `__execute__` reverts.
16. Blocklist outranks whitelist: owner whitelists `allow_recipient` for the agent, and the
    agent still cannot use it → REJECTED in `__validate__`.

Cross-implementation (Stage 2 gate) — test 17:
17. The JavaScript submitter (`tools/agent-tx.mjs`) and Cairo must compute the IDENTICAL session
    hash for the canonical live-Sepolia vector. If they ever diverge, every agent transaction
    gets rejected on-chain, so this is asserted as a test, not left to the live run to discover.

## Build status (Track 1 — Windows)

- **Compiles clean** (zero errors, zero warnings) with Scarb 2.21.0 / Cairo 2.21,
  OZ cairo-contracts v4.0.1 (git), edition `2024_07`.
- Artifact: `target/dev/gate_account_GateAccount.contract_class.json` (Sierra class, ~397 KB).
- ABI verified: __execute__/__validate__/__validate_declare__/__validate_deploy__,
  ISessionKeyManager (3 fns), IGateSpendingPolicy (6 fns incl. the merchant allowlist),
  key mgmt + camelCase, is_valid_signature/isValidSignature, supports_interface, constructor,
  6 custom events.
- Toolchain notes (for reproducibility):
  - OZ v4.0.1 is a multi-package workspace; the umbrella crate exposes short paths:
    `openzeppelin::account::AccountComponent`, `openzeppelin::introspection::src5::SRC5Component`,
    `openzeppelin::utils::execution::execute_calls`.
  - OZ v4 dropped `openzeppelin_storage`; storage uses std `starknet::storage::Map` with
    `StorageMapReadAccess/WriteAccess` (`.read(key)` / `.write(key, val)`).
  - Map writes need Mutable state → `ref self` → hence std `AccountContract` trait over OZ ISRC6.
  - Cairo enums have no brace-variants: event structs are declared separately.
  - `felt252` has no BitXor → SRC-5 interface id XORed in u256 domain at construction.
  - `edition = "2025_12"` broke the `starknet::Event` derive (snapshot/value mismatch in
    generated code); `2024_07` (what OZ v4.0.1 uses) works.
- **Tests written** (`tests/lib.cairo`, 17 tests + helpers) and **compiling clean** on Windows
  via `scarb build --test` — compiles the `gate_account_tests` target without running it.
  (`scarb test --no-run` is not a valid flag in Scarb 2.21; and the cairo-test runner cannot
  execute snforge tests anyway, so it reports "0 tests" — see OBS-06.)
- Test harness notes:
  - `tests/` is auto-detected as an integration test target by Scarb — no `[[test]]` needed.
  - snforge cannot deploy contracts that live in the test crate, so the mock ERC-20 lives in
    `src/mocks.cairo` (`ERC20Mock`, compiled into the contract target, declarable by name).
  - Each simulated transaction uses cheatcodes: caller -> 0, version -> 1, tx hash / nonce /
    chain id fixed, signature -> 2 felts (owner) or 4 felts (session).
  - The test recomputes `compute_session_hash` exactly as the contract does, so a passing test
    means the signature binding (account, chain, nonce, expiry, calls) is genuinely exercised.

## Build status (Track 2 — WSL + snforge) — **17/17 PASSING** (v0.2-era record; superseded by v0.3 below — kept as evidence)

Environment: Ubuntu 26.04 on WSL2, Scarb 2.21.0, Starknet Foundry 0.64.1,
universal-sierra-compiler 2.10.3, Rust 1.99.1 (Scarb builds the snforge plugin from source on
Linux, so cargo is required). Everything lives under `~/.local/bin` in WSL — no sudo needed.

```
Collected 17 test(s) from gate_account package
Tests: 17 passed, 0 failed, 0 ignored, 0 filtered out
```

(First 12 green on the v0.1 contract; 13–16 added with the v0.2 merchant allowlist — the
allowlist shipped with an enforcement test for every control, per OBS-08; 17 added for Stage 2
to lock the JS↔Cairo session-hash agreement.)

## Track 3 — Sepolia testnet: **THESIS PROVEN (2026-10-24)**

Full record in `TESTNET.md` (Stage 1) and `STAGE2-agent-tx.md` (Stage 2); every address, key,
tx hash and verified read-back in `.sepolia/state.json`.

- GateAccount live at `0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25`
  (class `0x435d81...90524`), deployed via `deploy_account` (exercised `__validate_deploy__`),
  SRC-5 `supports_interface(ISRC6)` → true.
- Three owner-signed invokes registered the mandate (`assert_only_self()` passed live):
  session `0x42ee342e...`, policy `0x387fb6a1...`, merchant `0x4c1164d5...`.
- **Agent path proven live** with the 4-element session signature built by our own submitter
  (`tools/agent-tx.mjs`, starknet.js v10, custom `SessionSigner` signing the session hash):
  in-policy transfer SUCCEEDED (`0x59e507bb...`), over-per-call-cap REVERTED with
  `"GateAccount: amount over per-call cap"` (`0x58b47001...`), unlisted recipient REVERTED with
  `"GateAccount: recipient not allowed"` (`0x566f35c9...`). Reverts consumed no budget and
  moved no funds; `calls_used`/`spent_in_window` incremented only on the legal call.
- Real-world finding: starknet.js estimates with SKIP_VALIDATE, so a custom `__validate__`
  (~1.5M L2 gas here) must be padded onto the estimate or the tx reverts on gas — which still
  proved validation passed, since a bad signature would fail with "account validation failed"
  instead.

Reproduce from Windows:

```
wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/run-tests.sh"
```

The script copies `src/`, `tests/`, `Scarb.toml`, `Scarb.lock` to `~/gate-account-run` (building
on `/mnt/c` is very slow) and runs `snforge test`. Helper scripts in `gate-account/scripts/`:
`install-wsl-tools.sh` (scarb + snforge + usc), `install-rust.sh` (cargo), `run-tests.sh`.

### Prerequisites found the hard way

- **Firmware:** VT-x had to be enabled in BIOS. `systeminfo` on Windows said
  `Virtualization Enabled In Firmware: No` (i5-6300U supports it; it was switched off). HP
  Spectre Pro x360 G2: power on → Esc → Startup Menu → F10 → Advanced → System Options →
  Virtualization Technology (VTx) → F10 save & exit. `HypervisorPresent` became `True`.
- **snforge has no Windows binary** (verified against v0.64.1 release assets); WSL1 is not
  available on this machine.
- **universal-sierra-compiler is a separate binary** snforge expects on PATH.
- **cargo is required in WSL**, because Scarb compiles the snforge plugin from source there.

### Test-harness bug found by the first run (important)

First execution: 12/12 failed with `Account: unauthorized`. Cause was the harness, not the
contract: `start_cheat_caller_address(account, 0)` is *indefinite*, so it also rewrote the
caller seen by the account's own nested self-call, breaking `assert_only_self()` in
`add_or_update_session_key` / `set_spending_policy`. Fix: scope the cheat to the outer call
only with `cheat_caller_address(account, 0, CheatSpan::TargetCalls(1))`.

Lesson (OBS-07): a cheatcode is part of the model under test. If the harness cheats the very
signal the contract relies on, a "passing" test proves nothing. The failure mode here was
conveniently loud; the dangerous version is a cheat that silently makes a rejection look like
a success.

## Build status (v0.3 — 2026-10-25) — **42/42 snforge · 215/215 JS · LIVE on Sepolia**

v0.3 = controller-bound SNIP-9 (`execute_from_outside_v2`) + owner-gated `upgrade`
(UpgradeableComponent). The decision and its reasoning live in
`../track2-wallet-research.md` ("Build-time correction"); the test-by-test table is in
`TEST-RESULTS.md` ("v0.3 results").

- **Contract:** t18–t35 cover every SNIP-9 control (happy path with a real ECDSA
  signature, caller binding, exclusive time window both directions, one-shot nonces,
  substituted calls, wrong key, session-key refusal, unregistered controller, refusing
  controller, rubber-stamp controller proving delegation is real, owner-gating of
  `set_wallet_controller` and `upgrade`, in-place upgrade preserving state) plus the
  cross-language hash pin t35.
- **Toolchain notes added:** plain (non-Map) storage fields need
  `StoragePointerReadAccess`/`StoragePointerWriteAccess` from `starknet::storage`
  (confirmed against OZ's own `account.cairo` L19). Panic-shape rule: our own errors
  are ByteArrays; errors raised inside OZ code are felt252 shortstrings that pin as
  `('msg', 'ENTRYPOINT_FAILED')` tuples through dispatchers.
- **Live migration (plan correction recorded):** v0.2 had no upgrade entry point, so
  v0.3 shipped as a fresh owner-signed `deploy_account` → gate
  `0x7d1d8cad365390adfb2f4f9f89277663c555d2eed790f1c4983c44a002570f1`; mandate
  mirrored from LIVE old-gate reads; evidence root re-anchored; **third-party-relayed
  `execute_from_outside_v2` SUCCEEDED** (tx `0x4a26c6b1...dfc5` — the deployer
  submitted what only the owner signed). `migrate-v3.mjs --verify` 11/11 PASS,
  including library-native SNIP-9 detection (`Account.getSnip9Version()` → `'2'`;
  the ISRC9_V2 id is a spec constant, NOT an XOR of selectors). Receipts:
  `.sepolia/migration-v3.json`, `.sepolia/state.json` (`migration_v03`).
- The v0.2 gate `0x2502f82a...` remains live with its full history (evidence never
  removed); live fields in `state.json` now point at v0.3, and the tools
  (`owner-tx.mjs`, `agent-tx.mjs`, the console server) read those fields.

## Interfaces (draft)

```cairo
trait ISessionKeyManager {
    fn add_or_update_session_key(session_key, valid_until, max_calls, allowed_entrypoints); // owner-only
    fn revoke_session_key(session_key);                                                     // owner-only
    fn get_session_data(session_key) -> SessionData;                                        // view
}

trait IGateSpendingPolicy {
    fn set_spending_policy(session_key, token, max_per_call, max_per_window, window_seconds); // owner-only
    fn get_spending_policy(session_key, token) -> SpendingPolicy;                             // view
    fn remove_spending_policy(session_key, token);                                            // owner-only
    fn allow_recipient(session_key, token, recipient);                                        // owner-only
    fn disallow_recipient(session_key, token, recipient);                                     // owner-only
    fn is_recipient_allowed(session_key, token, recipient) -> bool;                           // view
}
```

Both follow the Session Keys SNIP spec exactly where it applies, so paymasters/dApps
that speak the standard can detect and use this account (SRC-5 registration included).
