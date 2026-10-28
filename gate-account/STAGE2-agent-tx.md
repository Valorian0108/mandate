# Sepolia testnet run — Stage 2: the agent transacts on its own

**Status: COMPLETE (2026-10-24). The thesis is proven on a live network.**

Stage 1 proved the contract works as a real Starknet account and that only the owner can write
the mandate. Stage 2 is the part that mattered: can an *agent* — holding only a temporary
session key, never the owner's key — spend money inside the rules the user set, and is it
**physically stopped by the network** when it tries to break them?

## What an agent transaction looks like

A normal wallet signs the *transaction hash*: "I approve this exact transaction." Our agent can't
do that, because the whole point is that the user isn't present to approve anything. Instead:

1. The owner pre-registered a **session key** for the agent (one public key, an expiry, a call
   budget, a whitelist of functions, spending caps, and a merchant allowlist — all on-chain).
2. When the agent wants to act, it signs a **session hash**: a fingerprint of
   (this account, this chain, this nonce, this expiry, this exact list of calls).
3. The signature on the transaction is four values: `[session_pubkey, r, s, valid_until]`.
4. GateAccount's `__validate__` sees a 4-element signature, knows it's the agent path, and
   checks the fingerprint, the expiry, the budget, the whitelist — then `__execute__` enforces
   the spending caps and the merchant allowlist while the transaction runs.

No wallet produces signature #3, so we wrote the submitter ourselves:
`tools/agent-tx.mjs` (starknet.js v10 + a custom `SessionSigner` that signs the session hash
instead of the tx hash). RPC: Cartridge's keyless Sepolia endpoint.

## The check before the check

Before anything was submitted, snforge test **t17** asserts that Cairo computes the *identical*
hash to JavaScript for the canonical live vector (`0x75179a2c...be9d9`). If the two
implementations disagreed by one byte, every agent transaction would have been rejected and we'd
have been debugging the network for a local typo. 17/17 tests pass.

## Results — three real transactions

| # | What the agent tried | Tx hash | Starknet's verdict |
|---|---|---|---|
| 1 | Transfer **5** tokens to the listed merchant (cap: 10/call, 100/month) | `0x59e507bb20ea6ba561d49e386f54648934cbc15403cda5b240800258af1856f` | ✅ **SUCCEEDED** |
| 2 | Transfer **50** to the same merchant — over the per-call cap | `0x58b470010dfd36acce0bb7ff10b1ee16bef229357560cfe50c825b9e8bcbfde` | ❌ REVERTED: `"GateAccount: amount over per-call cap"` |
| 3 | Transfer **5** to an address that was never allowlisted | `0x566f35c9048ca7bba362c3d394c4aee572ec17c09c3cbee7f7a85cd7d36b46f` | ❌ REVERTED: `"GateAccount: recipient not allowed"` |

Read back off the chain after the run:

- `calls_used: 1` — the successful call consumed budget; the two reverts consumed **none**.
- `spent_in_window: 5` — only the legal amount was recorded as spent.
- Merchant balance: 5. Stranger balance: 0. The attacks moved nothing.

The revert strings in #2 and #3 are our contract's own words, quoted back by the network inside
the transaction receipt. That's not our code refusing — the transaction was included in a real
block, ran against real state, and Starknet itself marked it failed.

## Two real-world lessons the simulation never taught us

1. **The first attempt reverted on gas, and it was still a win.** Tx
   `0x18ad9181...c6e2be5` came back `REVERTED: Insufficient max L2Gas`. Read carefully: it got
   *past validation* — the network had already accepted our 4-element session signature — it just
   ran out of fuel mid-execution. Cause: starknet.js estimates fees with validation skipped, so
   the estimate never priced in our `__validate__` (~1.5M L2 gas of poseidon + ECDSA). Fix: pad
   the estimate (x3 on L2 gas). A reverted tx costs a fee and a nonce but changes no state —
   the mandate was untouched, exactly as the model says.
2. **The resolved starknet.js was 10.8.0, not the 7.6.4 we'd recorded.** The RPC-spec probe
   results attributed to 7.6.4 were v10 behaviour all along. v10's `Account` takes a single
   options object and only builds v3 transactions. Recorded so nobody trusts the old note.

## Try it yourself

**Level 1 — just look (browser only, 2 minutes).** Open these in any browser:

- The legal transfer (green "Success"):
  <https://sepolia.voyager.online/tx/0x59e507bb20ea6ba561d49e386f54648934cbc15403cda5b240800258af1856f>
- The over-cap attack (red "Reverted", reason quoted from our contract):
  <https://sepolia.voyager.online/tx/0x58b470010dfd36acce0bb7ff10b1ee16bef229357560cfe50c825b9e8bcbfde>
- The unlisted-recipient attack (red "Reverted"):
  <https://sepolia.voyager.online/tx/0x566f35c9048ca7bba362c3d394c4aee572ec17c09c3cbee7f7a85cd7d36b46f>
- The account itself, with its full transaction history:
  <https://sepolia.voyager.online/contract/0x02502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25>

**Level 2 — read the mandate back from the chain (one command, no keys touched):**

```powershell
wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/verify-mandate.sh"
```

Shows: the stored owner key, the agent's session (budget 10 calls), the spending policy
(10/call, 100/month), the merchant reading `true`, an unlisted address reading `false`.

**Level 3 — attack it yourself (pick your own victim and amount):**

```powershell
cd "C:\Users\USER\demi the builder\gate-account\tools"
node agent-tx.mjs --send 0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38 7
```

That sends **7** to the listed merchant — inside policy, so it should **succeed** and the
merchant's balance should grow by 7. Now break a rule and watch Starknet refuse:

- `--send <merchant> 11` → over the per-call cap of 10 → REVERTED, `"amount over per-call cap"`
- `--send 0x16cb41ec11efcc9129d858ae07449f4f1a31d7d292269a5e7c40cd4d33db371 1` → address not
  on the allowlist → REVERTED, `"recipient not allowed"`

The script prints its prediction *before* submitting, so you can check the network against it.
Each attempt is a real transaction with a real link you can open afterwards.

Budget note: the session has 10 calls and a 100-token monthly window; rejected attempts consume
neither. If the budget ever runs out, re-registering the session is one owner transaction
(`scripts/stage1-deploy.sh`, step 4).

## What this closes

Layer E's "done when": *an agent transaction that breaks policy is rejected by Starknet itself,
on testnet.* Done — twice, for two different controls, with receipts.

Next: Layer C (the permission SDK), where `agent-tx.mjs` stops being a hand-written script and
becomes an API a developer can call.

---
*Keys used here are testnet-only harness keys (see `TESTNET.md` → Security). The product's owner
key will live in Privy.*
