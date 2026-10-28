# Layer C live demo — the cap-raise loop (COMPLETE 2026-10-24, Starknet Sepolia)

**The claim:** when the permission engine blocks an agent, the ONLY way the block lifts is a
decision the user signs with the owner key — and that decision becomes a REAL transaction the
chain obeys. Not a database flag. Not a company promise. This demo ran the whole loop live.

## The story, step by step (all assertions passed)

| # | Step | What happened |
|---|------|---------------|
| 1 | Read the LIVE mandate off Sepolia | per-call cap 10, window cap 100, spent 5, calls used 1/10 |
| 2 | Agent asks to pay the listed merchant **15** | Engine **DENY**: "GateAccount: amount over per-call cap" (the contract's own words) |
| 3 | The block becomes a proposal | `fe0098ada34c9af3` in `.data/demo-proposals.json` (append-only audit trail) |
| 4 | The **owner signs** an amendment: raise per-call cap 10 → 20 | Signature verified against the owner public key **read from the chain at that moment** |
| 5 | Proposal → exact wire call (pure conversion, shown before signing) | `set_spending_policy [session, token, 0x14, 0x0, 0x64, 0x0, 0x278d00]` + side-effect warnings |
| 6 | Dry-run (estimate only) | wiring validated, nothing submitted |
| 7 | **Real owner transaction** | ✅ SUCCEEDED — [`0x728c64fe3c400cfd3ced936072b0ec5004843589fe14301cbceda84c2213d5b`](https://sepolia.voyager.online/tx/0x728c64fe3c400cfd3ced936072b0ec5004843589fe14301cbceda84c2213d5b) |
| 8 | Re-read the chain | cap is now **20**; untouched fields unchanged; **spent reset 5 → 0** (honest note below) |
| 9 | Engine decides the same request again | **ALLOW**: "transfer of 15 ... inside every limit (per-call 20, window 100, spent 0)" |
| 10 | **Agent retries for real** (session-key signed) | predicted ACCEPT from the live policy, then ✅ SUCCEEDED — [`0x414f0ddd6ce6ae3b931b06fda44998ba0948633352d4d34929f44109c7e43d9`](https://sepolia.voyager.online/tx/0x414f0ddd6ce6ae3b931b06fda44998ba0948633352d4d34929f44109c7e43d9) |
| 11 | Final chain state | spent = 15 (exactly the transfer), call budget 1 → 2 (only successful calls count), cap still exactly what the owner signed |

**Honest note (asserted, not hidden):** v0.2's `set_spending_policy` RESTARTS the spending
window — `spent_in_window` reset from 5 to 0 when the cap was raised. The conversion step
(`src/resolutions.mjs`) carries this as a `sideEffects` WARNING that a real UI must show the
user BEFORE they sign. A "preserve counters" variant is a candidate v0.3 contract change.

## What this proves that Stage 2 didn't

Stage 2 proved the **lock**: the network itself rejects an agent tx that breaks policy.
This demo proves the **key turns the lock**: a user decision, made off-chain but signed with
the on-chain owner key, changed what the network then allowed — and the agent's retry went
through *because the chain state changed*, not because any company server said so. The full
Layer B/C/E thesis (company owns the app, user owns the authority) has now run end to end.

## The failure that made the demo better (run 1)

The first attempt died between dry-run and submit: `Cannot mix BigInt and other types`.
Cause: the owner path signs the **v3 transaction hash**, which starknet.js computes locally —
`encodeResourceBoundsL1` does BigInt shifts directly on the resource bounds, and our padded
bounds were hex **strings**. The agent path never hit this because its session signature never
covers the tx hash (no local hash computation). The estimate-only dry-run couldn't catch it
either — **estimating does not sign**. See `observations.md` OBS-10.

Fix: pad the estimate's own BigInt bounds in place (`* 3n` L2 gas, `* 2n` L1 data gas) —
which is also the shape the library itself feeds back when no bounds are provided. Verified
offline first with `gate-account/tools/probe-execute.mjs` (`getSignedTransaction` runs the
full sign path but never broadcasts).

Run 1's proposal (`853cf753f6dd2840`) remains in `.data/demo-proposals.json` as AMENDED with
no on-chain transaction — the audit trail keeps it; nothing was hidden or cleaned up.

## Try it yourself

```powershell
# The whole loop (re-runnable: raises the cap by 10 each time, sends old-cap + 5,
# until the window cap runs out of headroom - then it says so loudly):
cd "C:\Users\USER\demi the builder\permission-core"
node scripts/demo-cap-raise.mjs

# Or just ask the chain what it WOULD do (reads live policy, submits nothing):
cd "C:\Users\USER\demi the builder\gate-account\tools"
node agent-tx.mjs --predict 0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38 15
```

Note: `agent-tx.mjs` predictions are now read **live from the chain** (`get_spending_policy`
+ `is_recipient_allowed`), never from memory — before this demo they hardcoded "cap is 10",
which the amendment turned into a lie. `--predict` mode shows the prediction without
submitting anything.

## Chain state after the demo

- Mandate: per-call cap **20**, window cap 100, spent **15**, calls used **2/10**,
  window restarted at the amendment block
- Account nonce: `0xb` (owner tx `0x9`, agent tx `0xa`)
- Machine-readable record: `.data/demo-cap-raise-1792874951677.json` and
  `gate-account/.sepolia/state.json` → `layer_c_demo[0]`
