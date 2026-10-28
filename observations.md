# Observations Log

Insights, stances, and principles that emerge during review — things that don't belong to a single breakdown item but shape the whole build. Logged as they come up, with source context.

---

## OBS-01 · Decentralization is a tool, not the pitch
**Category:** Stance / positioning principle
**Source:** Demi, during Layer B review (originally stated in the Starknet convo).

> "Centralization will be involved but the aim is never to show that decentralization is better."

**What it means:** This build is not ideological. Centralized components (UI, servers, AI providers, databases) are fine wherever they are convenient. Decentralization is used *surgically* — only at the authority boundary, where a promise must become an enforced constraint. The product never sells "decentralization good"; it sells "you own the controls that matter."

**Design consequence:** Never decentralize for its own sake. Every on-chain component must justify itself by removing a trust requirement, not by being on-chain.

---

## OBS-02 · Authority usability = executor plurality
**Category:** Core insight / architecture principle
**Source:** Discussion of "what is the use of an authority that cannot be used?" (Layer B review, B3 amendment).

> An Ethereum key is useful not because MetaMask respects it, but because the *entire network* respects it. Usability of an authority = how many executors honor it, not whether your favorite app survives.

**What it means:** User-owned authority only has value if execution paths exist independently of any single app. If one company's server is the only executor, "owning" the rules is theater — the rules die with the server. The authority must live where many independent parties can read and enforce it (a public network), and the schema must be open enough that any app can choose to honor it.

**Design consequence:** Two hard requirements follow:
1. Authority lives on a network-level home (e.g., Starknet account), not in an app database.
2. The mandate format is an open standard (plugins, SDK — breakdown items C2/C3), so honoring a user's rules is something *any* developer can do, growing executor count over time.

**Related:** This is the metric the whole platform should optimize for — *number of independent executors that honor a mandate*.

---

## OBS-03 · Trust is enforced by the receiver, never granted by the sender
**Category:** Security principle
**Source:** Layer D review — fear that someone plugs an untrained agent into real systems.

> Cold-start is not a promise an operator makes about their agent; it is a policy every receiving app applies at its own door. An agent with no signed history gets propose-only/$0 *automatically*, no matter what its operator configured. Claims are exportable; trust is not.

**Design consequence:** The SDK must default to "unknown agent = minimum permission." Reputation records must be signed by the app that witnessed them, so fake histories fail verification. Operators can only raise limits inside their own gate, where the only victim is themselves.

---

## OBS-04 · Capability is per-domain; the builder is user #1
**Category:** Bootstrapping principle
**Source:** Layer D review — "how do I train it when there's no one yet?"

> Evidence grows per domain: a clean shopping record does not make an agent trusted for deployments. Each new vertical restarts near the bottom of the ladder. And the first evidence is self-produced — the builder runs their own agent against their own gate in sandbox (the AnchorGate demo-agent playbook).

**Design consequence:** Résumés must be domain-tagged (`shopping: 50 clean`, `travel: 0`). No chicken-and-egg trap: first user, first app, and first gatekeeper are all the builder. Incompetence is not a safety problem — Layer A already makes bad agents harmless (refusals, not damage); training only improves proposal quality.

## OBS-05 · The compiler is the first executor of "model proposes, code decides"
**Category:** Build-process principle
**Source:** First compile of gate-account — 135 errors → 0, 2026-10-24.

> An AI wrote a ~490-line smart contract from memory of documentation. It was wrong in 135 places — wrong import paths (the OZ docs describe an older version than the pinned v4.0.1 source), syntax that doesn't exist in Cairo (brace-style enum variants), an edition that silently broke event codegen. Every single mistake was caught by the compiler before a byte of bytecode existed. Nothing shipped on memory; everything shipped on the pinned, audited source actually checked out on disk.

**What it means:** Layer A ("verifiable not trustworthy", "model proposes, code decides") is not just a product claim — it is literally how this product is being built. The AI is the proposing model. Scarb/Cairo is the deciding code. The same pattern that makes the agent safe at runtime (policy enforced by the network, not by promises) makes the AI-authored build safe at compile time (correctness enforced by the toolchain, not by confidence).

**Design consequence:** Never treat generated code as a draft that "looks right" — treat the pinned dependency source + compiler + tests as the only authority. When docs and checked-out source disagree, the source wins. This also validates the product thesis from the inside: a builder who doesn't hand-trust their own AI can't credibly sell "don't hand-trust your AI."

---

*Next observation number: OBS-06*

## OBS-06 — 2026-10-24 — "Tests compile" is not "tests run"

Writing the 12 tests took one pass, but only because every API was read from the cached
snforge_std / OZ source first (start_cheat_signature_global, start_cheat_nonce_global,
start_cheat_chain_id_global, declare -> DeclareResult, SignerTrait::sign).
The compile check still caught one real mistake the design did not: mock contracts must live
in the contract target (src/mocks.cairo), not in 	ests/, because snforge can only declare
classes that a starknet-contract target produced.

Also: scarb test compiles and reports "0 tests" — snforge's plugin rewrites #[test], so
cairo-test sees nothing. A green compiler says nothing about whether the assertions are right.
Only snforge executing them does.

And the hard blocker turned out to be one line of systeminfo:
Virtualization Enabled In Firmware: No. No amount of Windows tooling fixes a BIOS switch.
The lesson matches the whole project thesis: check what the executor actually enforces,
not what the layer above claims.

## OBS-07 — 2026-10-24 — The harness is part of the claim

First real execution: 12/12 failed with `Account: unauthorized`. The contract was fine.
`start_cheat_caller_address(account, 0)` is indefinite, so it also rewrote the caller of the
account's own nested self-call, and OZ's `assert_only_self()` correctly rejected it.
Scoping the cheat to one call (`CheatSpan::TargetCalls(1)`) fixed all 12.

This is the third time in this project that the layer *above* the mechanism quietly decided the
answer: the compiler (OBS-05), cairo-test reporting `0 tests` while looking green, and now a
cheatcode. It is also the exact failure the product exists to prevent: a test that passes
because the thing being tested was replaced by a stand-in.

Second lesson: the first run is worth more than the tenth. 12 failures produced a precise,
one-line diagnosis. A green first run would have told us nothing about whether the assertions
were real.

Result: 12/12 passing, including the two thesis tests (over per-call cap rejected, over window
cap rejected) and the privilege-escalation pair (agent cannot add session keys or rotate the
owner key).

## OBS-08 — 2026-10-24 — A declared control is not an enforced control

Picking the work back up, the contract did not compile: `Not all trait items are implemented.
Missing: 'allow_recipient', 'disallow_recipient', 'is_recipient_allowed'`. A merchant allowlist
had been started and abandoned halfway — the trait declared it, the storage map existed, the two
events existed, the selectors were already in the admin blocklist. What did not exist was the
implementation, and, more importantly, the *check*: `enforce_spending` moved money without ever
looking at who received it.

Two lessons, and the second is the one that matters.

1. The compiler caught this only by accident of shape. It complained because a trait item had no
   impl. Had the impl been written and the check inside `enforce_spending` forgotten, the
   compiler would have said nothing at all. The owner would have called `allow_recipient`, the
   event would have emitted, storage would have flipped to `true`, the ABI would have advertised
   a merchant allowlist to every integrator — and the agent would still have been able to pay
   anyone. A permission system can be fully *described* and entirely *inert*.

2. So the unit of verification is not "the function exists" but "the money is stopped." Every
   control needs a test in which that control is the only thing standing between the agent and a
   transfer that would otherwise succeed. That is what t13 is: correct selector, amount inside
   both caps, valid signature, valid session — only the recipient is wrong, and the transfer must
   still fail. t16 does the same for authority: the owner deliberately whitelists
   `allow_recipient` for the agent, and the blocklist must outrank the whitelist anyway.

Also worth recording: the conversation summary for this session said the tests were unwritten and
WSL was blocked. The repository said 12 tests existed, had been run, and passed. The notes had
drifted from the artifacts. Ground truth is what the executor reports, not what the record says —
which is the same claim this whole project is built on, applied to our own paperwork.

Result after finishing the allowlist: 16/16 passing under snforge (WSL2, Foundry 0.64.1).

## OBS-09 — 2026-10-24 — The live network teaches what simulation hides

Stage 2 put the thesis on Sepolia: an agent holding only a session key sent a transfer the
mandate allowed (SUCCEEDED, `0x59e507bb...`) and two it forbade — over the per-call cap and to an
unlisted recipient — both REVERTED by the network itself, quoting our contract's own error
strings in the receipts. The design held. But three things only the live run could teach:

1. **A gas revert is still evidence.** The first attempt reverted with "Insufficient max L2Gas" —
   and that failure *proved the session signature validated*, because a bad signature fails
   earlier and differently ("account validation failed"). Reading failures precisely turned an
   apparent setback into the key datapoint. Cause: starknet.js estimates fees with
   SKIP_VALIDATE, so a custom `__validate__` (poseidon + ECDSA ≈ 1.5M L2 gas) is invisible to
   the estimator. Any account with non-trivial validation must pad its own estimates; nobody's
   tooling will do it for you.

2. **Cross-implementation agreement is a testable claim, not an assumption.** The JS submitter
   and the Cairo contract each compute the session hash independently. Before submitting anything
   live, t17 pinned both to the same felt for a canonical vector. Without it, a one-byte
   divergence would have surfaced as an opaque on-chain rejection and hours of debugging the
   network for a local typo. When two codebases must agree on a hash, the agreement itself gets
   a test.

3. **The record drifted again — this time on a version number.** Notes said starknet.js 7.6.4;
   the package that actually resolved was 10.8.0, and the "7.6.4 supports spec 0.9" conclusion
   was v10 behaviour misattributed. Same lesson as OBS-08's closing note: ground truth is what
   the executor reports. State after the run was read back from the chain, not from the script's
   exit code: `calls_used: 1`, `spent_in_window: 5`, merchant balance 5, stranger balance 0 —
   the reverts consumed no budget and moved no funds.

Result: 17/17 under snforge, and Layer E's "done when" — an agent transaction that breaks policy
is rejected by Starknet itself, on testnet — closed with receipts.


## OBS-10 — 2026-10-24 — The same data can pass through one signature path and crash another

The Layer C cap-raise demo (`permission-core/DEMO-cap-raise.md`) closed the loop — user
signs, chain obeys, agent retries, transfer succeeds — but its first run died between a
successful dry-run and the real submit: `Cannot mix BigInt and other types`. Three lessons,
each a variation on "a claim nobody exercised is not a claim":

1. **Type contracts belong to a path, not to a library.** Hex-string resource bounds had
   already flown through live Sepolia transactions in Stage 2 — via the agent path, whose
   session signature never covers the transaction hash, so starknet.js never computed one
   locally. The owner path signs the tx hash, and the hash code does BigInt shifts directly
   on the bounds (`encodeResourceBoundsL1`). Same library, same values, same JSON — one path
   never touches the arithmetic that the other path cannot survive. "It worked before" is
   evidence about the path you ran, not the one you are about to run.

2. **A dry-run that doesn't sign can't catch signing bugs — so reproduce up to the cliff
   edge, not over it.** The estimate-only dry-run passed and proved nothing about the failure
   ahead. The tool that found the bug was `getSignedTransaction`: the library's own
   build-and-sign-without-broadcast, i.e. a reproduction that stops exactly one step before
   the irreversible one. When debugging anything that spends, the safest repro is the fullest
   dry path that cannot broadcast (`gate-account/tools/probe-execute.mjs`). Checks need
   checks — the dry-run's silence was itself an unchecked claim.

3. **A stale prediction is a lie the tool tells with confidence.** `agent-tx.mjs --send`
   predicted outcomes from a hardcoded "per-call cap is 10" — true when written, false the
   moment the demo's amendment landed. Fixed by reading the prediction live from the chain
   (`get_spending_policy` + `is_recipient_allowed`, new `--predict` mode), the same
   source of truth the enforcement uses. Anywhere a tool tells the user what WILL happen,
   that sentence must be derived from the authority that decides — never from memory of it.
   Same family as ISRC6_ID and the 7.6.4-vs-10.8.0 version drift: the record is not the
   reality; ask the reality.

Result: demo run 2 passed every assertion on live Sepolia — owner amendment
`0x728c64fe...`, agent retry `0x414f0ddd...` — and run 1's unresolved-looking proposal
stays visible in the append-only store. The audit trail includes the failure.


## OBS-11 � 2026-10-25 � The browser tooling can eat a fetch's continuation, and the app is not guilty until proven so

While driving the permission console's Approvals screen through the OpenCode browser
tools, the "Preview the exact effect" button appeared broken: the panel stayed on its
loading line forever. It was not the app. The evidence, in the order it was collected:

1. **The network layer said success.** Every stuck attempt showed up in the browser's
   network log as `POST /api/preview ? 200, state: completed`, with a full response body.
   The server log showed exactly one preview request per stuck attempt, processed and
   sent. So the bytes arrived.

2. **The page's own promise never resumed.** Instrumenting `api()` showed the sequence
   stop mid-flight: `fetch()` was called, the network completed, and the `await` after it
   never ran � no `.then`, no rejection, no unhandled-rejection event. Meanwhile a manual
   `fetch('/api/preview', �)` typed into the SAME tab, SAME page, resolved in ~775 ms and
   its `.text()` read 1533 bytes without trouble.

3. **Everything that could be the app was ruled out.** Served `app.js` was byte-identical
   to disk (sha256 compared). Wrapping every fetch in `response.clone()` (in case the
   tooling's network capture consumed bodies) changed nothing. Adding `Connection: close`
   server-side (in case pooled sockets clogged Chrome's six-per-origin cap) changed
   nothing. Restarting the server and opening a fresh tab changed nothing. Driving the
   exact same handler by calling `button.click()` from inside the document � bypassing
   the tooling's event delivery � also hung, while the tooling's own `evaluate` fetches
   in the same tab kept working.

4. **The pattern that fits all of it:** fetches *initiated by page module code*
   intermittently never settle their continuations, while fetches initiated by the
   tooling's `evaluate` in the same tab always do. That is a property of the harness's
   browser bridge, not of the console. The same class of flakiness showed up as
   `browser.click`/`browser.check` sometimes not delivering events, and later as
   `browser.screenshot` failing with "Screenshot needs a visible tab" once the desktop
   window was hidden.

What I did about it: the approval loop was completed and verified by driving the page's
own signer from inside the document (browser digest = server digest, signature verified
against the chain-read owner key, `/api/resolve` ? AMENDED, `/api/submit` ? SUCCEEDED
tx 0x1492ec9c�), and the console's protocol is covered by 54 `node --test` cases
including a test that walks the real served import graph. The UI-click path itself is
verified as far as this tooling allows, and the limit is written down here rather than
papered over.

Lesson: when a tool reports "the request succeeded" and the code reports "I never got
it", trust neither alone � put a marker at every step between the two and find which
step is the last one that happens. The step after the last marker is where the world
stopped cooperating. And when the world is the tooling, record it as a tooling limit
(OBS-08's loud-skip rule applies to verification claims too): do not claim a UI path is
verified when the only reason it could not be clicked was the clicker.


## OBS-12 - 2026-10-25 - The accessibility snapshot can be blind to a page that re-renders itself

Verifying the console's new Resume screen (05) hit a second tooling limit. The page was
proven loaded and correct by three independent reads - `document.title`, the rendered
`#view` innerHTML, and extracted field values (stage chip, anchor callout, ladder
options, history steps, disabled sign button) - yet the browser bridge's accessibility
snapshot showed the main region as an empty shell: header and nav only, no form
controls, no refs to click. `browser.find` for the preview button's exact visible text
returned zero matches. The same tab, same moment, same DOM.

What ruled out the app: the missing nodes were present in the DOM (innerHTML showed
them, `querySelector` returned them, their event listeners fired when events were
dispatched). What ruled out a stale snapshot: a fresh full snapshot, taken seconds
later with the page idle, was equally blind. The console's other screens had rendered
into snapshots earlier in the project's history, so this is not "the console is
invisible" - it is the bridge's tree failing to include a region the page replaces
wholesale via `innerHTML` on every render.

What I did about it: the preview-sign-apply loop was driven by dispatching the page's
own events from inside the document - `change` on the stage select, `input` on the
reason and key fields, `.click()` on the preview and sign buttons. Those are the same
listeners a user's mouse reaches; the handlers, the digest recompute, the key check and
the server round-trips are all the real code. The outcome was then verified from three
places that cannot lie to each other: the page (flash text, stage now `trusted`, key
field emptied, sign button re-locked), the ladder file on disk (grew by exactly one
change binding the same root the chain holds), and the server's own re-verification
(409s for every forged/stale/foreign variant, covered by 13 resume-control tests).

Lesson: a verification tool that reads the page through one lens (the accessibility
tree) is a witness, not the ground truth. When the witness and two other witnesses
disagree, believe the majority and write down which one was blind - silently trusting
the blind witness would have meant either skipping the check or claiming the screen
"could not be tested", and both would have been false.

## OBS-13 - 2026-10-25 - The live run catches what 165 tests cannot see

Wiring the browser-signed relay (NEXT.md track 1) ended, as every track must, with a
live proof run in the real console: ask as the agent, get blocked by the live chain
cap, amend, preview, sign. At the preview step the panel froze on "Reading the live
mandate..." forever. The server was provably healthy - a direct fetch from the same
page returned the correct preview and digest in under two seconds, and the console
showed zero errors. The bug was in the page: `renderPreviewPanel` had one branch that
**returned** its HTML string instead of assigning it to `el.innerHTML`, while every
other branch assigned. The loading branch painted the spinner; the success branch
returned into the void; so the spinner was the last thing ever drawn. The function had
been broken since screen 03 was built, and every test still passed - because no test
can look at a DOM. The bug only exists where a function both mutates and returns; a
sweep of every template-literal return in the file confirmed all the other sites are
pure builders whose callers consume the value.

After the one-word fix, the same flow ran live end to end: digest match, resolution
signed in the tab, transaction signed in the tab, relayed, node hash == signed hash,
receipt SUCCEEDED / ACCEPTED_ON_L2 (`0x7bdea2e5...b0887`), chain re-read showing the
cap moved 25 -> 30.

Lesson: unit tests verify the parts you can call; only the live run verifies the
composition a human actually touches - which is why "live proof before done" is a
house rule and not a flourish. Keep every function in one mode: either it mutates the
DOM, or it returns a string; a function that does both depending on the branch is a
trap with the safety off. And when a screen freezes, probe both sides (a fetch from
inside the page, and the page's own state) before believing either is guilty - here
the network said "fine" and the DOM said "fine", and the lie was in the single line
connecting them.

## OBS-14 - 2026-10-25 - Check the assumption BEFORE the phase that depends on it

Track 2's research file listed one assumption as "expected yes; must be proven at
build time": that a native wallet could sign the things our account needs. Phase 3
started by proving it from the oracle's source instead of starting the connector -
and the answer was NO in exactly the place it mattered. starknet.js
`Account.signMessage(typedData)` passes **the wallet's own address** into the SNIP-12
hash (`dist/index.mjs` L12184 -> L10124) and a dapp has no parameter to override it.
Off-chain approvals survive this (the server re-hashes with the wallet's address from
the envelope and verifies raw ECDSA against the chain-read owner key - the address
selects the hash, the key is the gate). On-chain, the planned straight embed of
OpenZeppelin's `SRC9Component` would have rejected **every** native-wallet signature
forever, because the component hashes with the GateAccount's own address. Caught in
the JS phase, the fix is a scope note; caught after a week of Cairo, it would have
been a rewrite. The owner decided the path: controller-bound SNIP-9 (a
`wallet_controller` slot, owner-gated registration, verification delegated to the
registered wallet contract's `is_valid_signature`).

The same day, a second harness blind spot: the automation browser cannot install
extensions, so "wallet connects to our page" can never be proven here. Reading
Chrome's docs surfaced what no test would have seen: **the page's CSP applies to
main-world scripts**, so our strict `script-src 'self' 'nonce-...'` would have
silently blocked Argent X from injecting `window.starknet` at all - discoverable
only in the user's browser, at the worst possible moment. Fixed by allowing the
`chrome-extension:` scheme, with the reasoning recorded where the header is built.
What the harness CAN do is run the whole loop with an injected honest mock: a fake
`window.starknet` that hashes like the oracle, signs with the live testnet owner
key, and exposes its pubkey only through a chain-read endpoint. Wrong-wallet,
wrong-network and no-wallet refusals all showed live in the real UI, and one decline
went through the real server and verified against the real chain-read key as
`wallet-snip12-v1`.

Lesson: an assumption feeding a future phase is a dependency of THAT phase - prove
it when the phase starts, from the source, before writing code that assumes it. And
where the harness is blind (extensions, hardware, third-party UI), compensate twice:
read the platform's own documentation for what would silently break, and build an
honest mock that exercises every line of your side, leaving only the other side's
real behavior for the user's browser to prove.

## OBS-15 - 2026-10-25 - When you pin another library's errors, pin the shape ITS code raises

Six snforge tests failed on v0.3 with `Incorrect panic data`: we had pinned
`should_panic(expected: "GateAccount: invalid signature")` as a ByteArray, but the
actual panic arrived as
`(felt252 'GateAccount: invalid signature', felt252 'ENTRYPOINT_FAILED')`. The rule
we discovered: GateAccount's own errors are ByteArrays (`assert!(cond, "msg")` is
the house style), but errors raised INSIDE OpenZeppelin code are felt252
shortstrings - `assert_valid_signature` takes `invalid_signature_error: felt252`,
and `assert_only_self` panics with `Errors::UNAUTHORIZED: felt252`. Through a
dispatcher, both shapes arrive wrapped with a trailing `'ENTRYPOINT_FAILED'` felt.
So the same sentence ("invalid signature") has two different wire shapes depending
on WHOSE code raises it. The rule is now documented in the tests/lib.cairo v0.3
section header so it never bites again.

Same session, smaller cousin: a plain (non-Map) storage field
(`wallet_controller: ContractAddress`) would not `.read()`/`.write()` until we
imported `StoragePointerReadAccess`/`StoragePointerWriteAccess` - trait names we
confirmed by reading OZ's own `account.cairo` line 19 rather than guessing
(`StorageReadAccess` was the wrong guess).

Lesson: an expected-panic string is not just a message, it is a shape produced by
whoever raises it. Before pinning an error that originates inside a dependency,
read the dependency's raise site (and how dispatchers wrap it). And when the
compiler asks for a trait, find the trait in the source of a working consumer -
do not reconstruct its name from the pattern of a sibling trait.

## OBS-16 - 2026-10-25 - A generic serializer encodes generic shapes, not your ABI

The first live `execute_from_outside_v2` attempt died in fee estimation. The RPC
error dumped the exact calldata, and there it was: `CallData.compile` had
length-prefixed EVERY nested array - each `Call` struct inside the `Span<Call>`
got an extra length the ABI does not have. `compile` is a generic
nested-JS-arrays-to-felts helper; the outside-execution wire format is its own
spec. Fix: pack the wire manually and explicitly -
`[caller, nonce, after, before, calls_len, (to, selector, cd_len, cd...)*, sig_len, r, s]` -
with a comment saying why. Second attempt: SUCCEEDED.

Lesson: convenience serializers are correct for the shapes they were designed
for and silently wrong for structs/spans your ABI defines differently. When a
transaction fails at estimation, read the error's calldata dump - the chain
shows you exactly the bytes it was handed, which is the fastest possible
wire-format oracle. If the layout matters, lay it out yourself.

## OBS-17 - 2026-10-25 - "Read it from the chain" only works where the chain has a getter

The migration tool's mandate step failed reading the OLD gate's session:
`get_session_data` returns only 4 felts (valid_until, max_calls, calls_used,
allowed_entrypoints_LEN). The entrypoint selectors themselves live in a private
map with no public getter - the count is on-chain, the names are not. The tool
had assumed the array followed the length, like a normal ABI return.

The fix kept both sources honest: the chain stays authoritative for the COUNT,
and the recorded `state.json` mandate - whose selectors were verified from three
independent sources at stage 1 (starknet.js getSelector, `sncast utils selector`,
declared Sierra class entry_points) - supplies the NAMES. Cross-checked in both
directions: each computed selector must equal its recorded value, and the number
of names must equal the on-chain count. A migration that silently retyped the
entrypoints from a note would pass every read-back and could still change the
mandate.

Lesson: an ABI's read surface is narrower than its enforced surface - a contract
can enforce rules it cannot fully report. When migrating state, map first which
fields are chain-readable and which are not; for the gaps, join a second
recorded source with mutual verification instead of trusting either alone.

## OBS-18 - 2026-10-25 - Deriving a "constant" from a rule you remember is still working from memory

Our verify step checked SNIP-9 v2 support with an interface ID we DERIVED: SRC-5
says an interface ID is the XOR of its selectors, so we XORed
`execute_from_outside_v2` with `is_valid_outside_execution_nonce` and asked the
contract. It said no - while the contract demonstrably supports SNIP-9 (the live
outside execution had just SUCCEEDED). The truth: ISRC9_V2_ID
`0x1d1144bb2138366ff28d8e9ab57456b1d332ac42196230c3a602003c89872` is a SPEC
CONSTANT frozen in the SNIP-9 text (its NOTE records that it was computed with
the Cairo v2.5.0-era `Call` struct - the selectors' inputs have since changed,
the constant has not). OZ ships it as a bare `pub const`; starknet.js hardcodes
the same value and exposes the honest probe: `Account.getSnip9Version()` ->
`OutsideExecutionVersion` ('2' = V2). Our Cairo side had imported the OZ
constant (correct from the start); only the JS tool's derivation was wrong. The
verify step now uses the library-native probe - no ID typed anywhere in the tool.

Lesson: the house rule "never hardcode constants from memory, compute them" has
a subtle failure mode: computing a constant from a RULE you remembered, with
inputs from today, when the constant was frozen yesterday. Constants defined by
a spec or a dependency must be IMPORTED from that source of truth (or probed
through the library's own API), and the two sources pinned against each other -
derivation is only valid when the spec says the value is derived live.

## OBS-19 - 2026-10-25 - In a cross-shell toolchain, the exit code is an unreliable narrator

Two PowerShell/WSL traps in one migration run. (1) PowerShell strips inner double
quotes from arguments passed to `wsl bash -c "..."`: a grep pattern like `"A\|B"`
arrived in bash as bare `A\|B` and bash tried to EXECUTE `1d1144bb` as a command.
Fix: single-quoted patterns and unquoted `grep -e pat1 -e pat2` alternation.
(2) A fully successful `migrate-v3.mjs` run - every tx SUCCEEDED, result line
printed, receipts written - still surfaced as "Exited with code 1" in the
harness, because starknet.js WARN tip-estimation lines on stderr made PowerShell
treat the stream as failed. The numbers we cared about were all correct. A third
cousin appeared while WRITING this very observation: a here-string passed
through `powershell -Command "..."` got its inner quotes re-parsed by the OUTER
shell and the append exploded mid-sentence - the edit tool, with no shell in the
path, was the fix.

Lesson: when a tool must be trusted across shell boundaries, design its output
for it: one authoritative machine-readable result line (MIGRATE_RESULT ...),
receipts written to a recorded JSON file, and a verification step that re-reads
everything from the chain. Then no exit code, quote-eating layer, or cosmetic
stderr line can change what the record says. Judge the run by its receipts, and
make the receipts impossible to fake - read back from the source of truth. And
when a file edit itself must cross shells, prefer an editor over a command.

## OBS-20 - 2026-10-26 - A BigInt that crosses a boundary becomes someone else's crash

Phase 5's server relay verified the SNIP-9 digest with
`verifyOwnerSignature(getMessageHash(...), ...)` and every submission failed
with HTTP 400 `"expected Uint8Array, got type=bigint"` - an error named after
@scure's internals, two layers away from the actual mistake: `getMessageHash`
(web/typed-data.js) returns a raw BigInt, while the verifier takes hex strings
and `JSON.stringify` (the submission record) cannot hold a BigInt at all. The
same property already existed one function over - `signTypedData`'s digest is a
BigInt too, and migrate-v3.mjs had wrapped it in `hex()` back on day one
without the reason being written down anywhere. The fix was one line
(`hexBig(getMessageHash(...))`) plus a comment saying WHY; the lesson is the
boundary rule.

Lesson: when a module mixes return types across sibling functions (hex strings
here, BigInts there), every new caller re-rolls the dice, and the crash surfaces
in whichever consumer is least forgiving - a crypto library's type check, a
serializer - not at the source. Normalize at the boundary: either the module
returns one type, or the function's doc comment states the type loudly. A grep
for the other call sites of the same helper ("who else consumes this digest?")
turns a mysterious 400 into a one-line fix, and finding that an older caller
had already solved it silently is the tell that the knowledge existed but was
never recorded.

## OBS-21 - 2026-10-26 - A live test that pins one contract's history breaks on the next contract

After the v0.3 migration, the full JS suite went red on
`live-alignment.test.mjs`: `assert.ok(policy.callsUsed >= 1, 'chain says no call
was ever counted?')`. The assertion was TRUE for months - on the OLD gate, whose
stage-2 demo had run one session call. The v0.3 gate is a fresh
`deploy_account`: its `calls_used` legitimately reads 0 until the first session
call lands, and the phase-4 outside-execution proof was owner-level and
deliberately does not touch the session counter. The test had silently encoded
one contract instance's accumulated history as if it were a system invariant.

The honest fix: remove the floor, KEEP the coherence checks
(`callsUsed <= maxCalls`, `spentInWindow <= maxPerWindow` - invariants of any
instance), and write down in the test itself why the floor was wrong and when
it was removed. Not a silent deletion.

Lesson: a live-state test may pin (a) INVARIANTS that hold for any correct
instance, (b) RECORDED EVENTS replayed against live policy (the three stage-2
verdicts - still fine, they are history the engine must keep predicting), and
(c) nothing else. Accumulated counters of a specific address are category (c):
they are that instance's biography, and every legitimate redeploy starts a new
biography. When state.json repoints at a new contract, grep the live tests for
threshold assertions on counters - the migration checklist should include it,
because the failure lands later, in an unrelated full-suite run, looking like a
regression rather than a stale pin.

Postscript, same day, same pattern in a different file: `tools/check-style.mjs`
(the one-shot Hallmark slop-fix verifier) pinned "exactly 12 readouts in
app.js" - a fingerprint of the console as it stood on 2026-10-25. Phases 2-5
legitimately grew it to 17, and the gate sat silently red until someone ran it.
Fixed the same way: the durable invariant is a FLOOR (the pattern may spread,
never revert), with a comment saying why. One-shot verifiers need an expiry
note the day they are written: a fingerprint check that outlives its moment
becomes a lie that fails.

Postscript 2 (2026-10-26, same category, third file): `scripts/demo-layer-d.mjs`
hardcoded the pre-migration token address. The spending gate denies a token
mismatch as `no-policy` (`src/gates/spending.mjs`), so the first re-run after
the v0.3 migration would have failed the demo's OWN sandbox checks while
describing a token the live mandate no longer names. Fixed the honest way:
TOKEN and MERCHANT are now read from the same `state.json` the mandate reader
uses, and the re-run passed 18/18 on the new gate's token. The migration-day
grep missed it because it scanned live TESTS, not demo/tool SCRIPTS - the
checklist item should read: grep live tests AND scripts for addresses and
thresholds whenever state.json repoints.

## OBS-22 - 2026-10-26 - Display typography leaked into the signature carrier

The first harness-browser run of the newly wired wallet path died before any
chain action with: "Refused. typed data: string is not ASCII: 'Approve once: 40
to 0x079e…cf38.'" The resolution NOTE - the plain-language line the wallet
shows the owner - is built with the UI's own `shortAddress()`, which abbreviates
with '…' (U+2026). The SNIP-12 `string` encoder packs text into felts and
refuses non-ASCII, correctly and loudly. So the display layer's typography had
quietly become part of the signing contract, and EVERY wallet-signed resolution
was dead on arrival. Two hundred thirty-seven tests never saw it: every fixture
hand-built ASCII notes, and the server-side live proof signs raw digests
(`proposals.mjs`) with no note carrier at all. Only a real run of the real path,
with a note built the way the UI builds it, could surface it - the second
confirmation that the live run is a witness no fixture can replace (OBS-13).

The fix honored four rules. (1) One choke point: the fold lives in
`mandateActionTypedData`, the single entry every signer goes through - not in
each note builder, and not in `short()` (display stays beautiful). (2) Fold
only look-alikes ('…'→'...', em/en dashes, smart quotes, NBSP): characters with
no ASCII equivalent (emoji, accents) are NOT laundered - they still hit the
loud refusal, pinned by a control in that exact direction. (3) The fix must not
move policy: the canonical resolution digest is note-independent, proven by the
preview digest being byte-identical before and after. (4) Both sides agree
because the server re-hashes the CARRIED typed data and never rebuilds the
note - checked BEFORE editing, not assumed.

Lesson: a string that serves two masters - human display and machine carrier -
must satisfy the carrier's alphabet at the boundary where it crosses. Put the
normalization at the carrier's single entry point, keep the carrier's refusal
loud for everything un-foldable, and pin both directions with controls. And
when a brand-new path gets its first live run, expect the first failure to be a
boundary bug no fixture-based test could have seen: that is the run doing its
job, not a reason to doubt the wiring.

Postscript, same run, harness-side: `browser.navigate` to the SAME URL is a
hash-only navigation - the document does not reload and the module map stays
stale. The fixed `typed-data.js` was on disk, the tests were green, and the page
still threw the identical pre-fix error until a real `reload` ran. After any
fix that must reach an already-open page, prove the module version FROM INSIDE
THE PAGE (here: `typeof foldNoteAscii === 'function'` as a version probe) before
trusting a repeated failure. Also: the harness browser's screenshots need a
physically visible window, which it does not have - that witness was recorded
as blind, and the proof leaned on the four that could not lie to each other
(page DOM, network log, server records, chain).

## OBS-23 - 2026-10-26 - Panic tuples accumulate one wrapper per failed hop; pin them observed, never copied

Phase 6's negative control (t38: an owner-signed invoke carrying a STRANGER's
accept-ownership signature must be refused) was written with the tuple its
siblings use: `('Account: invalid signature', 'ENTRYPOINT_FAILED')` - the shape
t25 pins for a wrong-key outside execution. snforge failed with "Incorrect
panic data": the actual tuple carried the same message plus TWO
`'ENTRYPOINT_FAILED'` felts. The reason is call depth. t25 calls
`execute_from_outside_v2` directly through a dispatcher: one failed entrypoint,
one wrapper. t38 goes through `owner_execute`: the inner self-call executing
`set_public_key` fails inside OZ code (wrapper #1), and the dispatcher's call
into `__execute__` fails because of it (wrapper #2). Panic data accumulates one
`ENTRYPOINT_FAILED` per failed entrypoint hop, and `should_panic(expected:)`
matches the tuple EXACTLY - not as a prefix, not as a containment.

Lesson: a refusal's panic tuple is a property of the CALL PATH, not of the
error message - derive it from how many entrypoint hops fail, not from a
sibling test that rejects the same words at a different depth. And when in
doubt, run the test once, read snforge's own "Actual:" line verbatim, and pin
that: the failure output is the artifact. Copying a tuple from a differently-
shaped call is the same from-memory mistake the house rules forbid for hashes
(OBS-18's family) - the fix here was a two-token edit, but only AFTER the
runner had said the true shape out loud.

## OBS-24 - 2026-10-26 - "The wallet" is an account contract, not a brand; probe its getters and signature shape from the chain

Phase 6's dry probes used the OZ mock wallet: `get_public_key`, 2-felt `[r, s]`
signatures. The user's real Ready X wallet (`0x0022239D...`) is a different
generation entirely: **ArgentAccount v0.4.0** (class `0x360783...`, `getVersion`
-> "0.4.0"). It has NO `get_public_key` entry point — the owner is `get_owner`
(+ `get_owner_type`, `0` = `SignerType::Starknet`) — and `is_valid_signature`
takes the serialized **SignerSignature** `[signer_type, pubkey, r, s]`, four
felts. Observed verbatim: 2 felts revert `argent/invalid-signature-length`; 3
felts revert `argent/invalid-signature-format`; 4 felts with a wrong signature
return `0x0`. The account checks its STORED owner, not the pubkey carried in the
array: a VALID signature by the deployer key (not an account signer) returned 0
with either the deployer's or the owner's pubkey in the array.

Lesson: a handover (or any delegation) that trusts a getter name or a signature
length copied from a mock is one real wallet away from failing — or worse, from
a probe that reverts and gets misread as "refused". Read the account's own
ABI/getters on-chain, pin the observed shapes, and make the negative control a
CRYPTOGRAPHICALLY VALID stranger signature: garbage proves nothing if the
account refuses it for being malformed. Also observed: the wallet had a guardian
configured (`get_guardian` -> `0x7d2f7457...`, `get_guardian_type` ->
`Some(Starknet)`) even though the checklist asked for none; the handover itself
is pure ECDSA on the gate, so the guardian is irrelevant to it, but the
owner-key honesty probe is exactly what protects the later SNIP-9 delegation.
The tool now resolves `get_public_key` OR `get_owner`+`get_owner_type`, builds
probes in the account's format, records getter/type/format in the prep, and
refuses non-Stark owner types.

And an open flag for the demo: the console's `normalizeWalletSignature`
currently accepts 2-value shapes and loudly refuses longer arrays. What Ready X's
`signMessage` actually returns (2 or 4 felts) must be OBSERVED at the connect
step before the step-10 wallet-signed SNIP-9 run — the on-chain format is 4
felts, so this is a real adaptation risk, not a hypothetical.

### Postscript (same day): the guardian changes everything — concise vs standard format resolved from source

The first `--prepare` failed the honesty probe: the owner's own valid signature
over `DUMMY_HASH` returned `0x0`, not `VALID`. Fetching the **`account-0.4.0`**
tag of `argentlabs/argent-contracts-starknet` (`src/presets/argent_account.cairo`,
`docs/argent_account.md`) resolved it exactly:

`parse_signature_array` branches on length:
* **2 or 4 felts → CONCISE (legacy) format.** 2 felts = `[owner_r, owner_s]`
  (owner pubkey taken from storage). 4 felts =
  `[owner_r, owner_s, guardian_r, guardian_s]` (both pubkeys from storage).
* **anything else → STANDARD format**: `Array<SignerSignature>` serialized as
  `[count, signer_type, pubkey, r, s, ...]`. One Starknet signer = 5 felts
  (`count=1` + 4). The span must be fully consumed or it reverts
  `argent/invalid-signature-length`.

Then `is_valid_span_signature` asserts:
* `has_guardian()` → **exactly 2** `SignerSignature`s.
* no guardian → exactly 1.

The user's wallet **has a guardian** (`get_guardian` -> `0x7d2f7457...`). That
single fact explains every observed revert/zero:
* 2-felt concise → parses to 1 signature → guardian present → `invalid-signature-length`.
* 3 felts → neither 2/4 nor a valid standard array → `invalid-signature-format`.
* 4-felt `[0x0, OWNER_PUB, r, s]` → parsed as CONCISE owner+guardian:
  owner_r=`0x0`, owner_s=`OWNER_PUB`, guardian_r=`r`, guardian_s=`s` → invalid → `0x0`.
  (The earlier reading "4 felts = `[signer_type, pubkey, r, s]`" was wrong for
  this account; it was concise-format misinterpretation.)
* 5-felt standard `[count=1, type=0, pubkey, r, s]` → 1 signature → guardian
  present → `invalid-signature-length`.
* A valid owner-only signature can NEVER return `VALID` on this account without
  the guardian's signature too.

**Consequence:** the owner-only honesty probe is cryptographically impossible on
a guardian-protected account. The handover itself is unaffected — the gate's
`set_public_key` verifies the accept-ownership signature with raw ECDSA
(`is_valid_stark_signature`), never through the wallet's `is_valid_signature`.
`handover.mjs` now:
* probes with the CONCISE `[r, s]` format (correct for OZ and Argent-no-guardian);
* detects `has_guardian` and **SKIPS the probe loudly** when set, recording
  `honestyProbe.skipped` + reason in the prep file and printing `SKIP` lines in
  `--verify` (never a silent pass);
* still hard-checks the exported key against `get_owner` before signing.

**Step-10 implication (recorded, not assumed):** the gate's SNIP-9 delegation
calls the wallet's `is_valid_signature`. With a guardian set, Ready X's
`signMessage` must produce a combined owner+guardian signature (concise 4-felt
or standard 9-felt). The console's `normalizeWalletSignature` — which currently
accepts 2-value shapes and refuses longer arrays — must be adapted to the
ACTUAL observed output at connect time. This is now a known blocker for the
wallet-signed outside path, not a hypothetical.

## OBS-25 - 2026-10-26 - Step-10 adaptation: the console now speaks Ready X's actual signature dialect

The step-10 blocker from OBS-24 is resolved in code, pending live browser
observation. Three changes, all tested (**254/254 JS pass, 0 skipped**; style
gate PASS):

1. **`web/wallet.js normalizeWalletSignature`** rewritten from source
   (`account-0.4.0` tag, `parse_signature_array` + `docs/argent_account.md`):
   * object `{r,s}` → `format: 'object'`
   * 2-felt array → concise owner-only → `'concise-owner'`
   * 4-felt array → concise owner+guardian → `'concise-owner-guardian'`
     (owner r/s are always the FIRST two felts)
   * ≥5-felt array → standard `Array<SignerSignature>`: `[count, (type, pubkey,
     r, s) × count]`; count/length mismatch or non-Starknet first signer type
     is refused loudly, never guessed → `'standard'`
   * returns `{ r, s, signature (FULL array), format }`; only r/s are
     curve-order checked (count/type/pubkey use a loose felt converter —
     a pubkey can legitimately be ≥ curve order).
   * envelopes (`signMandateAction`, `authorizeCalls`) now carry `signature` +
     `signatureFormat` alongside r/s.

2. **`web/server.mjs`**:
   * `resolveControllerPublicKey` (exported, unit-tested): tries recorded
     `get_public_key`, falls back to `get_owner_type`+`get_owner`, refuses
     non-Starknet owner types. Default `readControllerPublicKey` uses it.
   * `verifyOutsideAuthorization` parses `auth.signature` (defaults to
     `[auth.r, auth.s]` when absent — backward compatible), verifies the
     envelope's r/s MATCH the owner component of its own array (mismatch =
     409, never relayed), and packs the wire with the FULL signature array
     (`hexBig(sig.length), ...sig`) instead of the hardcoded `'0x2', r, s`.
     The gate calls the controller's `is_valid_signature` with exactly what
     the wallet produced — concise or standard, guardian or not.

3. **Live test updated** (`proposals.test.mjs`): the post-handover chain owner
   is the Ready X wallet key; the test now pins livePub against
   `state.json phase6_handover.real_wallet_probe.ownerPublicKey` (never a
   hardcoded literal) and proves BOTH the old pasted key AND the agent key are
   refused. The positive wallet-signed path can only run in the browser (the
   wallet private key was deleted by design) — recorded, not papered over.

**Still to OBSERVE (not assume):** what Ready X's `signMessage` ACTUALLY
returns at connect (concise 2/4-felt or standard 5/9-felt). The normalizer
accepts all documented shapes and records which one arrived; the first real
browser connect pins it. If Ready X returns a shape outside these four, the
normalizer refuses loudly — it never half-checks.

## OBS-26 - 2026-10-26 - Track 3: witness rotation is now owner-signed history — and building it flushed out a latent wallet-context bug

Track 3 (witness-key rotation, `track3-witness-rotation.md`) is code-complete:
**284/284 JS pass, 0 skipped** (was 266; +17 integration, +1 digest drift
cross-check), style gate PASS. An honest key rotation is no longer a red flag:
the owner signs attestations ("this key speaks for this app from this moment,
replacing that one"), every record is checked against the attestation that was
in effect WHEN IT WAS MADE, a rotated-out key cannot sign new records, and a
key no attestation names is refused by name. Three findings worth keeping:

1. **The latent bug (the reason to build features, not just tests around
   them).** Wiring the wallet path to attestations exposed that
   `createLadderStore`/`currentStage` verified ladder signatures WITHOUT the
   typed-data context — so a wallet-signed (`snip12-v1`) promotion was refused
   by the store even though the endpoint had just verified it. Post-handover
   the wallet is the ONLY way the owner can sign, so every live promotion was
   quietly broken. No existing test could catch it: each layer was correct
   against its own assumptions; the bug lived in the seam. Fixed additively
   (optional `context` param, threaded like the attestation store's) and pinned
   by the last test in `witness-rotation.test.mjs` — the same envelope refused
   without context, accepted with it, at store, `currentStage` AND endpoint
   level. Lesson: when a new feature reuses an old path with a new signature
   transport, test the WHOLE path end to end, not just the new part.

2. **A refusal can be the entrance to a repair.** `evidence-witness-mismatch`
   (a record no attestation covers) is exactly the state an attestation fixes.
   The witness endpoints therefore load the trust view in a tolerate mode that
   returns the refusal ALONGSIDE the full verified view — while identity,
   evidence, ladder and broken-chain refusals stay hard stops, and the résumé
   and ladder endpoints stay strict. Tested: from inside the refused state, an
   owner-signed attestation with an explicit `validFrom` re-covers the records
   and turns the résumé green. Known gap, recorded not hidden: the résumé UI
   shows a full-screen error in that state, so the repair is API-only until a
   Track-4 affordance exists.

3. **The check caught the test author.** The first draft of the honest-rotation
   test backdated the handover behind a record the old key had already signed
   — two keys "in effect" at the same moment. The coverage rule refused it.
   The implementation was right; the test's timeline was dishonest. A control
   that catches its own author's sloppy timeline is a control worth keeping.

Still to OBSERVE (browser list, unchanged + 1): the live owner-signed
attestation through the résumé's new witness card, alongside the step-10 run
and the first real `signMessage` shape.

## OBS-27 - 2026-10-26 - The first real wallet connect was refused, and the refusal was undiagnosable — until it flushed out latent bug #2 (the BigInt wire seam)

The owner's first live "Connect Ready X" in the browser was refused with "the
chain would not return this wallet's key (neither get_public_key nor
get_owner on 0x22239d00…b1fcfb)". Three findings, in the order they matter:

1. **The chain was never the problem — proven, not assumed.** A direct probe
   (same plain-RPC helper the server uses, Cartridge Sepolia) answered for the
   exact wallet account: `get_public_key` → honest RPC error 21 (entrypoint
   does not exist on ArgentAccount v0.4.0, as OBS-24 recorded),
   `get_owner_type` → `0x0` (Starknet signer), `get_owner` →
   `0x4fb24b55…e7d2` — **byte-identical to the owner key recorded at the
   phase-6 handover**. So the refusal came from the WALLET'S OWN PROVIDER
   failing the same calls in the browser, while the wallet simultaneously
   reported the correct chain ID (the SN_SEPOLIA check runs BEFORE the key
   read and passed). The console's message swallowed both underlying errors,
   making a wallet-side RPC problem look like a chain problem. Fixed: the
   refusal now appends both provider errors verbatim plus a hint about
   querying a network where the account does not exist. The pinned phrase
   (`/would not return this wallet's key/`) is unchanged, so the existing
   refusal test still holds. Lesson: a refusal that cannot say WHY is a
   refusal that will be misdiagnosed — surface the underlying error at the
   point of refusal, not in a server log nobody reads.

2. **Latent bug #2: the JSON-RPC BigInt seam.** Writing the probe exposed a
   second seam bug of exactly the kind OBS-26 warned about (correct layers,
   broken seam): `selectorFromName` (web/tx-signer.js) returns a BigInt;
   `mandate-reader.mjs call()` JSON-stringifies its arguments; and
   `server.mjs` wires `selectorFromName` as the fallback `selectorFn` into
   `resolveControllerPublicKey`. So the server's `get_owner_type`/`get_owner`
   path — the ONLY key path on a real Ready X controller — died with
   "Do not know how to serialize a BigInt". Every unit test missed it because
   their fake call functions never serialize. Fixed at BOTH ends and pinned:
   `call()` now normalises every felt position (contract, selector, calldata)
   to minimal lowercase hex — anything that is not a felt throws loudly
   instead of becoming a silent `null` on the wire — and
   `resolveControllerPublicKey` hands its injected callFn wire-format hex
   selectors. Pins: new `tests/mandate-reader.test.mjs` (3 tests: BigInt on
   the wire as hex, mixed-case/decimal canonicalisation, loud non-felt
   refusal) and the two `outside.test.mjs` fallback tests now use JSON-STRICT
   fakes that fail on anything the real wire could not carry. Proven live:
   the probe re-run with RAW BigInt selectors resolves the controller key
   end to end. Suite now **287/287, 0 skipped**; style gate PASS. Lesson:
   when a test injects a fake for a serialization boundary, the fake must
   serialize — otherwise the boundary's contract is untested by construction.

3. **OBS-25 evidence, corrected from the chain.** `get_guardian` on the
   wallet account now returns `0x0` — the guardian is REMOVED. The
   `real_wallet_probe` block in state.json still records `hasGuardian: true`
   from its probe moment; that record is stale, not wrong (different moments),
   but the signatureFormat question is now sharper: with no guardian, Ready X
   `signMessage` should yield the plain owner signature shape. The first live
   connect that gets past the key read will record the actual format.

Console server restarted on the fixed code: pid 8196, port 4173 (verified
`GET /` 200, `/api/witness/preview` 409, `/api/resume` 200 with the
documented `identity-unverified`). Still to OBSERVE (browser list,
unchanged): the live connect retry with the now-diagnosable refusal, the
step-10 run, and the first real `signMessage` shape.

## OBS-28 - 2026-10-26 - The wallet's injected provider cannot fetch from the page's origin — so the console grew its own chain read (reader 2)

The diagnosable refusal from OBS-27 did its job on the very next attempt:
both getter calls through the wallet's provider reported **"Failed to
fetch"** — the browser's transport-layer TypeError, not a chain answer. The
wallet's own UI read the chain fine at the same moment (balances on screen),
which pins the cause: an injected wallet object is extension code running at
the PAGE's origin, so its RPC fetches carry the page's origin (here
`http://127.0.0.1:4173`) and can be blocked or unroutable (CORS, or an
extension-internal proxy) even while the wallet app itself reaches its node.
"The chain would not return this wallet's key" was never about the chain, and
never about the wallet's network — the broken leg was the page-origin fetch.

The fix keeps the principle (the key comes from THE CHAIN, never from the
extension's word) and removes the dependency on a transport we do not
control. Connect now has TWO independent readers, in order:

1. the wallet's own provider, exactly as before; then
2. the console's server-side chain read, new endpoint
   `GET /api/chain/key?address=…` — the same injected, testable chain-read
   seam the relay uses (OBS-08), CORS-free because it is server-to-node. It
   returns `{ ok, key, getter }`, naming WHICH getter answered
   (`get_public_key` or `get_owner`), because the signature shape the browser
   expects (`oz-raw` vs `argent-signer-v1`) depends on it.

The fallback fires ONLY on transport failures (errors tagged `transport`);
semantic answers — owner type not a felt, owner type not a Starknet key,
empty key — do NOT fall through, because they are the chain's answer and
both readers would report the same one. Falling back there would blur a real
refusal into a retry.

Why the security story is unchanged: the extension is trusted for exactly
one thing, the address — as it always was, unavoidably — and every signature
is still verified against the chain-read key FOR THAT ADDRESS, so a wallet
lying about its address fails verification exactly as before. The chain-ID
gate runs before any key read. And `info.keySource` records which reader
answered (`wallet-provider` or `console-chain`): recorded, never hidden, so
the owner can always see whose eyes read the chain.

Proofs: live endpoint on the real wallet account returns the recorded owner
key via `get_owner` (200), a non-felt address 400, a silent chain 502, an
empty key 502. New pins: 4 wallet tests (transport fallback succeeds and
names the console getter; a wallet with no provider object at all connects
via reader 2; a semantic refusal never consults reader 2; the default reader
2 hits `/api/chain/key?address=…`) and 3 server tests (getter naming on both
paths, refusals). Suite **294/294, 0 skipped**; style gate PASS. Server
restarted: pid 9460, port 4173.

Lesson: an injected wallet object's network reachability is the PAGE's
reachability, not the wallet app's. Never make a security-critical read
depend on a transport you do not control — carry your own, and say which one
answered.

## OBS-29 - 2026-10-26 - The first live owner signature: Ready X's real signature dialect, observed and receipted

The owner connected (OBS-28) and signed the first live decision: proposal
`08fb9bafe43551ae` (files:share `quarterly-report.pdf`, ASK_USER) declined at
21:22 local, 2026-10-26. The preview showed DIGEST MATCH before anything was
signed (browser and server independently computed
`0x02878849…20c0086`); the stored envelope is the receipt:

- scheme `wallet-snip12-v1`, `signerAddress` = the wallet account
  `0x22239d00…b1fcfb`;
- raw signature **five felts**: `[0x1, 0x0, 0x4fb24b55…e7d2, r, s]` — the
  STANDARD SNIP-9 wrapper declaring one signer of Starknet type, then that
  signer's public key, then the two signature halves. Recorded as
  `signatureFormat: "standard"`;
- the public key carried INSIDE the signature equals the key the console read
  FROM THE CHAIN for that address (`VERIFIED AGAINST … CHAIN KEY` on screen) —
  the signature vouches for the same key the chain names, so a wallet lying
  about its address or its key fails here;
- typed data: domain "Demi Mandate" v1, `SN_SEPOLIA`, revision 1, primaryType
  `MandateAction { kind, digest, note }` — the generic carrier, signed as a
  `resolution` with the plain-language note "Decline this request. The block
  stands; nothing goes on-chain."

This CLOSES the open flag from OBS-25: the actual `signMessage` shape is
neither of the two guessed shapes (concise 4-felt guardian, or 9-felt
two-signer standard) — with the guardian removed (`get_guardian` → `0x0`,
OBS-27) Ready X returns the standard wrapper with ONE signer. It is exactly
the `standard-1` shape `tests/wallet.test.mjs` had pinned before any live
wallet existed, so the verifier already spoke the dialect before the wallet
first spoke it. Consequence for the docs: "concise or standard" stays
supported (other wallets, other moments), but the observed default for this
account is standard-count-1.

Still to OBSERVE (browser list, shortened): the live step-10 pass on the
remaining pending proposal `29dec48f87b015de` (over-cap ask → amend →
wallet-signed SNIP-9 relay → receipt → nonce burned), the wrong-wallet
refusal, the live owner-signed witness attestation through the résumé's
witness card, and a wallet-signed ladder promotion once the résumé UI can
reach it. Announced, never silently skipped.

## OBS-30 - 2026-10-26 - The console's own security header was the wall: CSP `connect-src 'self'` blocked the wallet's in-page fetches — one root cause for BOTH live failures

The step-10 relay reached the wallet popup and died there: Ready X showed
"Tx not executed: Argent multicall failed" with Sign greyed out. Before
touching anything, the two server-side suspects were probed against the live
chain and CLEARED with receipts:

- `is_valid_signature` on the real controller answered `0x56414c4944`
  ("VALID") for BOTH tonight's five-felt standard wrapper AND its inner
  `[r, s]` — whatever shape the relay carries, the chain accepts it;
- the gas-only relayer holds 46.6 STRK — funding was never the problem.

The owner then opened the browser console, and the actual culprit was
already printed there in red: fetches from `inpage.js` (the wallet's
injected code) to its own RPC node
`https://rpc.starknet-sepolia.lava.build` were "blocked by the Content
Security Policy directive: connect-src 'self'" — a header THIS console
serves. One root cause explained both mysteries of the night:

1. the connect-time "Failed to fetch" on every getter call (OBS-27/28), and
2. Ready X's signing simulation failing ("Argent multicall failed"): the
   simulation replays the authorized calls by fetching the node from the
   page, and the page's CSP strangled those fetches too.

The mechanism was half-known already: the comment above `script-src` in
`web/server.mjs` records that Chrome applies the PAGE's CSP to a wallet
extension's main-world injected script — which is why `script-src` allows
`chrome-extension:`. The same fact applies to the wallet's FETCHES, and
`connect-src 'self'` said "this page may talk only to itself." The wallet's
messenger was stopped by our own bouncer. OBS-28's reader 2 (server-side
chain read) was the right call regardless — the key must not depend on a
transport we do not control — but it could never fix the SIGNING popup:
only the wallet itself can produce a signature, and its simulation needs
its node.

The fix, both layers:

- `web/server.mjs`: a BOUNDED allowlist —
  `connect-src 'self' https://rpc.starknet-sepolia.lava.build
  https://api.cartridge.gg` — never a bare `https:`. The page must not gain
  the ability to phone home anywhere else; widening the list is a
  deliberate, reviewed act, now pinned EXACTLY by a test.
- `web/wallet.js`: when both readers fail and the provider's reported text
  matches `/Content Security Policy/i`, the refusal appends a NOTE naming
  THIS console's connect-src allowlist as the blocked leg — so the next
  occurrence is diagnosed in one read instead of a night of probes.

Pins: server test asserts the served `connect-src` directive equals the
allowlist byte-for-byte; wallet tests assert a CSP-worded provider failure +
failing console read yields the NOTE (naming `web/server.mjs`), and a plain
transport failure does NOT claim CSP — a wrong diagnosis is worse than none.
Mock gained `providerError` so the provider can fail with exact observed
text. Suite **295/295, 0 skipped**; style gate PASS. Server restarted on the
fixed code: pid 10868, port 4173; live header verified to carry the
allowlist, `/api/health` ok.

Lesson: a security control aimed outward (CSP) also constrains the trusted
code that runs INSIDE your page — including a wallet extension's. When a
wallet works everywhere except your site, read your own response headers
before suspecting the chain; and when both readers of a truth fail, check
who is standing between them.

## OBS-31 - 2026-10-27 - Ready X's simulation is a MODEL, not the chain: it replays authorized calls from the wallet, so a controller-bound self-call can never pass a relay — the wallet now carries its own transaction

With the CSP allowlist live (OBS-30), the signing simulation finally reached
its node — and returned the REAL reason for "Argent multicall failed",
copied verbatim from the wallet's own error text:

    ('argent/multicall-failed', 0x0, 'Account: unauthorized', 'ENTRYPOINT_FAILED')
    in the called contract 0x0022239d…b1fcfb (the WALLET), selector __execute__

Decoded: Ready X replays the authorized CALLS as the wallet's own multicall.
Our authorized call is `set_spending_policy` — a SELF-call: the gate raising
its own cap, which by design answers every caller but the gate with
`assert_only_self`'s panic. And that panic pair, `('Account: unauthorized',
'ENTRYPOINT_FAILED')`, is byte-identical to what our own snforge suite pins
for an outsider touching a self-only entrypoint (tests/lib.cairo, two
`should_panic` pins). The wallet's simulation was telling us, in our own
contract's dialect: "I tried this call from me, and the gate said no." A
false negative baked into the wallet's model — every on-chain assert of the
REAL path (relayer → gate.execute_from_outside_v2 → gate executes as itself)
had already been probed VALID: caller ANY_CALLER, open window, fresh nonce,
`is_valid_signature` VALID for both signature shapes, relayer funded.

Two more refusals observed and understood the same night, both loud by
design: "Refused. Timeout" = the wallet's signing request expiring on an
earlier attempt; "Refused. An error occurred (USER_REFUSED_OP)" = the owner
pressing Reject. And the console log showed the wallet's in-page code also
trying `https://starknet-sepolia.public.blastapi.io`, which the allowlist
blocks — left OUT deliberately: state.json records that host answering 403
server-side, so allowing it would add surface and no reach. If a future
wallet build needs it, the log names it and the pin changes deliberately.

Feasibility probe for the design answer: the owner wallet holds 54.88 STRK
(read from the chain, token address from state.json) — it can pay its own
gas. So the relay's role disappears for this flow, and with it the
simulation mismatch:

- `POST /api/outside/wire` — the SAME guard and the SAME four controls as the
  relay (signer == chain-named controller; message fields vs this chain, the
  live-mandate calls, the recorded selectors, the open window; nonce unused;
  signature vs the chain-read controller key) — then hands the flat wire
  call back UNRELAYED.
- The wallet sends `execute_from_outside_v2` as its OWN transaction
  (`signer.executeCalls`, popup 2). Its simulation now models reality
  exactly: caller ANY_CALLER, its own signature on the authorization, open
  window, fresh nonce — and the gate executing the self-call as itself.
- `POST /api/outside/record` — writes the record from THE CHAIN's copy of
  that transaction: parsed calldata must be exactly one call, to this gate,
  to the state-recorded `execute_from_outside_v2` selector, ANY_CALLER, and
  inner calls field-equal to what the LIVE mandate produces right now. Then
  BROADCAST once, and completion through the SAME helper the relay's receipt
  poll uses (`completeSubmissionFromReceipt`, extracted this change): final
  status and the nonce burn are read back, never assumed. A retry for an
  already-recorded tx completes the existing record instead of stacking a
  second; recording one tx against two proposals is refused.

The relay path stays, unchanged and fully tested — SNIP-9 allows any
submitter, and the server remains one that refuses to carry unverifiable
bytes. What changed is who submits when a wallet is connected: the owner's
own wallet, which is also the better story — no third party touches the
final hop at all.

Pins: five outside tests (wire unrelayed + record writes chain facts only;
record refuses a non-gate/non-single/unknown tx; record refuses inner calls
that are not the live mandate's; a REVERTED wallet tx is recorded REVERTED
with its reason and no nonce-consumption claim; double record completes one
record) and two wallet tests (executeCalls passes the call list verbatim and
returns the hash; a wallet that cannot send, sends no hash, or lacks
`execute` is refused loudly). Suite **302/302, 0 skipped**; style gate PASS.
Server restarted on the new code: pid 1396, port 4173; `/api/outside/wire`
refuses an empty body 400 live.

Lesson: a wallet's signing simulation is a model of execution, not
execution. When the model cannot represent your design, do not weaken the
design to please the model — change WHO submits until model and reality
agree, and keep every control where the chain can still check it. And when
the chain speaks in felt-strings, your own pinned panic tuples are the best
decoder ring you will ever get.

## OBS-32 - 2026-10-27 - The rehearsal happens at SIGNING time (popup 1), not at sending time: with Ready X as controller, the v0.3 gate is admin-frozen through SNIP-9 — and the owner key is the door that is still open

OBS-31's redesign was aimed at the wrong popup. The owner's screenshot of the
retry settles it: the red banner — "Tx not executed: Argent multicall
failed", Sign greyed out — sits on popup 1, the *signMessage* request ("Data
to be signed"), before any submitter exists. Ready X rehearses an
OutsideExecution message's `Calls` from the wallet AT SIGNING TIME, no matter
who would later carry it (wallet itself, our relayer, anyone). So making the
wallet the submitter changed popup 2, which was never the blocker. The
mechanism OBS-31 built stays — correct, tested, and the record path still
uses it — but it cannot, on its own, get a self-call authorization signed.

**The freeze conclusion.** Every meaningful call on the v0.3 gate is
self-only: `set_spending_policy`, `set_wallet_controller`, `upgrade`,
`add_or_update_session_key` — all `assert_only_self` (src/lib.cairo L345,
L355, L531 and friends). The rehearsal always tries them FROM THE WALLET,
which always answers `('Account: unauthorized', 'ENTRYPOINT_FAILED')` — the
exact tuple our snforge suite pins for outsiders (tests/lib.cairo L1046,
L1087). Therefore NO SNIP-9 message with real content can be signed by Ready
X on this gate. Verified dead ends, each from a primary source, not guessed:

- No user-facing "skip simulation" setting (two web searches; Argent markets
  the simulation as its fraud-protection headline, not an option).
- starknet.js `WalletAccount` (installed 10.8.0, dist L12660, read line by
  line) forwards `wallet_addInvokeTransaction` — the sender is ALWAYS the
  wallet's own account; it cannot sign an invoke for the gate.
- Nested SNIP-9 is circular: an outer message whose call is
  `gate.execute_from_outside_v2(inner)` needs the inner signed by the
  controller, and signing the inner rehearses the inner calls — the same
  wall, one level down. The recursion has no signable base case.
- The upgrade escape is circular for the same reason: `upgrade` is itself
  `assert_only_self`, so a SNIP-9 message carrying it fails its own rehearsal.
- Another wallet cannot be made controller: `set_wallet_controller` is
  self-only — frozen by the same wall.

**The door that is still open (no contract change).** The gate's owner key
IS the wallet's key (`0x4fb24b55…7d2` — the connect check proves the match on
every connection). The gate's `__validate__` owner branch (src/lib.cairo
L297-300) is standard OZ ECDSA `[r, s]` over the invoke transaction hash —
it does not care WHO produced the signature or WHO submits the transaction.
And the console's phase-4 pasted-key machinery is alive and tested end to
end: `/api/tx/plan` builds the final transaction (sender = gate), the tab
signs it (`signers.js signInvoke`), the server only carries the signed bytes
(`/api/broadcast`), completion only from a receipt. The gate holds
**1.66 STRK** (probed from the chain this morning) — it can pay its own gas.
Argent X has always exposed Settings → Export private key, and Ready X is a
rebranded Argent X (wallet.js header records the v0.4.0 ArgentAccount
shape). So if the owner exports the key and pastes it — one deliberate act,
the tab forgets it the moment it has signed (pinned behavior), the server
never sees it — step 10 runs TONIGHT on the existing gate: an owner-signed
invoke `gate.__execute__([gate.set_spending_policy(token, 100, …)])`, the
native owner path the contract was built with. The same path can later call
`upgrade()`, which unfreezes everything else.

**The design fix that follows (v0.4, not tonight):** admin entrypoints gain
a controller-or-self guard, so the wallet's rehearsal becomes TRUTHFUL —
"these calls, from me, with my key" passes exactly when the authorization is
genuine, and `execute_from_outside_v2` keeps working unchanged (the gate
calls itself). This does not add privilege: the contract's own doctrine
(src/lib.cairo L427-431) already says the controller IS the owner's signing
identity, and SNIP-9 already grants the controller's signature whatever the
owner may do. It only makes the guard match the wallet model instead of
fighting it.

Honest framing for the demo: the pasted-key hop is a deliberate, one-time
owner act on the owner's own key — the phase-4 posture, not a regression —
and it is recorded here because the wallet-only story resumes with v0.4.
Pending at record time: the owner's confirmation that Ready X shows the key
export.

Lesson: find out WHICH popup fails before redesigning around it — a signing
rehearsal is not a sending rehearsal, and the submitter you choose cannot fix
a refusal that happens before submission exists. And when a wallet's safety
model and your contract's guard model contradict each other, one of them
must change; prefer changing the guard so the wallet's rehearsal becomes a
truth the owner can see, and keep the owner's native key path as the door
that no model can freeze.

## OBS-33 - 2026-10-27 - Step 10 LIVE: an owner-signed invoke from the gate itself executed the amended mandate on Sepolia — verified line by line from the chain

The owner found Ready X's key export, pasted it once into the console's
pasted-key slot (the phase-4 machinery), and the tab signed the final
transaction; the server only carried the signed bytes; the chain did the
rest. Verified afterwards from the node, not from the console's word:

- tx `0x62c0bd18ca50c4fae3a1341d0fa39b8dd4315228b4d09c4a2fdf51acfa1b62b`
- receipt: `SUCCEEDED`, `ACCEPTED_ON_L2`
- sender: the GATE itself (`0x7d1d8cad…70f1`) — the owner path, `__validate__`'s
  plain OZ ECDSA branch, exactly as src/lib.cairo L297-300 specifies
- exactly one call: `set_spending_policy` (selector derived from the recorded
  name, matching the chain's call), args: session `0x100d2c…185`, token
  `0x28c46a…148`, per-call cap u256(0x64, 0) = 100, per-window u256(0x64, 0)
  = 100, window 0x278d00 = 2,592,000s
- live re-read right after: `maxPerCall 100` (was 30), `spentInWindow 0` (the
  window restarted — the side effect the console warns about), callsUsed 0/10
- the gate's nonce is now 7 — its seventh own transaction
- integrity bonus: the hash the TAB computed locally equals the hash the chain
  returned (the record's `computedHash`) — the bytes signed are the bytes
  executed
- the record: proposal `29dec48f87b015de` → SUCCEEDED

The headline flow is now fully live-proven end to end on Sepolia: over-cap
ask → engine blocks with the chain's own reason → owner amends (wallet-signed
decision, OBS-29) → execution (this tx) → receipt → cap re-read from the
chain. Step 10 was the last missing live link of tracks 1-3.

Two honest follow-ups in the same hour. The live-alignment drift test CAUGHT
the amendment and failed loudly: its pin "transfer 50 → DENY over-cap" was
true under the old cap and is false under cap 100 — the world changed, the
test noticed. The pin is now cap-relative (over-cap = live cap + 1, and the
historical 50-unit request is re-decided against TODAY's chain: allowed iff
the live cap covers it), because the engine must predict the chain as it is,
never as it was; suite back to **302/302, 0 skipped**. And the success record
rendered twice on the proposal screen (a wrapper strip plus the submit
panel); the wrapper is gone — the record renders once, inside the "Put it on
chain" card, in both signer modes.

What this changes going forward: the SNIP-9 freeze (OBS-32) still stands for
the wallet-mode story until the v0.4 guard fix. But the mandate layer's
promise — owner sovereignty over an agent's budget, provable on chain — now
has a complete live witness. The pasted-key hop was the owner's own
deliberate act on the owner's own key: the tab forgot it the moment it
signed (pinned behavior), and the server never saw it.

Lesson: a drift test that fails the moment the owner legitimately amends the
chain is not a broken test — it is the test noticing the world changed. Pin
behavior relative to the live chain, and let history live in the records,
not in the assertions.

## OBS-34 - 2026-10-27 - v0.4 is LIVE on Sepolia: the last pasted-key act replaced the gate's code in place, and the chain answered that everything survived

The upgrade planned itself from the record (the state file's pending class,
never the request), the owner priced it on the console's new "Gate contract"
card, confirmed it with an explicit button (a confirmation per priced plan —
re-pricing resets it), pasted the Ready X key ONE last time, and the tab
signed. The relay carried the signed bytes under its three unchanged
controls, tagged `action:'upgrade'` for the audit trail only (proposalId
null — it executes no proposal). Receipt: SUCCEEDED, ACCEPTED_ON_L2.

- upgrade tx `0x55ea5c1f12bcf9130ec1501031a413a12e116ead7491204b0ae33fa6a7566a0`
  — the hash the tab computed equals the hash the node returned, byte for byte
- the gate's nonce moved 7 → 8: exactly one transaction, no replay, no stray
- declare tx behind it: `0x663510bc…7070` (class `0x15d47cb5…35ff`)

Then verified from the node with the console server out of the loop
(verify-upgrade.mjs, 15/15 PASS): the class hash AT THE GATE is the declared
v0.4 class and is not v0.3; the class the gate now RUNS carries all eight
admin entrypoints plus `execute_from_outside_v2` in its ABI (the running code
is v0.4, not just a matching hash); and the whole mandate read back
unchanged — session 0/10 calls, the step-10 cap of 100 per call, the 30-day
window, the merchant allowlist, and the owner key, which is still the
post-handover Ready X key (`0x4fb24b…e7d2`): the upgrade changed CODE, not
owner. The HISTORICAL pasted key still controls nothing.

One honest probe bug, recorded because it looked like a chain failure and was
not: the first run FAILED "owner key unchanged" — because it compared the
chain's owner against `state.keys.owner.public_key`, and that slot is
deliberately HISTORICAL (the pre-handover pasted key, kept forever as
evidence, controlling nothing). The chain had not changed the owner; the
probe had asked the wrong record. The right baseline is the phase-6 handover
record: `handover.json`'s newOwnerPublicKey and its own read-back, which
still agree with today's chain read. Probe fixed to compare against those;
15/15.

What this closes: OBS-32's circularity. While v0.3 ran, a wallet's signing
rehearsal of `upgrade` failed at signing time (self-only guard), so the
wallet could not install the fix that would let the wallet act — the owner
key was the only door out, and this was its last use. From v0.4 on, the eight
admin entrypoints accept the gate itself OR the registered wallet
controller: future owner actions sign FROM THE WALLET, no export, no paste.
The guard adds no privilege — an outsider still panics with the byte-identical
felt252 'Account: unauthorized' (snforge t41).

Records, evidence never removed: state.json now says v0.4 everywhere it
matters (contracts.gate_account version/class_hash/upgrade_tx; classes
GateAccount v0.4 with v0.3 preserved under previous_v03); pending_upgrade is
null and the full applied record — declare, proofs, install path, upgrade tx,
receipt, verification — lives in upgrade_history; the relay's submission
record keeps proposalId null + action 'upgrade' + computedHash == node hash.
Suites at the moment of install: snforge 48/48, JS 314/314 with 0 skipped
(twelve new pins cover the upgrade path: status honesty, plan-from-record,
replay refused by the CHAIN itself, byte-for-byte relay, wrong-key refusal).

What this unlocks next: the live wallet-flow proof on a fresh proposal — the
wallet carrying its own `execute_from_outside_v2` end to end — and after
that, controller-signed admin actions with no key export at all.

## OBS-35 - 2026-10-28 - The wallet-flow proof is LIVE: the owner's wallet signed an amendment and carried it to the chain itself — and the console then showed three honest failures worth more than a clean run

**The proof.** Proposal `4883847fbc212efe` (50 mock units to the stranger)
was blocked by the chain with `recipient-not-allowed`. The owner's decision —
"Amend the mandate → allow this recipient" — was signed in Ready X and
carried to Sepolia BY THE WALLET ITSELF, no relay, no pasted key, no server
signature anywhere:

- tx `0x419f306ab0e164fa420b584c0528390d824a271c744e1c59c92fdce5236ebb7`,
  SUCCEEDED / ACCEPTED_ON_L2, block 17262934, wallet nonce 4
- sender = the owner's wallet `0x0022239d…b1fcfb`, calling
  `execute_from_outside_v2` on the v0.4 class `0x015d47cb…35ff`
- inner calls, read from the chain's own copy: the wallet's
  `is_valid_signature` (SNIP-9 delegation) and the gate's `allow_recipient`
- the owner signature inside: five felts `[0x1, 0x0, 0x4fb24b55…e7d2, r, s]` —
  the same standard shape as OBS-29, with the handover key
- caller `0x414e595f43414c4c4552` ("ANY_CALLER"): anyone may submit; only the
  owner's signature authorizes
- the one-shot nonce is burned on chain — the authorization can never be
  replayed, which is also why the proposal is terminal (AMENDED) and cannot
  be amended again. That is the design, not a stuck button.

This was the first time Ready X's signing-time rehearsal (popup 1) passed —
v0.3 greyed out Sign because every real call was self-only (OBS-32); v0.4
accepts the registered controller, so the rehearsal the wallet showed the
owner was TRUTHFUL. Tracks 1–3 now have a live witness for every path: agent
ask, engine verdict, owner decision signed in a real wallet, wallet-carried
execution, receipt, chain re-read.

**Failure 1 — the console refused to let the owner sign nonsense, twice.**
The first proposal (`417ed248985a4875`, 150 to the merchant) was resolved
with "raise the per-call cap to 150": preview refused with "maxPerCall 150
would exceed the window cap 100 - the on-chain policy would contradict
itself." Retried at 60: refused again, "not above the current cap 100 -
refusing to sign a pointless cap change." Both guards worked exactly as
built — no signature was ever created for a self-contradictory or pointless
mandate. But together they exposed a **dead corner (product gap)**: step 10
set per-call cap == window cap == 100, so "raise the per-call cap" has NO
valid value at all, and no decision form raises the window cap. The fix — a
window-cap amendment, test-first — is recorded in NEXT.md.

**Failure 2 — false RECORD MISMATCH lock card.** The mandate screen screamed
"The key on chain does not match the registration record." The chain was
right; the console asked the wrong record: it compared the live owner key
against `state.keys.owner.public_key`, the deliberately HISTORICAL
pre-handover slot — the exact same wrong-baseline bug OBS-34's verification
probe hit a day earlier, this time living in the server itself. Fixed the
house way: `state.json` gains `keys.owner_current` (the handover baseline,
sourced from `handover.json`'s newOwnerPublicKey and its chain read-back),
and the server reads `owner_current ?? owner.public_key` so pre-handover
records still work. Teeth pinned by test: a genuinely different live key
still mismatches — the fix narrows the baseline, not the check.

**Failure 3 — the stuck "Reading…" spinner.** The owner's "Read again" spun
forever. Diagnosis: every chain read was fast when probed individually
(which-read-hangs.mjs: 240–1159ms), but NONE of the server's three fetch
seams had a timeout — mandate-reader's `call()`, the server's `rpcCall()`,
and the status read. One silent node (the machine had slept overnight; the
network stack had just woken) freezes the request, `Promise.allSettled` waits
on it, and the spinner never clears. Fixed: `AbortSignal.timeout` on all
three seams (default 20s, injectable via `rpcTimeoutMs`), each failing with a
loud "the chain node did not answer within Ns" instead of hanging. Pinned
against a black-hole server that accepts connections and never answers —
the exact failure mode, reproduced on purpose.

**Failure 4 (found by the probe) — the stale allowlist record.** The chain
says the stranger IS allowed (`is_recipient_allowed` = 1, read directly), but
the console showed NOT ALLOWED: the reader can only check candidates the
RECORD names (the contract has no enumeration view), and the stranger was
never added to `state.mandate.merchant_allowlist.allowed`. The record drifted
from the chain the moment the owner amended it — OBS-33's lesson in a new
seat. Fixed: the record now lists the stranger with a `stranger_added` note
citing the wallet tx, and the live-alignment test's stranger pin is now
chain-relative (it asks `is_recipient_allowed` directly and alarms if the
record's list ever disagrees — a future revocation fails loudly instead of
hiding).

Suites after the fixes: **JS 321/321, 0 skipped** (seven new pins: three
timeout seams, the endpoint answering loudly under a silent node, and the
owner-baseline match / fallback / mismatch trio), style gate PASS, and the
live `/api/mandate` re-read shows: owner key matches record, both recipients
allowed, status honest, block moving.

Lesson: the wallet-flow proof passing was the headline, but the three
console failures around it were the real product work — a sovereignty tool is
only as trustworthy as its honesty under stale records, silent nodes, and
dead corners. All three now fail loudly, in plain language, with the reason
on screen.

## OBS-36 - 2026-10-28 - The window-cap fix is LIVE: the owner signed "raise the window cap to 150" in Ready X, the wallet carried it, the chain applied it — and a server restart between signing and recording exposed the last seam, fixed test-first the same day

**The proof.** Proposal `97dca512ed101c00` (150 mock units to the merchant)
was blocked over-cap, and the OBS-35 dead corner meant "raise the per-call
cap" had no valid value (per-call == window == 100). The owner's decision was
the new amendment: "Amend the mandate → raise the window cap to 150." Signed
in Ready X and carried to Sepolia BY THE WALLET ITSELF — no relay, no pasted
key, no server signature anywhere:

- tx `0x69b20e5cd9878a416448f99002c491aa2888c8bb757ef19c73e44c510a7fa0d`,
  INVOKE, SUCCEEDED / ACCEPTED_ON_L2, block 17267240, wallet nonce 5
- chain re-read after: per-call cap 100 (preserved), window cap 150 (raised
  from 100), window seconds 2592000 (kept), spent 0 — exactly the reset the
  preview had warned about before signing
- the one-shot SNIP-9 nonce `0x9bab0c74b6101a0db63ff84aee1b6b7d` is burned;
  console record #7 in submissions.json reads via `wallet-submitted`,
  relayer null, nonce_consumed true

**The wallet popup (observed, screenshotted by the owner).** Ready X decoded
the inner call in plain words: "Set spending policy" and "No balance change".
The single warning was the honest one — Critical risk: any caller may carry
this — and the wallet showed its raw untranslated i18n key
(`outside_execution_any_caller_approval_title`), a small honesty artifact:
it did not paper over an unbuilt string. Sign stayed greyed until the owner
pressed "Review and accept risk" — the ANY_CALLER design (anyone may submit,
only the owner's signature authorizes) was accepted knowingly, then signed.
As in OBS-35, the v0.4 signing-time rehearsal passed.

**How the tx hash was found — bisection, not memory.** A server restart
during the run killed the in-flight page flow, so the console never wrote its
record and no hash was stored anywhere. The chain kept everything: a probe
bisected blocks 17267019→17267310 by reading `get_spending_policy` at each
historical block until the first block whose window cap read 150 (17267240),
then scanned that block for the wallet-sent transaction. The hash comes from
the node — never typed from memory, the same rule as every constant here.

**The last seam the restart exposed (fixed test-first, same day).** Adopting
the record via `/api/outside/record` returned 409: "maxPerWindow 150 is not
above the current window cap 150 - refusing to sign a pointless cap change."
The guard was right and wrong at once: the record path re-derived the
expected calls against the LIVE policy — which the transaction itself had
already moved. The guard that correctly refuses to SIGN a pointless change
was also refusing to VERIFY the change that had been applied. Fix: a
record-path-only `verifyApplied` derivation in resolutions.mjs — when the
live policy already holds the amendment's target, the expected wire is the
live values (byte-identical to the pre-apply derivation for the fields the
amendment preserved), and every other control is unchanged: single call,
right gate, `execute_from_outside_v2`, ANY_CALLER, exact calldata compare,
receipt, nonce read-back. plan/wire/submit never pass the flag, so a
pointless change can still never be signed or authorized — pinned by its own
test. A tampered tx (window seconds off by one) is still refused in record
mode: the expectation is exact, not forgiving. 4 new pins (r13/r14
derivation, server adoption, plan-refusal); suite **330/330, 0 skipped**,
style gate PASS.

**What this unlocks.** Window cap 150 > per-call cap 100, so "raise the
per-call cap to 150" is a valid decision again, and after that the original
150-unit ask can finally be approved once. The dead corner is closed: built,
tested, proven live, recorded, adopted — every step with a receipt.

## OBS-37 - 2026-10-28 - The per-call raise goes live too: the second wallet-carried amendment lands, and the adoption path passes its first real use hours after being built

**The proof.** Proposal `a05edb2be7322ed1` — a fresh 150-unit ask to the
merchant, this time blocked by the PER-CALL cap (the window cap was already
150 from OBS-36). The owner's decision: "Amend the mandate → raise the
per-call cap to 150" — valid now, because the window raise made room
(150 ≤ window 150). Signed in Ready X, carried by the wallet itself:

- tx `0x205710f6a197c017bc096c19538c0ff8114203fb1c80396e4e891c335e251fb`,
  INVOKE, SUCCEEDED / ACCEPTED_ON_L2, block 17272013, wallet nonce 6
- chain re-read: per-call cap 150 (raised from 100), window cap 150 (kept),
  window seconds kept, spent 0
- hash recovered by the same chain-state bisection (perCall flips 100→150 at
  block 17272013), adopted via `/api/outside/record`: record #8,
  wallet-submitted, relayer null, one-shot nonce `0xdac915c2…b957` consumed

**The adoption path's first real use.** This was the first live exercise of
OBS-36's `verifyApplied` fix on the per-call kind: the live policy (150)
already equaled the target, the record path derived the expectation from the
live values, and every control held — exactly what pin r14 promises, now
proven against the real chain. The page's own record write did not land this
time even though the server ran throughout (most likely the wallet's
transaction was not yet visible to the node when the page asked, or the
popup flow was closed) — and recovery cost two minutes and zero typed
constants. A fix built for one restart earned its keep the same day.

**The corner is closed — and stays closed.** Per-call == window == 150
again, but the dead corner cannot trap the owner anymore: when a future ask
exceeds the window cap, the form now DEFAULTS to the window-cap amendment,
so no screen ever offers a decision with no valid value. Every number in the
live policy got there through an owner-signed, wallet-carried,
chain-verified, console-recorded decision. And the original story's ask —
150 units to the merchant, the one that was blocked at the very beginning —
is now inside the mandate: same ask, different mandate, no human needed.



## OBS-38 - 2026-10-28 - The owner-facing app is live against the real engine: five screens, zero crypto-native surface, and the jargon gate catches its own author

**What was built.** `mandate-workspace/app/` - the tested console's engine
wires to a completely new owner-facing UI (vanilla JS, no build step, no
framework), served on port 4181 through a dev proxy that forwards `/api/`,
`/vendor/` and the tested signer modules to the untouched console server on
4173. permission-core changed by zero bytes; the AnchorGate reference copy
stayed read-only. Screens: Rules, Requests, Waiting for you, Activity, How it
works. Waiting/Activity are honest placeholders this phase (they say so, and
Waiting shows the live pending count); Rules and Requests are fully wired.

**The gate that guards the product rule.** `tools/check-jargon.mjs` makes
"no crypto-native surface" mechanical: banned vocabulary only inside
crypto-surface blocks, machine layer (data.js/serve.mjs) forbidden from
rendering, every display-state error assignment must pass plainError(), every
token in sRGB gamut, hex comments must equal computed hex, favicon hex must
equal the accent's rendered hex, no colour literals in style.css, and the 44px
control floor enforced per rule block.

**It caught its own author, twice.** First run: 13 failures - three raw
machine words in vocab.js's recognition patterns (now fenced: they read the
machine's words, never emit them), `s.address` plumbing in app.js (field
renamed to `id`; the word no longer exists in any UI file), an out-of-gamut
surface token, and a hex comment that promised a colour the token did not
render. Then the browser pixel probe caught what the gate's first version
missed: `.btn-sm` rendered at 32px and `.quick` at 30px - violations of
the 44px floor the tokens file itself declares with "no exceptions". Both
fixed, and the floor is now a gate rule, not a hope. Re-probe: every
interactive control measures exactly 44px.

**Live proof, browser-driven.** Rules shows the chain's own truth: 150
per-purchase, 150 monthly, spent 0, resets 27 Nov 2026, 2 of 3 stores
approved, access until 18 May 2033, 10 of 10 actions left. Three asks filed
through the real API, three honest verdicts: 120 to CloudCompute ALLOWED
("This was a check against your rules. Nothing has been paid."); 400 BLOCKED
("It is over your 150 per-purchase limit, so it stopped." + Decide-it link);
ShipIt 120 BLOCKED ("ShipIt is not on your approved list, so it stopped.").
Requests lists all 16 asks newest-first with plain outcomes ("raised the
per-purchase limit - recorded"); the waiting badge reads 2; a full-body jargon
scan of every screen finds zero machine words; the console is empty of errors;
the accent renders pixel-exact #0776ea and the favicon matches.

**The two new pending proposals are real state.** The 400-unit and ShipIt asks
created genuine PENDING proposals on the server - kept (evidence is never
removed) and they are exactly the material the Waiting screen's decision flow
will consume next phase.
