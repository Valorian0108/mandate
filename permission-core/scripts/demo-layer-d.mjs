// Layer D live demo: an agent earns trust, the owner anchors the evidence on
// Starknet, and a promotion is bound to that exact anchored root.
//
// The run is deliberately end-to-end and self-checking:
//
//   1. a brand-new agent identity, signed by the owner key;
//   2. cold start: the door turns an otherwise-valid transfer into a proposal;
//   3. three sandbox runs (simulated, explicitly labelled);
//   4. the owner anchors the evidence root + count in EvidenceRegistry, through
//      the GateAccount, and the script reads the anchor back from the chain;
//   5. the owner signs a promotion to `probation`, bound to that root/count;
//   6. probation's stricter limits ask before the live mandate would allow;
//   7. editing one record after the fact makes the whole evidence file fail.
//
// Every check is an OBS-08 check: it is the only thing between a plausible claim
// and an accepted one. If any check fails, the script exits non-zero and writes
// the failure into the report.
//
// TESTNET ONLY. The owner key comes from gate-account/.sepolia/state.json.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as stark from '@scure/starknet';

import {
  createEvidenceStore, merkleRoot, evidenceDigest, signIdentity,
} from '../src/evidence.mjs';
import {
  createLadderStore, ladderChangeDigest, signLadderChange,
} from '../src/ladder.mjs';
import { createTrust } from '../src/trust.mjs';
import { createClient } from '../src/sdk.mjs';
import { chainOwnerPublicKey } from '../src/proposals.mjs';
import { call } from '../src/mandate-reader.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_PATH = join(PKG, '..', 'gate-account', '.sepolia', 'state.json');
const TOOLS_DIR = join(PKG, '..', 'gate-account', 'tools');
const OWNER_TX = join(TOOLS_DIR, 'owner-tx.mjs');
const DATA = join(PKG, '.data');

const IDENTITY_PATH = join(DATA, 'demo-layer-d-identity.json');
const EVIDENCE_PATH = join(DATA, 'demo-layer-d-evidence.json');
const LADDER_PATH = join(DATA, 'demo-layer-d-ladder.json');
const PROPOSALS_PATH = join(DATA, 'demo-layer-d-proposals.json');
const TAMPERED_PATH = join(DATA, 'demo-layer-d-evidence-tampered.json');
const REPORT_PATH = join(DATA, 'demo-layer-d-run.json');
// The app-witness runtime for THIS run: the identity plus the witness key that
// signs the agent's fact records, persisted so scripts/agent-act.mjs can keep
// acting as the SAME agent between demo runs. The witness signs facts only - it
// can never move funds, and it is not the owner key. Without it, any later
// record would need a SECOND witness, and the résumé would (rightly) shout
// about the contradiction.
const RUNTIME_PATH = join(DATA, 'demo-agent-runtime.json');

// Filled from the state file in main(), never hardcoded: the v0.3 migration
// moved the token, and a stale constant here would make every sandbox run come
// back 'no-policy' - the demo would fail its own checks while describing a
// token the live mandate no longer names.
let TOKEN = null;
let MERCHANT = null;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function spend(amount) {
  return {
    user: 'user:demo',
    agent: 'agent:demo',
    action: 'spend:transfer',
    resource: `token:${TOKEN}`,
    context: { recipient: MERCHANT, amount, token: TOKEN },
  };
}

function share(path) {
  return {
    user: 'user:demo',
    agent: 'agent:demo',
    action: 'files:share',
    resource: `file:${path}`,
    context: { path },
  };
}

function runOwnerTx(calls) {
  const proc = spawnSync(process.execPath, [OWNER_TX, '--calls', JSON.stringify(calls)], {
    cwd: TOOLS_DIR,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith('OWNER_TX_RESULT '));
  if (!line) {
    throw new Error(`owner-tx produced no result line\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const result = JSON.parse(line.slice('OWNER_TX_RESULT '.length));
  if (proc.status !== 0 || result.status !== 'SUCCEEDED') {
    throw new Error(`owner-tx failed (${result.status}): ${result.message ?? result.revert_reason ?? ''}\n` +
      `${stdout.split(/\r?\n/).slice(-8).join('\n')}\n${stderr}`);
  }
  return { result, stdout };
}

async function main() {
  mkdirSync(DATA, { recursive: true });
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  const registry = state.contracts.evidence_registry.address;
  const gate = state.contracts.gate_account.address;
  // The same sources the live mandate reader uses (src/mandate-reader.mjs):
  // the token the state file names, and the merchant from the recorded keys.
  TOKEN = state.contracts.token.address;
  MERCHANT = state.keys.merchant.address;
  const ownerPriv = state.keys.owner.private_key;
  const ownerPub = state.keys.owner.public_key;

  const derived = stark.getStarkKey(ownerPriv);
  if (derived !== ownerPub) {
    throw new Error(`owner key mismatch: derived ${derived}, state says ${ownerPub}`);
  }

  // Read the owner key from the CHAIN once. The identity must be signed by this
  // key, not by a key the company's database happens to believe in.
  let ownerFromChain = null;
  const readOwnerKey = async () => {
    ownerFromChain ??= await chainOwnerPublicKey({ statePath: STATE_PATH });
    return ownerFromChain;
  };
  const chainOwner = await readOwnerKey();
  check('owner key read from Sepolia matches the recorded owner',
    chainOwner.toLowerCase() === ownerPub.toLowerCase(), chainOwner);

  // A fresh app witness per run. It signs facts; it never touches the owner key.
  const witnessPriv = '0x' + Buffer.from(stark.utils.randomPrivateKey()).toString('hex');
  const witnessPub = stark.getStarkKey(witnessPriv);

  const identity = signIdentity({
    owner: ownerPub,
    purpose: 'Layer D demo: book travel within the owner mandate',
    nonce: '0x' + randomBytes(8).toString('hex'),
    createdAt: Date.now(),
  }, ownerPriv);
  writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2));
  writeFileSync(RUNTIME_PATH, JSON.stringify({
    note: 'Testnet app-witness runtime, written by scripts/demo-layer-d.mjs ' +
      'and read by scripts/agent-act.mjs. The witness key signs the evidence ' +
      'records of this agent only: it can never move funds, and it is not the ' +
      'owner key.',
    agentId: identity.agentId,
    witnessPrivateKey: witnessPriv,
    witnessPublicKey: witnessPub,
    identityPath: IDENTITY_PATH,
    evidencePath: EVIDENCE_PATH,
    ladderPath: LADDER_PATH,
    createdAt: new Date().toISOString(),
  }, null, 2));

  const trust = createTrust({
    identity,
    witnessPrivateKey: witnessPriv,
    evidencePath: EVIDENCE_PATH,
    ladderPath: LADDER_PATH,
    readOwnerKey,
  });

  const client = createClient({
    identity,
    witnessPrivateKey: witnessPriv,
    evidencePath: EVIDENCE_PATH,
    ladderPath: LADDER_PATH,
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

  console.log(`\nagent id: ${identity.agentId}`);
  console.log(`witness:  ${witnessPub}\n`);

  // 1. Cold start: the live mandate would allow 5, but a new agent has not
  // earned any autonomy yet. The door asks, and the proposal is real.
  const cold = await client.execute(spend(5));
  check('cold start asks instead of spending',
    cold.allowed === false && cold.decision.verdict === 'ASK_USER' &&
    cold.decision.code === 'cold-start',
    `${cold.decision.verdict} ${cold.decision.code}`);
  check('cold start leaves a proposal for the owner',
    Boolean(cold.proposal?.id) && cold.proposal.status === 'PENDING',
    cold.proposal?.id ?? 'none');
  check('cold start records the ask, not an execution',
    cold.evidence?.outcome === 'asked', cold.evidence?.outcome ?? 'none');

  // 2. Three sandbox runs. No value moves; the records say so explicitly.
  const sandboxRuns = [];
  for (let i = 1; i <= 3; i += 1) {
    const run = await client.execute(spend(5), { sandbox: true });
    sandboxRuns.push({
      allowed: run.allowed,
      outcome: run.evidence?.outcome ?? null,
      seq: run.evidence?.seq ?? null,
    });
  }
  check('three sandbox runs are allowed and labelled as simulations',
    sandboxRuns.every((r) => r.allowed && r.outcome === 'sandbox-allowed'),
    sandboxRuns.map((r) => `${r.seq}:${r.outcome}`).join(', '));

  // 3. Snapshot the evidence and anchor its fingerprint on-chain.
  const before = await trust.load();
  if (!before.ok) throw new Error(`trust load failed: ${before.error} - ${before.reason}`);
  const evidence = createEvidenceStore({ filePath: EVIDENCE_PATH });
  const records = evidence.list(identity.agentId);
  const root = merkleRoot(records.map(evidenceDigest));
  const count = records.length;
  check('the anchored snapshot covers the ask plus three sandbox runs',
    count === 4 && before.count === count, `count=${count}`);
  check('the root is a 250-bit felt, not prose or a score',
    /^0x[0-9a-f]{64}$/.test(root), root);

  const anchorTx = runOwnerTx([{
    to: registry,
    entrypoint: 'anchor',
    calldata: [identity.agentId, root, String(count)],
  }]);
  check('the owner anchored the root through the GateAccount',
    anchorTx.result.status === 'SUCCEEDED', anchorTx.result.tx_hash);

  const [chainRoot, chainCount] = await call(
    registry, state.selectors.get_anchor, [identity.agentId, gate]);
  const [chainAnchorCount] = await call(
    registry, state.selectors.get_anchor_count, [identity.agentId, gate]);
  check('the chain reads back the same root and count',
    BigInt(chainRoot) === BigInt(root) && Number(BigInt(chainCount)) === count,
    `root=${chainRoot} count=${chainCount}`);
  check('the anchor slot is the GateAccount, and it has one anchor',
    BigInt(chainAnchorCount) === 1n, `anchorCount=${BigInt(chainAnchorCount)}`);

  // 4. The owner signs the promotion, binding it to the anchored snapshot.
  const ladder = createLadderStore({ filePath: LADDER_PATH });
  const promotion = signLadderChange({
    version: 1,
    kind: 'ladder-change',
    agentId: identity.agentId,
    seq: 1,
    from: 'new',
    to: 'probation',
    reason: 'three clean sandbox runs, anchored on-chain',
    evidenceRoot: root,
    evidenceCount: count,
    at: Date.now(),
    owner: ownerPub,
  }, ownerPriv);
  ladder.append(promotion);

  const after = await trust.load();
  check('the owner-signed promotion is accepted and binds the anchored root',
    after.ok && after.stage === 'probation' && after.rejected.length === 0,
    `stage=${after.stage}`);
  check('the ladder change itself is a signed fact with a digest',
    Boolean(promotion.signature?.r) && Boolean(ladderChangeDigest(promotion)),
    ladderChangeDigest(promotion));

  // 5. Probation's limits run BEFORE the domain gate, so the spending gate never
  // falsely quotes GateAccount's cap for a limit the chain does not have.
  await client.loadMandate();
  const within = await client.decide(spend(5));
  const over = await client.decide(spend(6));
  const shared = await client.decide(share('/tmp/itinerary.pdf'));
  check('probation allows 5 per call',
    within.verdict === 'ALLOW', `${within.verdict} ${within.code}`);
  check('probation asks at 6 per call, before the live mandate can answer',
    over.verdict === 'ASK_USER' && over.code === 'ladder-cap',
    `${over.verdict} ${over.code}`);
  check('probation asks before sharing a file',
    shared.verdict === 'ASK_USER' && shared.code === 'ladder-share',
    `${shared.verdict} ${shared.code}`);

  const overlay = trust.overlayPolicies({
    files: { maxDeletesPerDay: 10, shareRequiresApproval: false },
  }, after);
  check('probation narrows deletes to 1/day and sharing to approval',
    overlay.files.maxDeletesPerDay === 1 && overlay.files.shareRequiresApproval === true,
    `deletes=${overlay.files.maxDeletesPerDay} shareApproval=${overlay.files.shareRequiresApproval}`);

  // 6. Tamper with a COPY of the evidence. The original stays intact.
  const original = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'));
  const tampered = JSON.parse(JSON.stringify(original));
  tampered.records[0].facts.context.amount = '9999';
  writeFileSync(TAMPERED_PATH, JSON.stringify(tampered, null, 2));

  const tamperedTrust = createTrust({
    identity,
    witnessPrivateKey: witnessPriv,
    evidencePath: TAMPERED_PATH,
    ladderPath: LADDER_PATH,
    readOwnerKey,
  });
  const tamperedState = await tamperedTrust.load();
  check('editing one record invalidates the whole evidence file',
    tamperedState.ok === false && tamperedState.error === 'evidence-unverified',
    tamperedState.error ?? 'accepted');
  check('the tamper is named, not silently ignored',
    /signature does not verify/.test(tamperedState.reason ?? ''),
    tamperedState.reason ?? 'none');

  // 7. Record the run. The anchor is appended to the live state file so the
  // owner's on-chain history stays with the rest of the deployment record.
  const report = {
    date: new Date().toISOString(),
    network: state.network,
    registry,
    anchorer: gate,
    agentId: identity.agentId,
    identity: {
      purpose: identity.purpose,
      nonce: identity.nonce,
      createdAt: identity.createdAt,
      owner: identity.owner,
    },
    witnessPublicKey: witnessPub,
    witnessRuntimePath: RUNTIME_PATH,
    coldStart: {
      verdict: cold.decision.verdict,
      code: cold.decision.code,
      reason: cold.decision.reason,
      proposalId: cold.proposal?.id ?? null,
      evidenceSeq: cold.evidence?.seq ?? null,
    },
    sandboxRuns,
    evidence: { count, root },
    anchor: {
      txHash: anchorTx.result.tx_hash,
      finality: anchorTx.result.finality,
      readBack: { root: chainRoot, count: Number(BigInt(chainCount)) },
      anchorCount: Number(BigInt(chainAnchorCount)),
    },
    promotion: {
      seq: promotion.seq,
      from: promotion.from,
      to: promotion.to,
      reason: promotion.reason,
      evidenceRoot: promotion.evidenceRoot,
      evidenceCount: promotion.evidenceCount,
      digest: ladderChangeDigest(promotion),
      signature: promotion.signature,
    },
    stageAfterPromotion: after.stage,
    caps: {
      spend5: { verdict: within.verdict, code: within.code },
      spend6: { verdict: over.verdict, code: over.code, reason: over.reason },
      share: { verdict: shared.verdict, code: shared.code, reason: shared.reason },
      overlay: {
        maxDeletesPerDay: overlay.files.maxDeletesPerDay,
        shareRequiresApproval: overlay.files.shareRequiresApproval,
      },
    },
    tamper: {
      ok: tamperedState.ok,
      error: tamperedState.error ?? null,
      reason: tamperedState.reason ?? null,
    },
    checks,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const updated = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  updated.layer_d ??= { anchors: [] };
  updated.layer_d.anchors ??= [];
  updated.layer_d.anchors.push({
    date: report.date,
    agent_id: identity.agentId,
    root,
    count,
    anchorer: gate,
    tx_hash: anchorTx.result.tx_hash,
    promotion_digest: ladderChangeDigest(promotion),
    stage_after_promotion: after.stage,
  });
  writeFileSync(STATE_PATH, JSON.stringify(updated, null, 2));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`report: ${REPORT_PATH}`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) FAILED - the demo is not evidence of the controls.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\ndemo failed:', e?.stack ?? e);
  process.exit(1);
});
