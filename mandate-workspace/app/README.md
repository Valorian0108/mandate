# app/ — the mandate frontend

Placeholder for Track 4. Built here:

- Five screens: Rules / Requests / Waiting for you / Activity / How it works
- Plain language only — zero crypto-native surface (no addresses, keys,
  hashes, gas, chain names). Crypto appears exactly twice: the approval
  confirmation popup and optional "show the receipt" drawers.
- Talks to the existing tested server (`permission-core/web/server.mjs`) over
  the same HTTP API. Engine/server/tests are not modified.
- Visual baseline: `mockups/track4-console.html`.
- Product/UX reference (read-only): `../anchorgate-reference/` — rules model,
  verdict wording, approval lifecycle, record design, ask box, demo agent.
