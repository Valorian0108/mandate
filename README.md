# mandate

Your assistant spends only inside rules you set. Every request is checked
against them before anything happens, and nothing moves without you.

The rules live on an account on Starknet (a GateAccount): a limit per purchase,
a budget for the month, and the list of stores your assistant may pay. When a
request does not clear the rules on the spot, it stops and waits for you. You
decide in plain language: approve this purchase once, change the rules, or say
no. Your decision is confirmed in your own account app, the change is carried
by your own transaction, and every step is recorded permanently with a receipt
you can open.

## What is in this repository

- `mandate-workspace/app/` — the owner-facing app. Five screens (Rules,
  Requests, Waiting for you, Activity, How it works), vanilla JavaScript, no
  build step. It holds nothing: every number is read live from the account
  through the tested server's HTTP API.
- `mandate-workspace/tools/check-jargon.mjs` — the jargon gate. The product
  rule is that the UI has no crypto-native surface: no addresses, keys, hashes,
  gas, chain names or signing vocabulary anywhere a user reads, except inside
  two approved places (the confirmation popup and the receipt drawers), which
  must be fenced in the source so the gate can see exactly where the machine
  layer is allowed to speak. The gate fails the build otherwise, and also
  enforces the colour-token and 44px control-floor rules.
- `mandate-workspace/README.md` — the workspace rules, including why the
  frozen AnchorGate reference inside the workspace is gitignored (another
  project's code, kept local for reading only).

## What is deliberately not in this repository

- The enforcement core — gate contract, permission engine, relay and console,
  with 330 JavaScript tests and 48 contract tests plus live Sepolia proofs —
  lives in the sibling `permission-core/` workspace on the build machine. This
  app is a clean swap of the owner-facing layer over the same tested API; the
  engine is not copied or modified here.
- The run state (deployed addresses, recorded receipts, the observation
  ledger) lives on the build machine. Private keys are never committed, never
  printed, and the testnet keys that do exist on disk are exposed by design
  and hold nothing of value.

## Running it locally

```
node mandate-workspace/app/serve.mjs     # the app on http://localhost:4181
node mandate-workspace/tools/check-jargon.mjs   # the gate; must say clean
```

The dev server serves only the app's own files and proxies `/api/` (and the
vendored signer libraries) to the console server on port 4173.

## Status

Live on Starknet Sepolia. The three enforcement tracks are proven on-chain
with real transactions; the owner-facing app is browser-verified through the
decision flow, including two owner-signed amendments carried end to end by the
owner's own wallet.
