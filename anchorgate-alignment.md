# AnchorGate ↔ mandate — alignment verdict (2026-10-28)

Repo: github.com/Valorian0108/anchorgate (public, 82 commits, master).
Live: anchorgate-five.vercel.app. Local folder: not found in common locations
(Desktop/Documents/Downloads/projects, depth 3); clone on request.

## Verdict

Aligned. Same product thesis, same architecture, same verdict model — different
enforcement substrate. AnchorGate = the product shell and UX, proven live on
PayPal sandbox. Mandate = the same shell with the gate moved into the money
rails (Starknet). AnchorGate saves the entire product-thinking phase; mandate's
one differentiator is the thing AnchorGate structurally cannot claim.

## Same — reusable, no re-thinking needed

- Thesis: agent proposes, rules decide, owner approves, every decision leaves a receipt.
- Three verdicts: ALLOW / ASK / DENY (mandate: pass / stop / ask).
- Deterministic decisions; no model ever asked whether its own request should pass.
- Fail-safe: no rules configured -> nothing can be approved.
- Approvals are one-request-only, immutable, hard constraints re-checked before paying.
- Per-purchase record with provider proof (AnchorGate: signed PayPal webhook;
  mandate: on-chain tx).
- Plain-language refusals; demo agent; ask box (LLM parses, never decides).
- AnchorGate rules are RICHER than mandate today: 8 purchase categories,
  exact-item auto-pay list (same item + same price, once a month), auto-budget
  meter, monthly wall.

## Different — mandate's reason to exist

- Enforcement point: AnchorGate = its own server code (Vercel). The vendor is
  the enforcer. Mandate = on-chain contract. The vendor cannot bend it.
- Payment rail: PayPal sandbox vs Starknet testnet.
- Identity: Supabase email/password vs owner wallet signature.

## What it saves

- Entire product-thinking phase: rules model, verdict wording, approval
  lifecycle, record design, fail-safe semantics, UX language.
- Track 4 becomes "port proven screen language onto mandate's engine", not
  "invent the app".
- Extra rule types available for later: categories, exact-item auto-pay list,
  auto-budget meter (Track 4+ scope, not v1).

## What it does not solve

- The sovereignty claim. AnchorGate cannot make it; that is the mandate
  differentiator already built and proven in Tracks 1-3.
- Paired story: pattern proven on mainstream money (AnchorGate) + pattern with
  the user as enforcer (mandate). Different rails, same pattern.

## Warning

- Do NOT merge codebases. AnchorGate: Next.js 16 / React 19 / Postgres /
  Drizzle / Supabase / Vercel. Mandate: vanilla console + Node + Starknet.js +
  snforge. Port product decisions and screen language, not the framework.
  A framework port is a large detour with zero product gain.
