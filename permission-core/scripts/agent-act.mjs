// One honest agent action, appended to the demo agent's evidence log.
//
// WHY this exists: a demo run (scripts/demo-layer-d.mjs) ends with the agent's
// fingerprint anchored on-chain - root and count both matching. To show the
// console's anchor loop doing real work, the agent has to keep acting: a NEW
// signed record moves the fingerprint, the résumé starts shouting that the
// chain is behind, and the owner (in the browser, with a wallet) anchors the
// new state. This script is that agent. Nothing here is staged: it asks the
// REAL permission engine one question and appends the record the engine
// produces, signed by the same app witness the demo run persisted.
//
// The action is a sandbox spend - no value moves, and the record says so
// explicitly ('sandbox-allowed'). The engine still runs every gate: the
// agent's ladder stage first, then the LIVE mandate read from the chain.
//
// TESTNET ONLY. The witness key (.data/demo-agent-runtime.json) signs facts
// only; it can never move funds. The owner key is never read here.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEvidenceStore, evidenceDigest, merkleRoot } from '../src/evidence.mjs';
import { createTrust } from '../src/trust.mjs';
import { createClient } from '../src/sdk.mjs';
import { chainOwnerPublicKey } from '../src/proposals.mjs';
import { call } from '../src/mandate-reader.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_PATH = join(PKG, '..', 'gate-account', '.sepolia', 'state.json');
const DATA = join(PKG, '.data');
const RUNTIME_PATH = join(DATA, 'demo-agent-runtime.json');
const PROPOSALS_PATH = join(DATA, 'demo-layer-d-proposals.json');

// Every failure ends in one machine-readable line (the owner-tx.mjs pattern):
// a result line beats an exit code, because a shell can swallow the latter.
function fail(message) {
  console.log(`AGENT_ACT_RESULT ${JSON.stringify({ ok: false, error: message })}`);
  process.exit(1);
}

async function main() {
  if (!existsSync(RUNTIME_PATH)) {
    fail(`no agent runtime at ${RUNTIME_PATH} - run scripts/demo-layer-d.mjs ` +
      'first; it writes the identity and the app-witness key');
  }
  const runtime = JSON.parse(readFileSync(RUNTIME_PATH, 'utf8'));
  if (!existsSync(runtime.identityPath)) {
    fail(`the runtime names no readable identity file (${runtime.identityPath})`);
  }
  const identity = JSON.parse(readFileSync(runtime.identityPath, 'utf8'));
  if (identity.agentId !== runtime.agentId) {
    fail(`the identity file names agent ${identity.agentId}, but the runtime ` +
      `names ${runtime.agentId} - refusing to sign records for an agent whose ` +
      'witness we do not hold');
  }

  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  const registry = state.contracts.evidence_registry.address;
  const gate = state.contracts.gate_account.address;
  const token = state.contracts.token.address;
  const merchant = state.keys.merchant.address;

  const client = createClient({
    identity,
    witnessPrivateKey: runtime.witnessPrivateKey,
    evidencePath: runtime.evidencePath,
    ladderPath: runtime.ladderPath,
    storePath: PROPOSALS_PATH,
    policies: {
      files: {
        protectedPaths: [],
        maxDeletesPerDay: 10,
        deletesToday: 0,
        shareRequiresApproval: false,
      },
    },
  });

  // The live mandate, read from the chain - the same read the console makes.
  const { mandate } = await client.loadMandate();
  if (String(mandate.token).toLowerCase() !== String(token).toLowerCase()) {
    fail(`the live mandate names token ${mandate.token}, but the state file ` +
      `names ${token} - refusing to guess which is right`);
  }

  // One real decision: a sandbox spend of 5 to the allowlisted merchant, on the
  // token the live mandate names. The engine runs every gate, and the record it
  // appends says exactly what happened - a simulation, labelled as one.
  const outcome = await client.execute({
    user: 'user:demo',
    agent: 'agent:demo',
    action: 'spend:transfer',
    resource: `token:${token}`,
    context: { recipient: merchant, amount: '5', token },
  }, { sandbox: true });
  if (!outcome.evidence?.seq) {
    fail('the engine produced no signed record (verdict ' +
      `${outcome.decision?.verdict} ${outcome.decision?.code ?? ''})`);
  }

  // The WHOLE file must still verify - every record, including the ones older
  // agents left behind. Evidence is never removed, and never re-signed.
  const trust = createTrust({
    identity,
    witnessPrivateKey: runtime.witnessPrivateKey,
    evidencePath: runtime.evidencePath,
    ladderPath: runtime.ladderPath,
    readOwnerKey: () => chainOwnerPublicKey({ statePath: STATE_PATH }),
  });
  const loaded = await trust.load();
  if (!loaded.ok) {
    fail(`the evidence file no longer verifies after the append: ` +
      `${loaded.error} - ${loaded.reason}`);
  }

  const evidence = createEvidenceStore({ filePath: runtime.evidencePath });
  const records = evidence.list(identity.agentId);
  const root = merkleRoot(records.map(evidenceDigest));
  const count = records.length;

  // What the chain holds right now. The anchor SHOULD be behind - that gap is
  // exactly what the console's anchor panel exists to close. The read follows
  // the state file's verified endpoint (the reader's module default is the
  // discontinued Cartridge URL, dead since 2026-10-30).
  const [chainRoot, chainCountRaw] = await call(
    registry, state.selectors.get_anchor, [identity.agentId, gate],
    { rpcUrl: state.rpc_endpoints_verified.cartridge.url });
  const chainCount = Number(BigInt(chainCountRaw));
  const chainMatches = BigInt(chainRoot) === BigInt(root) && chainCount === count;

  console.log(`record #${outcome.evidence.seq} appended: ` +
    `${outcome.evidence.outcome} (${outcome.decision.verdict} ${outcome.decision.code})`);
  console.log(`new fingerprint: root ${root} count ${count} (file verifies: ${loaded.ok})`);
  console.log(`chain anchor:    root ${chainRoot} count ${chainCount} (matches: ${chainMatches})`);
  console.log(chainMatches
    ? 'the chain already holds this fingerprint - there is nothing to anchor'
    : 'the chain is BEHIND - the résumé screen will offer to anchor the new fingerprint');
  console.log(`AGENT_ACT_RESULT ${JSON.stringify({
    ok: true,
    agentId: identity.agentId,
    seq: outcome.evidence.seq,
    outcome: outcome.evidence.outcome,
    verdict: outcome.decision.verdict,
    code: outcome.decision.code,
    root,
    count,
    chainRoot,
    chainCount,
    chainMatches,
  })}`);
}

main().catch((e) => fail(e.message));
