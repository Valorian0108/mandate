# Mandate

Your AI assistant spends only inside rules you set. Every request is checked
against them before anything happens, and nothing moves without you.

> ## Status: testnet phase
>
> Everything in this repository runs on **Starknet Sepolia, the test
> network, with test funds only**. The enforcement is real and proven with
> live transactions, but this is not a production system: there is no
> mainnet deployment, no real value involved, and no onboarding for
> outside users yet. See "What is not finished" below.

## The idea in one comparison

Think of a bank debit card. The bank's system is the same for every
customer, but you set your own card limit in your banking app. Changing
your limit does not rebuild the bank.

Mandate is that, for an AI assistant:

- The account system is built once, tested, and shared. It knows how to do
  one thing: when a spend request arrives, compare it against the stored
  rule values and refuse if it does not fit. Enforcement lives in the
  account itself, so it holds no matter who asks.
- The rules are **your settings, not code**: a limit per purchase, a budget
  for the month, the list of stores your assistant may pay, an expiry, and
  a call allowance. They are data stored inside your own account, and only
  your signed instruction can change them.
- Your assistant holds a delegated key, never your owner key. It can act
  inside the rules, and that is the whole extent of its power.
- When a request does not clear the rules on the spot, it stops and waits
  for you. You decide in plain language: approve this purchase once, change
  the rules, or say no. Every decision and every action is recorded
  permanently, append-only, with a receipt you can open. Nothing is ever
  quietly deleted or edited.

The owner-facing app is held to the same plain language by a mechanical
gate: no addresses, keys, hashes, gas, chain names or signing vocabulary
anywhere a user reads, except inside two approved places (the confirmation
popup and the receipt drawers), which are fenced in the source so the gate
can see exactly where the machine layer is allowed to speak.

## What is proven live on Sepolia

- A real assistant purchase executed inside the rules:
  `0x7bdea2e5...b0887`.
- Ownership of the account handed over to the owner's key in a real
  transaction: `0x2c2b0395...88010`. The server never holds the owner key.
- Owner-signed rule changes (raise a limit, extend a budget) carried end to
  end by the owner's own wallet, landing as real transactions.
- 330 JavaScript engine tests and 48 contract tests pass, covering the
  happy paths and the abuse paths: forged signatures, replayed requests,
  overspending, stale and backwards rule changes.

## What is not finished

- **No mainnet.** Going to the real network with real value needs audits,
  a security review, and hardening beyond this repository's scope.
- **No onboarding.** There is no signup and no way for a new person to get
  their own account instance with their own settings today.
- **The owner app is a demo window** over the tested API, currently
  browser-verified on the five screens (Rules, Requests, Waiting for you,
  Activity, How it works).

## What is in this repository

- `gate-account/` - the enforcement core on Starknet: the GateAccount
  contract (rules checked inside the account, append-only evidence
  registry), its 48 contract tests, and the deploy/handover tooling used
  for the live Sepolia proofs.
- `permission-core/` - the permission engine and console server. One
  standard question ("may this agent do this action to this resource?"),
  pluggable gates, ALLOW / DENY / ASK_USER with plain-word reasons. 330
  JavaScript tests. The console server (port 4173) exposes the HTTP API the
  app reads.
- `mandate-workspace/app/` - the owner-facing app. Five screens, vanilla
  JavaScript, no build step. It holds nothing: every number is read live
  from the account through the tested server's API.
- `mandate-workspace/tools/check-jargon.mjs` - the jargon gate described
  above. It also enforces the colour-token and 44px control-floor rules.
  `node mandate-workspace/tools/check-jargon.mjs` must say clean.
- `mockups/` - the approved design direction and the companion character
  sheet used for the app's visual language.
- Top-level notes (`observations.md`, `layer-map.md`, `product-shape.md`,
  and friends) - the build ledger and design record. `observations.md` is
  the running evidence log; entries are never removed.

Private keys are never committed and never printed. The testnet keys that
exist on the build machine are exposed by design and hold nothing of value.

## Running it locally

```
node permission-core/web/server.mjs      # the console + API on http://localhost:4173
node mandate-workspace/app/serve.mjs     # the app on http://localhost:4181
node mandate-workspace/tools/check-jargon.mjs   # the gate; must say clean
```

Tests:

```
cd permission-core && node --test        # 330 engine tests
cd gate-account && snforge test          # 48 contract tests
```

The app's dev server serves only the app's own files and proxies `/api/`
(and the vendored signer libraries) to the console server on port 4173.
