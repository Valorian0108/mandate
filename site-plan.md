# Premium site — the plan (settled 2026-10-28)

Goal: the public face of `mandate`. A visitor understands the product in 30 seconds of plain
language, plays with a real demo (no wallet, no crypto knowledge), and sees live chain receipts.
Feel: ALIVE (motion, feedback, responsiveness) — Hallmark's slop test is the only QA gate from
Hallmark; its design flow is not used (user ruling in ui-tools-verdict.md).

Stack: vanilla HTML/CSS/JS + GSAP (motion engine) + emilkowalski/skills (motion taste) +
DESIGN.md via google-labs-code/design.md (brand lock, lint-checked).

## Style name (settled 2026-10-28)
Modern Minimalism — "instrument panel" variant (Stripe/Linear/Vercel school; technical/Swiss-influenced
minimalism; premium end = quiet luxury). Signature: cool-white ground, ONE signal color <5%, hairlines
not shadows, mono reserved for the machine layer, motion as feedback only. Banned: glassmorphism,
neobrutalism, atmospheric glow, maximalism. Techniques used (not identity): bento stats strip,
scrollytelling (GSAP) on the site. One-liner: "a quiet instrument panel you'd trust with your
money — that wakes up and responds when you touch it." DESIGN.md must encode this.

## Phase 0 — Setup (no site yet)
- `site/` folder in the mandate repo.
- GSAP installed (free, the only real dependency).
- emilkowalski/skills docs pulled locally as build-time reference (instructions for me, not installed code).
- Slop test = hallmark's references/slop-test.md (already local) — QA checklist only.
- `DESIGN.md` written: colors, fonts, spacing, motion rules, plain-language rules. Every design
  decision lands in this one file so the user can see/veto everything in one place.

## Phase 1 — Hero calibration slice
- Build ONLY the first screen: one plain-sentence headline, subline, two buttons
  (Try the demo / See the proof), alive elements (load motion, mouse response, scroll hint).
- Slop-test QA, serve locally, user reacts with one word: more / less / yes.
- Iterate until "yes". This locks the feel for everything after.

## Phase 2 — Full site (after feel is locked)
1. Hero (approved)
2. The problem, plain language (AI agents + money = trust problem) — scroll-driven story
3. Playable demo — embed the console mockup; visitor types 400, watches it stop
4. How it works — 3 steps, scroll-animated
5. Receipts wall — LIVE: page reads Sepolia public RPC from the browser (real txs, blocks,
   explorer links). Static page, live data, no server.
6. Closing + links (repo, console)

## Phase 3 — QA + publish
- Slop test full pass, jargon sweep (surface layer jargon-free), mobile check (320px+), perf sanity.
- GitHub Pages on the mandate repo → valorian0108.github.io/mandate (user does one Settings click).
- Link site from README. Commit + push each phase.

## Untouched
Console, server, contract, 330+48 tests. The site is a new floor in the same building.

## User's total workload
React to the hero (more/less/yes). One click to enable Pages at publish time. Nothing else.

## STATUS: PARKED (2026-10-28)
User ruling: 'im not going on with the demo again'. Priority is the working app
(scenario reskin of the tested console) - see product-shape.md 'Scenario definition'.
Hero slice (mockups/site-hero-demo.html) stays in the repo as a calibration artifact.
