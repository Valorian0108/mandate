# The second toy app — a live run through the front door

**Date:** 2026-10-25
**Command:** `node examples/toy-app.mjs` (inside `permission-core`)
**What it proves:** an app that imports *only* the SDK door can be allowed, blocked into a
proposal, and seen by the owner's console — without touching the engine, gates, proposal
store or digest maths.

## The app

`examples/toy-app.mjs` — one file, one import (`../src/sdk.mjs`), and only the door's
`createClient` / `loadMandate` / `execute` calls. A test statically checks that the only
import specifiers are `node:url` and the door.

It makes three calls against the live Sepolia mandate:

1. a transfer inside every limit;
2. the same transfer far beyond the per-call cap;
3. a `files:share`, a domain with no on-chain lock where the company policy says
   "always ask".

## The live result

```
mandate: per-call 25 · window 100 · spent 0
transfer 5      : ALLOWED - transfer of 5 to a listed merchant is inside every limit (per-call 25, window 100, spent so far 0)
transfer 100000 : DENY (over-per-call-cap) - GateAccount: amount over per-call cap -> proposal 29dec48f87b015de
share a file    : ASK_USER (approval-required) - sharing files always needs the user to approve this specific share -> proposal 08fb9bafe43551ae
```

| Call | Verdict | Code | Proposal |
|---|---|---|---|
| transfer 5 | ALLOW | `within-mandate` | none — the app proceeds with its own tool call |
| transfer 100000 | DENY | `over-per-call-cap` | `29dec48f87b015de` |
| files:share | ASK_USER | `approval-required` | `08fb9bafe43551ae` |

Both proposals were PENDING in the console immediately afterwards
(`GET /api/proposals`: 5 total, these two plus the three earlier ones). They are in the same
append-only file the Approvals screen reads — the door's default store, not a private one.

## What this closes

Layer C's "done when" was: a second, different gate plugs in without changing the core.
That was already shown by `files:*`. The SDK adds the second half: a **new app** can use the
layer through one import, and its blocked actions land in the owner's queue with no
app-specific plumbing. That is the proof of generality — the layer is a permission OS, not a
purchase app.

## Honest limits

- The first live run printed BigInts as `25n`; the CLI now stringifies for display. The
  door's values stay BigInts on purpose — money never passes through floats.
- The toy app does not execute the allowed transfer itself; the door answers, the app acts.
  That split is deliberate (the SDK is not a wallet).
- `files:*` is `advisoryOnly` — no chain lock yet, so its policy is company-side.
- The two proposals are waiting for the owner's browser signature; resolving them uses the
  same console path as every other proposal.
