# mandate-workspace

Working space for building the mandate app, with AnchorGate kept as a frozen
reference. Created 2026-10-28.

## Why this folder exists

AnchorGate (C:\Users\USER\test folder) proved the product pattern on PayPal.
Mandate already has the enforcement core (gate contract + engine + console,
378 tests, live Sepolia proofs). This workspace is where the two meet: the
new mandate frontend is built here using AnchorGate as the UX/product
reference, without either original project being disturbed.

## Layout

- `anchorgate-reference/` — read-only snapshot of the AnchorGate project
  (212 files, copied from C:\Users\USER\test folder). Deliberately excluded:
  `.env` (secrets), `.git` (history), `node_modules`, `.next`.
  All files are marked read-only. This is evidence/reference only.
- `app/` — the new mandate frontend (Track 4 reskin). It talks to the
  existing tested server in `permission-core/` over the same HTTP API.
  Five screens: Rules / Requests / Waiting for you / Activity / How it works.

## Rules (binding)

1. Nothing in `anchorgate-reference/` is ever modified. It is a snapshot.
2. The original AnchorGate folder (`C:\Users\USER\test folder`) is never
   touched — not by tooling, not by scripts, not by this workspace.
3. Mandate's engine, server, and tests stay in `permission-core/` untouched.
   The frontend here is a clean swap that consumes the same HTTP API.
4. The reference copy is gitignored (another project's MIT code, kept local
   for reading only). Only the mandate app work is committed.
