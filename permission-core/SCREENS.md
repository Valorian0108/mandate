# The five screens

The console is a local web app (`node web/server.mjs`, http://127.0.0.1:4173) with five
screens. It exists so a person can do the things only a person should do — read what
their agent may do, decide what happens when the agent is blocked, see the history, and
move the agent's trust — without touching a command line.

Design: Hallmark, genre *modern-minimal*, theme *Cobalt*, tone *calm utility*.
Macrostructure: app-console tool shell with an N3 side-rail adapted to five numbered
screens. The full token set is locked in `web/tokens.css`; `web/style.css` carries the
macrostructure stamp. `.hallmark/log.json` records the run.

---

## 01 · Mandate — what the agent may do

Reads the **live** mandate from the Starknet account (`get_spending_policy`,
`is_recipient_allowed`, session fields) on every load. Shows per-call cap, window cap,
spent-this-window, calls used, allowed entrypoints, the merchant allowlist, and which
gates are registered. Nothing on this screen comes from a company database; the header
says so in plain words. The footer status bar shows chain id, block number, gate
address and how long ago the read happened.

## 02 · Proposals — what the agent asked for

A form that runs the *same* engine call the agent would run (`POST /api/requests`). If
the mandate allows it, the answer is "the agent may proceed" and nothing is stored. If
the mandate blocks it, a proposal is created in the append-only store and the screen
shows the block in the contract's own words (verdict, code, reason, gate). Existing
proposals are listed with status chips; opening one shows the full request.

## 03 · Approvals — your signature, not ours

The trust-critical screen. Pick a pending proposal, choose a resolution
(approve-once / amend / decline), preview the **exact** effect — the digest, every call
with calldata, every side effect including the v0.2 warning that re-setting the policy
restarts the spending window — and then sign **in this browser**.

The sign card offers two doors (track 2, phase 3). The first is a **native wallet**,
detected through `window.starknet` (Wallet Standard — Argent X, Braavos) by
`web/wallet.js`. Connect checks three things before anything can be signed, and every
refusal is loud and plain-worded: the network the wallet is on (a wrong network is
refused naming both networks); the wallet's key **read from the chain** via
`get_public_key` — never the extension's word for itself; and that key equal to the
GateAccount's owner key (a wrong wallet is refused showing both keys, and pointing at
the handover). Once connected, the wallet signs the SNIP-12 MandateAction in its own
window. Because a wallet can only bind **its own address** into a SNIP-12 hash (the
binding finding, recorded in `track2-wallet-research.md`), the envelope travels as
`wallet-snip12-v1` carrying its `signerAddress`; the server re-hashes with that address
and verifies raw ECDSA against the chain-read owner key — the claimed address only
selects the hash, the chain-read key stays the single gate. The second door is the
pasted testnet key, kept and labelled as the recovery path: `web/signer.js` recomputes
the digest locally, derives the public key, and refuses to sign if the derived key is
not the key the chain reports for this account. Either way the server receives only the
signature and re-verifies it against the chain-read key at resolution time. Both doors
are forgotten after every recorded resolution — each signature is a deliberate act.

(The page's CSP allows `chrome-extension:` in `script-src`: Chrome applies the page's
CSP to main-world scripts, so without it a wallet extension could never inject
`window.starknet` at all. The trade-off is recorded where the header is built.)

Once the resolution is recorded, the same screen offers the final hop: the Starknet
transaction that writes the amendment to the chain. The tab prices it through
`/api/tx/plan` (a dry-run — nothing signed, nothing sent), shows the exact transaction
it is about to sign — sender, chain id, nonce, fee bounds, every call and calldata —
then builds and signs it **in the browser** (`web/tx-signer.js`, whose invoke-v3 hash
maths is pinned against starknet.js by drift tests) and hands the finished signed bytes
to `/api/broadcast`. The server re-verifies the signature against the chain-read owner
key, checks the transaction is from the GateAccount on this chain, and carries the
bytes to the node verbatim — it never builds a transaction, so it cannot substitute
one. The tab cross-checks the hash the node reports against the hash it signed (a
mismatch is treated as a hostile relay, loudly), then watches the chain — never the
server — declare the outcome: the record stays `BROADCAST` until a receipt read back
from Starknet writes `SUCCEEDED` or `REVERTED`, and any leftover `BROADCAST` gets one
honest look on the next page load.

## 04 · Audit — the record, in order

Proposals, owner resolutions and on-chain submissions as a single timeline, newest
first, from the append-only files. Resolved signatures are re-verified against the
*current* owner key when the screen loads; a signature that no longer matches is marked
loudly instead of being hidden. Nothing on this screen can edit history.

## 05 · Résumé — what the agent has earned

The Layer D screen. Nothing here is read from a company database: `GET /api/resume`
recomputes the agent's stage **every time** from the signed records on disk — the
owner-signed identity, the witness-signed evidence, the owner-signed ladder changes —
and from the owner key read from the chain. If any signature fails, the screen shows
the refusal and the reason instead of a trust state.

It shows, in order: the stage and the plain sentence that goes with it; the concrete
limits that stage carries (and, for the stages that defer to it, the **live** on-chain
mandate numbers); the evidence summary with sandbox records coloured differently from
real ones, plus the Merkle fingerprint of every record; the chain's copy of that
fingerprint read fresh from the `EvidenceRegistry`, with a loud callout when the chain
did not answer or holds an older root; the full ladder history with each change's
digest, its verify-status against the chain owner key, and whether it was applied,
refused, or never reached; and the move card.

The move card is the trust-critical half. The server builds the exact unsigned change
and chooses every field that could be lied about — `seq`, the evidence root and count,
the timestamp, the owner key — so the browser signs facts, not a form. The browser
recomputes the digest with its own copy of `ladderChangeDigest` and refuses to sign on
mismatch; the preview shows what the new stage would allow, computed from the same
`PROFILES` table the door enforces. If the evidence does not support the chosen move,
that is shown as an override warning, not a block: the ladder suggests, the owner
decides. The owner key is typed into a field that lives only in the tab and is
forgotten on sign, on refresh, and on leaving the screen. At apply time the server
re-verifies the signature against the chain-read key **and** re-checks that the change
still binds the evidence that exists right now — a change signed against an older
snapshot is refused (409), not quietly applied.

The anchor button follows the same browser-signs/server-relays path as the Approvals
submit: `/api/anchor/plan` prices the anchor and refuses when there are no records or
the exact fingerprint is already on chain; the tab checks that the plan binds the
fingerprint shown on screen and comes from the GateAccount this console reads — a
mismatch is a refusal, not a warning — and signs the transaction in the browser; the
server relays the signed bytes verbatim. Nothing is recorded until a SUCCEEDED receipt
comes back from the chain and the registry is read back once more; the record then
lands in the deployment state with source `console-relay`. (`owner-tx.mjs` remains for
the demo scripts only, labelled.)

---

## Where trust sits

| Thing | Where it happens | Who can see the secret |
|---|---|---|
| Mandate data | read from chain, server-side, shown as-is | nobody's secret involved |
| Digest of a resolution | computed twice: server (for preview) and browser (before signing); the browser refuses to sign on mismatch | n/a |
| Digest of a ladder change | same: server builds the change, browser recomputes the digest and refuses on mismatch | n/a |
| Owner signature | **browser only**, `@scure/starknet` served from this origin | the tab; never the server |
| Signature check | server, against the owner key read **from the chain** at that moment | n/a |
| Trust stage | recomputed on every read from signed records; never stored, never read from a database | n/a |
| Final transaction | **browser only**: `web/tx-signer.js` builds and signs the invoke; the server re-checks the signature and relays the bytes verbatim (`/api/broadcast`); the node's hash must equal the tab's, and final status comes only from a chain receipt | the tab; never the server |

## Verification, honestly

- **165 `node --test` cases** in `permission-core` (75 Layer C + 62 Layer D + 28 for
  the browser-signed relay):
  engine, proposals, resolutions, gate paperwork, the SDK door, two live-alignment
  checks against Sepolia, ten console-control tests, eight signer tests including
  browser-vs-server digest equality for every resolution shape **and every ladder
  change shape**, plus a walk of the real served import graph proving no `node:` module
  reaches the page. Layer D adds identity, evidence/Merkle, ladder, trust, the door's
  sandbox/commit behavior, and thirteen résumé-control tests: the stage is recomputed
  from signatures; a forged or rotated-key signature moves nobody; a change signed
  against an older snapshot is refused once the records grow; illegal transitions,
  stale stages, foreign agents and skipped sequences are each refused on their own; and
  anchoring writes the exact fingerprint once and refuses to waste a second
  transaction.
- **28 of those cases guard the relay** (track 1 of `../NEXT.md`): seven drift tests
  pin the browser's invoke-v3 transaction hash against starknet.js 10.8.0 as the
  oracle — the maths is never typed from memory, and the library is a test-only
  dependency — and twenty-one relay-control tests where each control is the only
  thing between an attacker and an otherwise-successful broadcast: a validly-signed
  wrong-sender transaction, a wrong key, calldata tampered in flight, a wrong chain
  id, garbage bodies, a state file that disagrees with itself, node errors passed
  through verbatim with nothing recorded, double-broadcasts after a final receipt,
  receipt-driven status updates (pending → SUCCEEDED / REVERTED), and the anchor's
  price / already-anchored / lying-claim / once-only / unconfirmed refusals.
- **Live loop, 2026-10-25** (through the labelled harness path, since replaced by the
  relay below): browser-signed amendment → `/api/resolve` 200 AMENDED →
  `/api/submit` → SUCCEEDED `0x1492ec9c50a52ef8728941477c9b594a111d01043711a78ba6f046ee957b682`;
  chain afterwards showed cap 25, spent 0, window restarted — exactly the warned side effect.
- **Relay live loop, 2026-10-25**: ask 30 against the live cap of 25 → blocked
  `over-per-call-cap` → proposal `7c4e86b5b602d1f8` → amend to 30 → digest match →
  resolution signed in the tab → **the final transaction built and signed in the tab**
  (SN_SEPOLIA, nonce 0xd) → relayed → the node's hash equalled the signed hash →
  receipt `SUCCEEDED` / `ACCEPTED_ON_L2`
  (`0x7bdea2e5b1d28830d6b4b5d9eddcafba0557be88566a8bf67f94be2f75b0887`) → record
  written from the receipt alone: SUCCEEDED, via `relay` → Mandate screen re-read
  from the chain: per-call cap 30, spent 0, window restarted. No server process held
  the owner key at any point. The run also caught a latent UI regression — a render
  function that returned its HTML instead of assigning it, invisible to every test
  (`../observations.md` OBS-13).
- **Résumé live loop, 2026-10-25**: the screen read the live agent (stage `probation`,
  4 records, chain holding the exact fingerprint), previewed `probation → trusted` with
  a `digest match` chip and a loud "the evidence has not earned this step" override
  warning, signed in the browser with the testnet owner key, and the server applied
  step 2 after re-verifying against the chain key. The ladder file grew by exactly one
  change binding the same root the chain holds; the stage now reads `trusted`.
- **Screens verified in a real browser** by screenshot (Mandate ×2, Proposals ×2,
  Résumé ×3) and by DOM inspection for the rest: live data rendered, wrong-key refusal
  shown with the derived pubkey, resolved view with digest/signature/CHAIN KEY chip,
  audit timeline in order, résumé stage/anchor/history/move cards from live records.
  The résumé preview/sign loop was driven by dispatching the page's own `change`,
  `input` and `click` events from inside the document, because the browser bridge's
  accessibility snapshot does not expose this screen's controls (see limit 2).
- **Known limit 1 — CLOSED 2026-10-25: the last hop is browser-signed.** The final
  transaction is built and signed in the tab; the server only re-checks the signature
  and relays the bytes verbatim, and `owner-tx.mjs` remains for the demo scripts,
  labelled. The claim is now exact: the server never sees an owner key and never
  builds a transaction. What remains is the key's *shape* — the owner still pastes a
  throwaway testnet key into a field, which track 2 in `../NEXT.md` replaces with a
  real wallet.
- **Known limit 2 — the browser tooling.** OpenCode's browser bridge intermittently
  never settles continuations of fetches initiated by page module code (network log
  shows 200, page promise never resumes; manual `evaluate` fetches in the same tab work),
  its accessibility snapshot omits the console's re-rendered main content, and
  `browser.click`/`browser.screenshot` proved unreliable once the desktop window was
  hidden. Interactive loops were therefore completed by driving the page's own handlers
  from inside the document — the same listeners a user's click reaches. Details and
  evidence: `../observations.md` OBS-11.
- **Known limit 3 — testnet only.** Every key in this project is a throwaway testnet
  key. Real owner keys arrive with Privy embedded wallets; nothing here should ever be
  pointed at mainnet funds.
