# Handing the keys to YOUR wallet — what we'll do, in plain words

Written 2026-10-26. Everything here happens on **Sepolia, the test network** —
no real money is involved anywhere.

## What this is

Right now, your project's on-chain "gate" (the account that holds the demo
tokens and enforces the spending rules) is controlled by a **pasted test key** —
a key that was typed into a text field and lives in a file on this computer.
That was fine for building. It is not fine for the story you want to tell,
because anyone who reads that file owns everything.

This handover changes one thing: **after it, your own wallet (Ready X — the
wallet formerly called Argent X) is the boss of the gate.** Your phone-laptop
wallet extension, protected by your password and recovery phrase, becomes the
only thing that can change the rules or approve big actions. The pasted key
signs the handover itself — its very last act — and after that it can never
move anything again. The tooling proves that at the end (it re-checks on the
network that the old key is dead).

Nothing is half-done at any point: the handover is **one single transaction**
that either fully happens or doesn't happen at all.

## What you'll need

- A computer with Chrome, Brave, Firefox or Edge (the one you're on).
- About 20–30 minutes.
- Me (the agent) running the small tools and explaining each step. You do the
  wallet parts; I do the command parts.

## The steps

### 1. Install Ready X and make a wallet — YOU

Ready X is the wallet formerly called **Argent X** — same maker, same wallet,
new name (renamed in late 2025). If you already have Argent X installed and
it has updated itself, you already have Ready X.

1. Go to **ready.co** and install the browser extension (or search your
   browser's extension store for **"Ready"** — older store listings may still
   say "Argent X"; it's the same wallet).
2. Open it and choose **Create a new wallet**.
3. It will show you a **recovery phrase** (a list of words). Write it down on
   paper or save it somewhere safe offline. This phrase IS the wallet — anyone
   with it owns it, and it's the only way to recover it. Don't share it with
   me or anyone.
4. Set a password when asked.
5. **Skip any "guardian" offer.** Ready can add a second signer (a
   "guardian") for recovery. Don't add one for this demo: a guardian changes
   the wallet's signature format, and this console deliberately refuses
   signatures it can't fully verify — loudly, in plain words, never silently.
   One signer is exactly what we need.

### 2. Switch the wallet to the test network — YOU

In Ready X, open the network selector (top of the extension, it may say
"Mainnet") and choose **Sepolia** (the test network). Everything we do lives
there.

### 3. Send me your wallet address — YOU

Copy your address from Ready X (tap the address at the top → copy) and paste
it here in the chat. **An address is public information** — it's like an
account number, safe to share. It usually starts with `0x`.

### 4. I send test money for gas — ME

I run:

```
node handover.mjs --check <your address>     → confirms what the network sees
node handover.mjs --fund <your address> 0.05 → sends you test STRK for fees
```

The deployer key (a utility key whose ONLY job is paying fees — it has no
authority over your rules) sends the funds. You'll see the balance appear in
Ready X.

### 5. Your wallet "activates" on the test network — YOU (with my nudge)

A brand-new Ready X wallet isn't really on the network until its first
transaction — the wallet calls this deploying your account. Ready X will
prompt you for it (often triggered by the first send/receive, or a button in
the extension). If it doesn't happen on its own: **Settings (the gear icon) →
tap your account name → Deploy account**. I'll re-run `--check` until it
reports **deployed**.

### 6. See the refusal with your own eyes, BEFORE we hand anything over — YOU

This is a demo step, and an honest one. Open the console page in your browser
(`http://127.0.0.1:4173`) and click **Connect wallet** where it asks for the
owner key. It must **refuse you** and say, in plain words, that your wallet's
key is not the key the network says owns the gate — naming both. That refusal
is a security feature working exactly as designed: the console checks the
network, not the wallet's claims. After the handover, the same click will be
accepted.

### 7. The one sensitive moment: export the private key — YOU, then ME

**Why this is needed, honestly:** to prove to the network that your wallet's
key accepts ownership, that key must sign one specific mathematical message.
Wallet extensions only sign human-readable popups — they refuse to sign raw
messages like this one (that refusal is a good security feature!). So the
signature has to be made by the tool, locally, using the wallet's private key
**one single time**.

What you do:

1. In Ready X: tap the **Settings gear (top-right) → your account name →
   Export private key** (some versions label it "Reveal private key"). It
   will ask for your password.
2. Copy it into a new plain text file and save it as, for example:
   `C:\Users\USER\handover-key.txt`
3. Tell me the file is ready.

What the tool does (and I will show you the code doing it):

1. Reads the file.
2. Checks the key really belongs to the address you gave me (against the
   network's own copy — no trusting).
3. Makes the "I accept ownership" signature **on this computer, right now**.
4. Asks the network to confirm your wallet is honest (it must recognize its
   own key's signature and refuse a stranger's).
5. **Deletes the key file immediately.** The private key is never written into
   any record, never uploaded anywhere, never sent to any server. After this
   step, the file is gone and only the signature remains.

Then you can delete the key from your clipboard too, for good measure.

I run:

```
node handover.mjs --prepare <your address> C:\Users\USER\handover-key.txt
```

### 8. The handover itself — ME, one transaction

```
node handover.mjs --execute
```

This sends ONE transaction, signed by the pasted key (its last act), that does
both halves together or neither:

- your wallet's key becomes the gate's **owner** (the boss), and
- your wallet becomes the gate's **designated signer** (the thing the server
  asks to approve actions).

Before sending, the tool does a dry run — if anything would fail, nothing
lands. After it lands, the tool reads both facts back from the network itself.

### 9. Proof it worked — ME

```
node handover.mjs --verify
```

A checklist that reads everything back from the network, including the
negative proof: **a signature made with the OLD pasted key is rejected.** The
old key is officially dead. The pasted key stays *recorded* (history is never
erased), marked as historical.

### 10. Drive it yourself — YOU

Back in your browser, reload the console and **Connect wallet** again. This
time you're accepted — the network itself says your key is the owner. Then we
run the whole story, with your wallet doing every approval:

1. The agent asks to spend more than its rules allow → it gets **blocked** and
   a request lands on your screen.
2. You approve → **Ready X pops up** → you sign → the server carries the
   signed action to the network → tokens move, receipt recorded.
3. The agent earns another entry in its track record → the "track record"
   screen offers to stamp it on the network → **Ready X pops up** → you sign
   → the fingerprint is stored on-chain forever, read back and shown.

At the end: the server has **never seen your key**, every action carries a
receipt, and the rules you set are enforced by the network — not by anyone's
promise.

## If anything worries you

- **Can I lose money?** There is no real money. It's all test tokens on a test
  network.
- **Can the handover get stuck halfway?** No — it's one transaction. It either
  fully happens or the network rejects it and nothing changes.
- **What if I stop after step 7 and never do 8?** Nothing has changed on the
  network yet, and your key file is already deleted. We can prepare again any
  time.
- **What if I lose my wallet later?** Your recovery phrase restores it. And
  the gate can be handed to a new key the same way this handover works — the
  owner can always rotate.
- **Why do these steps say "Ready X" when older guides say "Argent X"?** Same
  wallet — Argent rebranded to Ready in late 2025. Your extension might show
  either name; both are the one we want.
- **Does the server keep any key?** No. The server keeps a fee-paying utility
  key (the deployer) that can carry transactions to the network but cannot
  approve anything — every approval needs YOUR wallet's popup. This was true
  before and stays true.

## Where the receipts live (for the curious)

- `gate-account/.sepolia/handover-prep.json` — the accept-ownership signature
  and the honesty-probe results (no private key, ever).
- `gate-account/.sepolia/handover.json` — funding, the handover transaction,
  and the read-backs.
- `gate-account/.sepolia/state.json` (`phase6_handover`) — the full record,
  including the test results that pinned the maths before any of this ran
  (45 contract tests, 246 program tests, and a live network proof of the
  exact anchoring flow you'll drive in step 10).
