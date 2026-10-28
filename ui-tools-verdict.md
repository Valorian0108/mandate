# UI/UX tools — verdict for Track 4

Evaluated the 8 repos against two hard constraints:
1. The console is **vanilla HTML/CSS/JS** with CSP nonces and a style gate — 330 tests pass on it. Rebuilding in a framework = throwing away the tested surface.
2. **Hallmark governs** the redesign (audit → redesign in place, "calm utility" tone).

## What this category of web app is meant to be like

This is a **trust console** — the app class of Mercury, Linear, and the Stripe dashboard. Not a landing page, not a marketing site. Its job: a non-crypto owner opens it and *instantly* knows what their agent may do with their money, and feels in control. The rules that follow from that:

1. **State at a glance.** "What can the agent do right now?" answered on screen without a single click. Limits, spent-so-far, active rules — visible, aligned, numeric.
2. **One primary action per screen.** Everything else is secondary or hidden. No walls of buttons.
3. **Two layers everywhere.** Plain language on the surface; jargon (nonces, felts, selectors, tx hashes) only behind a "Show the proof" toggle.
4. **Motion = feedback only.** Animation exists to confirm state changes (approved, refused, pending) — never decoration, never scroll theater.
5. **Calm.** Whitespace, aligned figures, restrained palette, quiet panels. No gradients, glows, 3D, or particle effects — those signal "toy," the opposite of trust.
6. **Every claim is one click from its receipt.** Verdicts link to on-chain evidence. Trust is shown, not asserted.

That is the "feel," stated as spec: **a quiet instrument panel you would trust with your money.**

## The 8 tools

| Repo | What it is | Verdict |
|---|---|---|
| `emilkowalski/skills` (50.9k★, MIT) | Animation + taste methodology for AI coders, by the author of Sonner/Vaul. Plain markdown instructions, framework-agnostic. | **USE.** Motion rules apply directly to vanilla CSS/JS. Governs rule 4. |
| `google-labs-code/design.md` (28.6k★, Apache-2.0) | Google Labs: a `DESIGN.md` spec file + CLI (`npx @google/design.md lint / diff / export`) that locks design tokens (colors, type, spacing) and flags drift. Windows: `designmd` alias. | **USE.** Machine-enforced design spec — same philosophy as our style gate. Pairs with Hallmark's design.md concept. Lint output can feed `check-style.mjs`. |
| `leonxlnx/taste-skill` (103.9k★, MIT) | Anti-AI-slop "taste" skill; v2.1 has a dashboard/app-screen mode (quiet panels, aligned figures, browser self-check). Needs Node 22+ & Chrome. | **OPTIONAL.** Overlaps heavily with Hallmark + emilkowalski. Adopt only if a gap shows up during the audit. |
| `greensock/gsap-skills` (17.4k★, MIT; GSAP now fully free) | Skills for the GSAP animation library. | **SKIP FOR NOW.** Our motion needs are small state-feedback transitions — CSS covers them. Revisit only if the guided walkthrough needs choreography CSS can't do. |
| `DavidHDev/react-bits` (50.5k★, MIT + Commons Clause) | Animated **React** component library. | **NO.** React components can't drop into a vanilla console with CSP nonces. Adopting means discarding the tested console. |
| `DavidHDev/canvas-ui` (5.2k★, MIT + Commons Clause) | Experimental HTML-in-canvas WebGL effects; requires Chrome flags. | **NO.** Experimental + flag-gated + purely decorative — the anti-pattern for a trust console. |
| `oso95/scroll-world` (10.6k★, MIT) | Scroll-driven landing pages powered by AI-generated video; paid backends (Monid/Higgsfield, ~$27/run). | **NO.** Wrong genre (marketing video landing page) and a paid external dependency. |
| `nexu-io/open-design` (104k★, Apache-2.0) | A separate, heavy design-workspace application. | **NO.** We redesign the existing console in place; a second design app adds workflow, not value. |

## The jargon concern — handled structurally, not by hope

Order of work guarantees no localhost jargon survives into the rebuild:

1. **Style gate grows teeth FIRST** — before any screen is touched, `check-style.mjs` gets a banned-jargon list scanned across every UI surface (nonce, felt, selector, calldata, "mandate" → "the rules", etc.). Gate fails loudly → jargon physically cannot ship.
2. **Then** the Hallmark audit + screen-by-screen redesign in place.
3. Today's jargon survives only inside "Show the proof" panels — which is exactly where the receipts belong.

## Why the console is vanilla CSS/JS, and the two redesign paths

**Who made it that way:** a build decision made during the tracks (not a user decision — vetoable). Reasons: the server pins every script with CSP nonces (part of the security story we demo), zero dependencies = zero supply chain to audit, and the style gate reads the raw page.

**Key fact:** all 330 tests live in the server / permission engine, not the page. The UI talks to it over a plain HTTP API. So:

- **(a) Visual redesign in place** — this IS Track 4. Hallmark audit → new look via locked design tokens (design.md) → tested plumbing untouched.
- **(b) Technology rebuild (React etc.)** — possible; a new UI hits the same API. Cost: redo CSP nonces, style gate, and browser proofs, plus a build step and dependencies.

**Senior-dev call:** do (a). Reconsider (b) only if the redesigned console still feels limiting — at that point it's a frontend swap, not a product rewrite.

## UI breakdown — what is actually on each screen

5 screens, verified against `web/app.js` (ROUTES = mandate, proposals, approvals, audit, resume). Track 4 renames/declutters/restyles these — no structural invention.

| Screen (now) | Plain name (Track 4) | Contents |
|---|---|---|
| `mandate` | **The rules** | Per-request cap, monthly cap, spent so far; merchant allowlist; agent session; the lock + who holds the key |
| `proposals` | **Requests** | "Ask as the agent" form (amount + merchant) → instant verdict: auto-pass or needs-your-signature; list of asks |
| `approvals` | **Waiting for you** | Plain sentence of the ask, why blocked, Approve/Refuse → wallet signature |
| `audit` | **History** | One plain line per action, each with "Show the proof" → tx hash, block, receipt |
| `resume` | **How it works** | Guided walkthrough / demo story |

Two layers: surface = plain sentences, numbers, buttons (change rules / approve-refuse / show proof). Jargon (nonces, hashes, selectors) lives ONLY behind "Show the proof", enforced by the style gate's banned-words list before redesign starts. Server, contract, 330 tests, signing flow: unchanged.

## HALLMARK DEMOTED — user ruling, 2026-10-28

User feedback: Hallmark-driven output "looks DEAD — doesn't feel responsive, looks like a receipt." Ruling: **only the slop test survives** (58-gate anti-AI-slop checklist, used as QA on every build). Hallmark's design flow, genres, themes, macrostructures, and the audience/use-case/tone questions are NOT used. No more design questionnaires — user reacts to built artifacts.

Design direction for the premium site: **alive** — motion, feedback, responsiveness to the user — while staying trustworthy. Revised stack:

- **GSAP: IN** (promoted from bench) — the aliveness engine; real library, free, vanilla-compatible.
- **emilkowalski/skills: IN** — animation/interaction taste layer.
- **design.md: IN** — brand lock across site + console.
- **Hallmark slop test: QA gate only.**
- The Cobalt console mockup (mockups/track4-console.html) stays valid as the *console's* calm baseline; the site gets the living layer.

## FINAL tool decision (settled 2026-10-28, covers BOTH the premium site and the console redesign)

- **IN — `google-labs-code/design.md`:** one DESIGN.md locks tokens (color/type/spacing) so site + console read as one brand; `designmd lint` catches drift (pairs with check-style.mjs).
- **IN — `emilkowalski/skills`:** motion + taste rules for site feel and console state-feedback animations; vanilla-JS compatible.
- **BENCH — `greensock/gsap-skills`:** only if CSS can't achieve a wanted scroll moment on the site. Default CSS-first.
- **OUT — `leonxlnx/taste-skill`:** overlaps Hallmark, which governs.
- **OUT — `react-bits` (React), `canvas-ui` (experimental WebGL + Chrome flags), `scroll-world` (paid AI-video landing pages), `open-design` (separate heavy app).**

Architecture: static site (the face) → console + server (the product, dynamic) → Starknet (the truth). The static site can read live chain state via public Sepolia RPC from the browser — no server needed for the receipts wall.

## The feel — settled

The 6 rules above are the spec. Two ways forward:
- **Veto** any rule and I'll revise, or
- **Paste 1–3 screenshots/URLs** of apps whose feel you like → Hallmark `study` extracts their design DNA and we match it inside the same constraints.

If neither, the spec stands and Track 4 executes against it.
