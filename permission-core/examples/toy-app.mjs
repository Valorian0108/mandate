// A whole application in one file, built ONLY through the front door.
//
// This is the proof that the door is sufficient: everything below imports a
// single module (../src/sdk.mjs) and calls at most four functions. No engine,
// no gates, no store, no digest maths - if this app can be blocked, propose,
// and see the owner's console pick it up, the SDK hides the internals properly.
//
// Run against live Sepolia:   node examples/toy-app.mjs
// (Tests run the same run() with an injected mandate and a temp store.)

import { pathToFileURL } from 'node:url';
import { createClient } from '../src/sdk.mjs';

export async function run(options = {}) {
  const client = createClient(options);

  // 1. Read the user's real rules off the chain.
  const { mandate } = await client.loadMandate();
  const recipient = options.recipient ?? mandate.allowedRecipients[0];
  const request = (amount) => ({
    user: 'user:toy-app',
    agent: 'agent:toy-app',
    action: 'spend:transfer',
    resource: `token:${mandate.token}`,
    context: { recipient, amount, token: mandate.token },
  });

  // 2. The point-of-action call. Inside the limits -> the app proceeds with its
  //    OWN tool call (the door does not spend for you; it only says yes/no).
  const inside = await client.execute(request(options.insideAmount ?? 5));

  // 3. The same call, beyond the limits -> blocked, and the block becomes a
  //    proposal the owner sees in the console's Approvals screen.
  const beyond = await client.execute(request(options.beyondAmount ?? 100000));

  // 4. A domain with no chain lock, where the policy says "always ask": the
  //    door answers ASK_USER and that too becomes a proposal.
  const share = await client.execute({
    user: 'user:toy-app',
    agent: 'agent:toy-app',
    action: 'files:share',
    resource: 'file:quarterly-report.pdf',
    context: {},
  });

  return { mandate, inside, beyond, share };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Company-side policy for domains without a chain lock (the files gate is
  // advisoryOnly, so its rules live with the company, not on-chain).
  const result = await run({ policies: { files: { protectedPaths: [], maxDeletesPerDay: 3, deletesToday: 0, shareRequiresApproval: true } } });
  const line = (label, r) => {
    if (r.allowed) return `${label}: ALLOWED - ${r.decision.reason}`;
    return `${label}: ${r.decision.verdict} (${r.decision.code}) - ${r.decision.reason} -> proposal ${r.proposal.id}`;
  };
  console.log('mandate: per-call', String(result.mandate.maxPerCall), '· window', String(result.mandate.maxPerWindow),
    '· spent', String(result.mandate.spentInWindow));
  console.log(line('transfer 5      ', result.inside));
  console.log(line('transfer 100000 ', result.beyond));
  console.log(line('share a file    ', result.share));
}
