# Layer E Research — Starknet Account Building Blocks

**Fetched:** 2026-10-24
**Sources:**
1. Starknet protocol docs — Accounts (`docs.starknet.io/learn/protocol/accounts`)
2. OpenZeppelin Contracts for Cairo 4.x — Accounts (`docs.openzeppelin.com/contracts-cairo/4.x/accounts`)
3. Session Keys SNIP draft + reference implementation (Chipi Pay, `community.starknet.io/t/snip-session-keys-for-smart-accounts/116132`, repo: `github.com/chipi-pay/sessions-smart-contract`)

**Headline finding:** Almost everything Layer E needs already exists as audited, composable components. Our contract is an *assembly job*, not a from-scratch build. The Session Keys SNIP was explicitly designed for AI agents ("time-bounded access, function-scoped permissions, call limits, emergency kill switch" — their words).

---

## 1. How Starknet accounts work (protocol facts)

- Every account is a contract. Required entrypoints: `__validate__` (checks the tx) and `__execute__` (runs it). The protocol calls `__validate__` first; only if it passes does `__execute__` run.
- **This is the lock mechanism:** if `__validate__` returns 0, the transaction is REJECTED by the network itself — the agent pays nothing, nothing executes. No server involved.

### Hard limits that shape our design
| Constraint | Consequence for us |
|---|---|
| `__validate__` cannot call external contracts | All policy state must live **inside the account's own storage** |
| `__validate__` capped at 1M Cairo steps | Keep validation cheap — no heavy loops over huge allowlists |
| `block_timestamp` in validate is rounded to the nearest hour | Session expiry precision is ±1 hour — fine for our ladder, must be documented |
| State changes in `__validate__` are reverted if execution fails | Spending counters must be updated in `__execute__`, not validate (SNIP Part H does exactly this) |
| Two mandatory safety checks | `__execute__` must assert caller is zero AND tx version ≥ 1, or funds can be drained |

### Failure semantics (useful for UX)
- `__validate__` fails → tx REJECTED, no fee, never included. ("The gate refused.")
- `__execute__` fails → tx REVERTED, included, fee paid. ("The gate let it through but the action failed.")

---

## 2. OpenZeppelin Cairo 4.x — the account base

- Current stable: **4.x**. Use `AccountComponent` + `SRC5Component` with the mixin pattern.
- Constructor takes the owner's `public_key` (Stark-curve ECDSA). That key = the user's authority.
- Full interface already provided: `__execute__`, `__validate__`, `is_valid_signature`, `supports_interface`, `get/set_public_key`, plus declare/deploy validators.
- Deployment: `sncast account create --type oz --class-hash ...` → precompute address → prefund → `account deploy`. Counterfactual deploy supported (`__validate_deploy__`).
- Alternative: `EthAccountComponent` (secp256k1) exists if we ever want Ethereum-style keys — not needed for v1.

**What OZ gives us for free:** signature validation, nonce/replay protection, SRC-5 introspection, upgrade paths, audit pedigree.
**What OZ does NOT give us:** policy enforcement, session keys, spending limits. That's the next piece.

---

## 3. Session Keys SNIP — the agent-delegation standard

Status: Draft SNIP (Feb 2026), reference implementation **live on mainnet**, 65 Cairo tests, 4 rounds of Nethermind AuditAgent audits (10 → 3 → 5 → **0 findings**). Built on OZ Cairo v3.0.0 / Starknet 2.14.0.

### Core data model
```cairo
struct SessionData {
    valid_until: u64,             // expiry timestamp
    max_calls: u32,               // transaction limit
    calls_used: u32,              // consumed count
    allowed_entrypoints_len: u32, // selector whitelist size (0 = all non-admin)
}
```
Owner-only functions: `add_or_update_session_key(key, valid_until, max_calls, allowed_entrypoints)`, `revoke_session_key(key)`, `get_session_data(key)`.

### Signature formats
- **Owner (2 elements):** `[r, s]` — full control. This is the *user approving*.
- **Session (4 elements):** `[session_pubkey, r, s, valid_until]` — scoped. This is the *agent acting*.
- Anything else → rejected.

### Validation algorithm (8 steps, in `__validate__`)
1. Safe-convert `valid_until` (no unwrap — DoS protection)
2. Check expiry
3. Check session exists (valid_until == 0 in storage ⇒ revoked/nonexistent)
4. Check call limit (`calls_used >= max_calls` ⇒ exhausted)
5. Check **admin blocklist** — 9 selectors session keys can NEVER call: `upgrade`, `add_or_update_session_key`, `revoke_session_key`, `__execute__` (nested-execution escalation), `set_public_key`/`setPublicKey` (account takeover), `execute_from_outside_v2`, `set_spending_policy`, `remove_spending_policy`
5b. **Self-call block** (recommended): no calls targeting the account itself when whitelist is empty — kills the whole privilege-escalation class
6. Check selector whitelist (if non-empty)
7. Verify ECDSA signature
8. **Only then** increment `calls_used` (ordering matters — off-by-one bug otherwise)

### Spending Policy extension (Part H, optional component)
```cairo
struct SpendingPolicy {
    max_per_call: u256,     // cap per individual transfer
    max_per_window: u256,   // cumulative cap per rolling window
    window_seconds: u64,    // e.g. 2592000 = 30 days ⇒ our "monthly limit"
    spent_in_window: u256,
    window_start: u64,
}
```
- Per-token caps on ERC-20 `transfer`/`approve`/allowance calls, enforced in `__execute__`.
- Agent cannot raise its own caps (blocklisted).

### Architecture — the big win for us
- `SessionKeyComponent` is **embeddable in any wallet** via a one-function trait (`HasAccountOwner::assert_only_self()`), zero OZ dependency for the component itself.
- 5-step integration: declare components → implement owner check → call `is_session_allowed_for_calls()` in `__validate__` → `consume_session_call()` after sig verification → optionally `check_and_update_spending()` in `__execute__`.
- Known limitation (deliberate): SNIP restricts *selectors*, not *calldata* or *recipients*. Amount control comes from SpendingPolicyComponent; recipient/merchant control needs either whitelist-of-wrapper-contracts or our own custom logic.

### Prior art to study
- `starknet-agentic` — agent accounts + spending policies already working (their design informed Part H).
- Argent (guardian model), Braavos (library), Cartridge (passkeys/Controller) — different approaches, all incompatible; the SNIP is the interop layer.

---

## 4. Gap analysis — SNIP components vs our Layer B/E requirements

| Our requirement | Covered by existing components? | Notes |
|---|---|---|
| Monthly spending cap | ✅ SpendingPolicyComponent | `window_seconds = 30d` |
| Per-action spending cap | ✅ SpendingPolicyComponent | `max_per_call` |
| Allowed actions (selectors) | ✅ SessionKeyComponent | `allowed_entrypoints` |
| Time-bounded agent access | ✅ SessionKeyComponent | `valid_until` (±1h precision) |
| Call limits | ✅ SessionKeyComponent | `max_calls` |
| Revocation / kill switch | ✅ SessionKeyComponent | `revoke_session_key` |
| Owner-only policy changes | ✅ Admin blocklist + OZ owner check | server can't touch policy |
| "Approval required" = user signs | ✅ Signature format split | agent uses 4-elem session sig; anything outside scope requires 2-elem owner sig — **ASK_USER is literally "route to owner signature"** |
| Allowed *categories/merchants* | ⚠️ Partial | SNIP doesn't restrict recipients. Options: (a) wrapper contract per merchant/category, whitelisted as the only allowed entrypoint; (b) custom validate extension parsing calldata |
| Auto-pay allowlist (exact item+price) | ❌ Custom | Not in SNIP. Our own PolicyComponent: exact (recipient, amount) pairs, once-per-window counters |
| Category taxonomy (anchor:purchase etc.) | ❌ Custom | Maps to wrapper contracts or selector namespaces |

**Conclusion:** v1 contract = OZ `AccountComponent` + `SRC5Component` + `SessionKeyComponent` + `SpendingPolicyComponent` + **one custom component** (merchant/category/auto-pay policy). ~80% of the lock is audited off-the-shelf code.

---

## 5. Toolchain needed (not yet installed)

- **Scarb** — Cairo package manager/build (compiles the contract)
- **Starknet Foundry** — `snforge` (unit tests, 65-test-style suite) + `sncast` (declare/deploy/invoke against devnet or testnet)
- **starknet-devnet** — local chain for the "over-policy tx gets rejected" test
- OZ Cairo Contracts as a Scarb dependency (v4.x); SNIP components from `chipi-pay/sessions-smart-contract` repo (or reimplement to spec if their license/version pinning doesn't fit — MIT licensed)

## 6. Layer B decisions — RESOLVED (2026-10-24)

1. **Policy fields on-chain for v1:** ✅ DECIDED — monthly cap + per-call cap + selector whitelist (from SNIP components) + merchant/category allowlist (custom component). Auto-pay exact-item list deferred to v1.1.
2. **Account model:** ✅ DECIDED — one smart account per user; each agent gets its own session key inside it (revocable per-agent without touching the account).
3. **Wallet UX:** ✅ DECIDED — **Privy** embedded wallets (Starknet support live since June 2026, TS SDK fits the existing Next.js stack). Privy provides the owner key; the smart account contract holds all policy. Fallbacks if Privy's Starknet depth is rough: Cartridge Controller (Starknet-native passkeys) or ArgentX/Braavos for testing.
   - Note: Privy sells its own "agent wallets + policy engine" (custodial, off-chain enforcement). Our differentiator remains on-chain user-owned enforcement — see positioning (Layer F) later.

**Nothing blocks contract design anymore. Next: install Scarb + Starknet Foundry, then design the account contract.**
