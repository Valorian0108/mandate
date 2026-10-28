# What this project is, in product terms

Written 2026-10-25, after the owner looked at the console and asked the question
that matters: "I thought I was building a tool others can plug into their apps."
Yes — and this file records what that means concretely, so the roadmap and the
code never drift apart again.

## One line

**Permission infrastructure for AI agents that spend money** — plus a console
that lets a human see it work and prove it.

## Two customers, one system

**Builders** (anyone making an AI agent that pays for things) plug into the
machinery:

- the **gate contract** on Starknet — holds the owner's rules and refuses
  overspending at the blockchain level, where no database edit can reach it;
- the **permission engine** — the agent asks before acting and gets
  *allow / blocked / ask the human*;
- the **signature layer** — only the owner's own signature can unlock an
  exception; the builder's servers can verify signatures but can never produce
  one, even when compromised;
- the **trust ladder** — the agent accumulates a verifiable track record it can
  carry with it.

**Owners** (the humans whose money it is) get a console: set the rules, see what
got blocked, sign decisions with their own wallet, read the history.

## The webpage is not the product

The console at `permission-core/web/` is the **reference demo** — proof the
machinery works from a real human's chair, and the face of the project when it
is shown to the world. The product is what sits under it: gate + engine +
signature layer + ladder.

## What "others can plug in" still needs, in order

1. **Finish track 2 — real wallets** (in progress). No stranger will paste a
   private key into someone's webpage; they sign with their own Argent X. This
   is the prerequisite for anyone outside the demo trusting the system with
   value. Phases 4-6 remain, in NEXT.md.
2. **Track 3 — witness keys that can live a real life** (NEXT.md). Real apps
   rotate keys; today's résumé would call an honest rotation a contradiction.
   Owner-signed witness attestations make rotation legitimate history. Machinery,
   so it lands before the clarity pass — the demo then shows the finished
   feature set, and no screen is rewritten twice.
3. **Track 4 — the demo a stranger can understand** (NEXT.md). The owner's own
   verdict on the current UI (2026-10-25): "i dont understand shit inthere rn…
   if me cant understand it how will other do." A failed user test from the most
   motivated user possible. Story first, receipts one click away.
4. **Productization** — the plug-in offer itself:
   - many owners, many agents, many GateAccounts (today: one demo instance);
   - an integration API/SDK: "here is how your agent asks the gate", a few
     lines of code, with docs;
   - a deploy flow so a builder can stand up their own instance;
   - the track record becomes **portable**: an agent's résumé travels between
     apps — that is the network-effect piece, and the reason a builder would
     adopt this rather than roll their own.

## The demo principle (binding for every screen, now and later)

**Story first, receipts one click away, evidence never removed.**
Plain words on the surface ("You are declining: the agent asked to pay 35.
Nothing will be sent."); the cryptographic proof — digest, signature scheme,
chain reads — behind a "Show the proof" toggle. The house rules still hold:
every claim on screen remains verifiable; the change is where the proof lives,
not whether it exists.
