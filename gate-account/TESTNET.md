# Sepolia testnet run — Stage 1 (COMPLETE 2026-10-24)

Goal: prove the thesis on a real network. An agent transaction that breaks policy gets
**rejected by Starknet itself**, not by our code and not by a server.

Two stages:
- **Stage 1 (this file):** deploy the contract for real, send a real owner transaction.
  Proves GateAccount works as an actual account on a live network — fees, nonces, tx versions.
  **Done:** GateAccount live at `0x2502f82a...73d25`, mandate registered, everything read back
  and verified (`.sepolia/state.json`).
- **Stage 2 (`STAGE2-agent-tx.md`):** submit an agent transaction with the custom 4-element
  session signature. This is the risky one — see that file for why.
  **Done:** one in-policy transfer SUCCEEDED; over-cap and unlisted-recipient transfers were
  REVERTED by Starknet with the contract's own error strings. Thesis proven.
- **Layer C demo (`../permission-core/DEMO-cap-raise.md`):** the proposal loop on top of the
  lock — engine blocks the agent, owner signs an amendment, a REAL owner transaction changes
  the on-chain mandate (`0x728c64fe...`), and the agent's retry then succeeds (`0x414f0ddd...`).
  **Done 2026-10-24:** the user's signed decision turned the lock. State after: cap 20,
  spent 15, calls used 2/10 (`state.json` → `layer_c_demo`).

---

## The one thing you need to do

Everything else is scripted. You fund one address, once.

**1.** Open <https://faucet.starknet.io/> (official Starknet Foundation faucet, Sepolia).

**2.** Paste this address:

```
0x00290179d7dcf12b5f733a3680a42bf9e367437ac5486ac480ecd5d5b5fb8546
```

**3.** Click **Request 100 STRK**. (Signing in with GitHub raises it to 3,000 — not needed.
100 STRK is worth nothing and is plenty: deploying this account costs about 0.05 STRK.)

**4.** Tell me it's done. I run `scripts/stage1-deploy.sh` and take it from there.

### Why only one address

That address is the **deployer**. It pays to declare and deploy everything, then transfers STRK
to GateAccount so GateAccount can pay its own gas. One faucet trip covers the whole run — you do
not need to fund GateAccount separately, and you do not need an RPC provider account either
(sncast 0.64 ships with a public Sepolia provider; verified working, chain id `SN_SEPOLIA`).

If sncast's built-in provider rate-limits us mid-run, we already have two verified **keyless**
public Sepolia RPCs as fallback (recorded in `.sepolia/state.json` — Cartridge on spec 0.9.0 and
dRPC on 0.10.3). **You do not need to sign up for anything.**

---

## Security (read this once)

- All keys in `.sepolia/state.json` and in WSL's `~/.starknet_accounts/` are **testnet-only**.
  They control tokens with no value on a network where anyone can get free money.
- **Never reuse them on mainnet.** When this goes to mainnet the owner key comes from Privy (Layer B
  decision 3), not from a file on disk.
- `.sepolia/` is scratch state for this run. It is not a secret store and it is not the product's
  key management — it is the test harness's.

---

## What Stage 1 does once funded

1. `sncast account deploy` — puts the deployer on-chain.
2. `sncast declare` x2 — declares `GateAccount` and `ERC20Mock` (the mock ERC-20 is already in
   `src/mocks.cairo`, so the same artifact the 16 tests used goes to testnet).
3. Generates the **owner keypair** for GateAccount and deploys GateAccount with that public key.
4. Deploys `ERC20Mock` holding 1,000,000 units, owned by GateAccount.
5. Transfers STRK from the deployer to GateAccount so it can pay gas.
6. Registers GateAccount as an sncast account so the owner can sign through it.
7. **Proves it:** one real owner invoke that registers the agent session, sets the spending
   policy, and allowlists a merchant — then reads the state back with `call`.

Step 7 matters more than it looks. `add_or_update_session_key` and `set_spending_policy` are both
guarded by `assert_only_self()`, meaning they only work when the account calls *itself* through a
properly signed transaction. That guard passing on a live network is the first real evidence that
"only the user signs" holds outside simulation.

Every address, class hash and key gets written to `.sepolia/state.json` so Stage 2 can pick up
where Stage 1 stopped.
