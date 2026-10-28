// The console's server. No framework, no database, no owner key in memory. It
// serves the static page, reads the mandate from Starknet, and turns
// owner-signed resolutions into real owner transactions through the existing
// harness tool (gate-account/tools/owner-tx.mjs).
//
// The trust split this file must preserve:
//   - proposals live in an append-only JSON file (the audit trail)
//   - a proposal is resolved ONLY by a signature that verifies against the owner
//     public key read FROM THE CHAIN (src/proposals.mjs does the verification)
//   - the browser signs; the server never receives the owner private key
//   - before submitting, the server RE-VERIFIES the stored signature against the
//     CURRENT chain key and recomputes the calls from the LIVE mandate - an old
//     approval cannot be replayed against a mandate that has since changed
//
// The résumé (screen 05) follows the same split. The agent's stage is never read
// from a company database: it is recomputed here from the SIGNED records on disk
// and the owner key read from the chain. A ladder change is applied only if the
// browser's signature verifies against that chain key AND the change still binds
// the evidence root that exists right now.
//
// Two last hops live side by side, labelled:
//   - THE RELAY (primary): /api/tx/plan, /api/broadcast, /api/tx/receipt,
//     /api/anchor/plan, /api/anchor/record. The browser signs the TRANSACTION
//     itself (web/tx-signer.js); this server only estimates, then re-checks the
//     finished bytes (sender == GateAccount, signature verifies against the
//     chain-read owner key over the hash of exactly these bytes on this chain)
//     and carries them to the RPC verbatim. No key material touches this file.
//   - THE HARNESS (demo scripts): /api/submit and /api/anchor still spawn
//     owner-tx.mjs, which reads the testnet owner key from
//     gate-account/.sepolia/state.json and submits. Kept for the recorded demo
//     runs; the console screens use the relay.
//   - THE OUTSIDE RELAY (phase 5): /api/outside/plan + /api/outside/submit.
//     The WALLET signs a SNIP-9 OutsideExecution typed data (bound to the
//     wallet_controller the gate names ON CHAIN); this server verifies the
//     signature against the controller's chain-read public key, re-derives the
//     calls from the LIVE mandate, packs the wire calldata FLAT (OBS-16) and
//     submits execute_from_outside_v2 through the deployer account - a gas-only
//     infrastructure key (state.json keys.deployer), never an authority over
//     the mandate. Nothing is recorded as done until a receipt comes back, and
//     an outside submission is only complete when the chain also says the
//     nonce is burned.
//
// Run:  cd permission-core && node web/server.mjs
//       (PORT=4173 by default; binds to 127.0.0.1 only)

import { createServer as createHttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEngine } from '../src/engine.mjs';
import { spendingGate } from '../src/gates/spending.mjs';
import { filesGate } from '../src/gates/files.mjs';
import { call as chainCall, readLiveMandate } from '../src/mandate-reader.mjs';
import {
  chainOwnerPublicKey, createProposalStore, resolutionDigest, verifyOwnerSignature,
} from '../src/proposals.mjs';
import { resolutionToCalls } from '../src/resolutions.mjs';
import { createEvidenceStore, verifyDigest, verifyIdentity } from '../src/evidence.mjs';
import {
  createLadderStore, currentStage, ladderChangeDigest, PROFILES, STAGES,
  suggestNext, summarise, validateLadderChange, validateTransition, verifyLadderChange,
} from '../src/ladder.mjs';
import {
  createAttestationStore, validateWitnessAttestation, verifyRecordsAgainstChain,
  witnessAttestationDigest, witnessChain,
} from '../src/attestations.mjs';
import { chainIdFelt, hashFromBody, selectorFromName } from './tx-signer.js';
import { getMessageHash, shortStringEncode } from './typed-data.js';
import { normalizeWalletSignature } from './wallet.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(HERE);
const DEFAULT_STATE = fileURLToPath(
  new URL('../../gate-account/.sepolia/state.json', import.meta.url));
const DEFAULT_OWNER_TX = fileURLToPath(
  new URL('../../gate-account/tools/owner-tx.mjs', import.meta.url));
const DEFAULT_STORE = join(PKG_ROOT, '.data', 'demo-proposals.json');

const RESOLUTION_TYPES = ['execute-once', 'amend', 'decline'];
const EXECUTABLE = ['APPROVED_ONCE', 'AMENDED'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message) => new HttpError(400, message);
const conflict = (message) => new HttpError(409, message);
const notFound = (message) => new HttpError(404, message);

function asHttpError(e) {
  if (e instanceof HttpError) return e;
  const msg = String(e?.message ?? e);
  if (/^RPC error/i.test(msg) || /fetch failed/i.test(msg)) {
    return new HttpError(502, `Starknet RPC failed: ${msg}`);
  }
  return bad(msg);
}

// ------------------------------------------------------------------ helpers

const jsonSafeReplacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

function sendJson(res, status, body) {
  const text = JSON.stringify(body, jsonSafeReplacer);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('request body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw bad('request body must be a JSON object');
  }
  return parsed;
}

const normHex = (v) => {
  try {
    return '0x' + BigInt(v).toString(16);
  } catch {
    return String(v ?? '').toLowerCase();
  }
};

// A JSON-safe copy of a stage profile: BigInt caps become decimal strings and
// `null` stays null, which means "the live on-chain mandate applies".
function serialiseProfile(profile) {
  return {
    label: profile.label,
    autoSpendPerCall: profile.autoSpendPerCall === null
      ? null : profile.autoSpendPerCall.toString(),
    autoSpendPerWindow: profile.autoSpendPerWindow === null
      ? null : profile.autoSpendPerWindow.toString(),
    maxDeletesPerDay: profile.maxDeletesPerDay,
    canShare: profile.canShare,
  };
}

function findPackageDir(name, startDir) {
  let dir = realpathSync(startDir);
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate package '${name}' from ${startDir}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------------------ server

// Exported for testing: resolves a controller's public key across account
// generations (OZ get_public_key → Ready X get_owner+get_owner_type). The
// caller supplies the chain-call function so the logic is provable with zero
// network (OBS-08). selectorFn may return a BigInt (tx-signer.js's
// selectorFromName does); every selector is put on the wire as a hex string,
// because JSON.stringify throws on BigInt - the seam that silently killed this
// fallback on the live Ready X controller (2026-10-26 live pass).
const wireSelector = (v) => '0x' + BigInt(v).toString(16);
export async function resolveControllerPublicKey(callFn, controller, getPublicKeySelector, selectorFn) {
  try {
    return await callFn(controller, getPublicKeySelector, []);
  } catch { /* fall through to get_owner */ }
  const [ownerType] = await callFn(controller, wireSelector(selectorFn('get_owner_type')), []);
  if (BigInt(ownerType) !== 0n) {
    throw new Error(`controller ${controller}'s owner is signer type ${ownerType}, ` +
      'not Starknet (0) - the server cannot pre-verify against it');
  }
  return callFn(controller, wireSelector(selectorFn('get_owner')), []);
}

export function createConsoleServer(options = {}) {
  const statePath = options.statePath ?? DEFAULT_STATE;
  const storePath = options.storePath ?? DEFAULT_STORE;
  const ownerTxPath = options.ownerTxPath ?? DEFAULT_OWNER_TX;
  const webDir = options.webDir ?? HERE;
  const submissionsPath = options.submissionsPath ?? join(dirname(storePath), 'submissions.json');

  // Layer D's signed records. These are the agent's history: an identity signed
  // by the owner, evidence signed by the app witness, ladder changes signed by
  // the owner. Defaults point at the live demo run so the console shows the
  // real agent, not a fixture.
  const identityPath = options.identityPath
    ?? join(PKG_ROOT, '.data', 'demo-layer-d-identity.json');
  const evidencePath = options.evidencePath
    ?? join(PKG_ROOT, '.data', 'demo-layer-d-evidence.json');
  const ladderPath = options.ladderPath
    ?? join(PKG_ROOT, '.data', 'demo-layer-d-ladder.json');
  // Witness attestations (Track 3): owner-signed statements of WHICH key spoke
  // for the app WHEN. Stored with the signed records, off-chain, like everything
  // else in the hybrid model. No file / empty chain = the legacy single-witness
  // behavior, unchanged.
  const attestationPath = options.attestationPath
    ?? join(PKG_ROOT, '.data', 'demo-layer-d-attestations.json');

  const readMandate = options.readMandate ?? (() => readLiveMandate(statePath));
  const readOwnerKey = options.readOwnerKey ?? (() => chainOwnerPublicKey({ statePath }));
  const submitCalls = options.submitCalls ?? ((calls) => runOwnerTx(ownerTxPath, calls));
  // Every chain read the server makes dies loudly after this many milliseconds
  // instead of hanging forever (OBS-35: a silent node once froze the console's
  // "Read again" mid-spin). Injectable so tests can prove the bounded failure.
  const RPC_TIMEOUT_MS = options.rpcTimeoutMs ?? 20_000;
  // Injectable so tests never touch the network, exactly like readMandate.
  const readAnchor = options.readAnchor ?? ((agentId) => readRegistryAnchor(agentId));
  // The relay trio. Defaults use the harness (owner-tx --dry-run for the estimate)
  // and plain JSON-RPC for carrying the finished transaction and reading receipts.
  // Tests inject all three, so the relay controls are proven without a network.
  const dryRunEstimate = options.dryRunEstimate
    ?? ((calls) => runOwnerTxDryRun(ownerTxPath, calls));
  const sendTransaction = options.sendTransaction
    ?? ((body) => rpcCall(loadState().rpc_endpoints_verified.cartridge.url,
      'starknet_addInvokeTransaction', { invoke_transaction: body },
      { timeoutMs: RPC_TIMEOUT_MS }));
  const readReceipt = options.readReceipt
    ?? ((hash) => rpcCall(loadState().rpc_endpoints_verified.cartridge.url,
      'starknet_getTransactionReceipt', { transaction_hash: hash },
      { timeoutMs: RPC_TIMEOUT_MS }));
  // The transaction itself, for the wallet-submitted path (OBS-31): the record
  // is parsed from THE CHAIN's copy of the calldata, never from the request.
  const readTransaction = options.readTransaction
    ?? ((hash) => rpcCall(loadState().rpc_endpoints_verified.cartridge.url,
      'starknet_getTransactionByHash', { transaction_hash: hash },
      { timeoutMs: RPC_TIMEOUT_MS }));
  // The gate's CURRENT class hash, for the owner-action upgrade path (the v0.4
  // install): the replay control there is the chain itself - a planned upgrade
  // is refused the moment the chain says the class already runs. Injectable
  // like every other chain read (OBS-08).
  const readClassHash = options.readClassHash
    ?? (async (gate) => {
      const ans = await rpcCall(loadState().rpc_endpoints_verified.cartridge.url,
        'starknet_getClassHashAt', { block_id: 'latest', contract_address: gate },
        { timeoutMs: RPC_TIMEOUT_MS });
      if (ans?.error) {
        throw new Error(ans.error?.message ?? JSON.stringify(ans.error));
      }
      return ans.result;
    });

  // Phase 5: the outside-execution relay. Every chain read and the submitter
  // itself are injectable, so the controls are provable with zero network
  // (OBS-08), exactly like readMandate/dryRunEstimate above. Selectors come
  // from the state file's recorded set (verified from three independent
  // sources at stage 1) - never retyped, never re-derived here.
  const readController = options.readController
    ?? ((gate) => chainCall(gate, loadState().selectors.get_wallet_controller, []));
  const readControllerPublicKey = options.readControllerPublicKey
    ?? ((controller) => resolveControllerPublicKey(
      chainCall, controller, loadState().selectors.get_public_key, selectorFromName));
  // Direct get_public_key probe for /api/chain/key: WHICH getter answered
  // decides the signature shape the browser should expect, so the endpoint
  // reports it. Injectable like every other chain read (OBS-08).
  const readPublicKey = options.readPublicKey
    ?? ((addr) => chainCall(addr, loadState().selectors.get_public_key, []));
  const readOutsideNonce = options.readOutsideNonce
    ?? ((gate, nonce) => chainCall(
      gate, loadState().selectors.is_valid_outside_execution_nonce, [nonce]));
  // The relayer: the deployer account, a GAS-ONLY infrastructure key (documented
  // in state.json; it is not the owner and holds no mandate authority). The
  // pattern mirrors gate-account/tools/migrate-v3.mjs --outside, proven live on
  // 2026-10-25: starknet.js estimate with NATIVE BigInt bounds padded in place
  // (OBS-10), wire calldata already packed FLAT by the caller (OBS-16).
  const relayOutside = options.relayOutside ?? (async ({ gate, wireCalldata }) => {
    const state = loadState();
    const deployer = state.keys?.deployer;
    if (!deployer?.address || !deployer?.private_key) {
      throw new Error('the state file records no deployer key - the outside ' +
        'relay needs its gas-only account to submit execute_from_outside_v2');
    }
    const sn = await import('starknet');
    const provider = new sn.RpcProvider({
      nodeUrl: state.rpc_endpoints_verified.cartridge.url,
    });
    const account = new sn.Account({
      provider,
      address: deployer.address,
      signer: new sn.Signer(deployer.private_key),
      cairoVersion: '1',
    });
    const calls = [{
      contractAddress: gate,
      entrypoint: 'execute_from_outside_v2',
      calldata: wireCalldata,
    }];
    const nonce = await provider.getNonceForAddress(deployer.address);
    const est = await account.estimateInvokeFee(calls, { nonce });
    const rb = est.resourceBounds;
    rb.l2_gas.max_amount = BigInt(rb.l2_gas.max_amount) * 3n;
    rb.l1_data_gas.max_amount = BigInt(rb.l1_data_gas.max_amount) * 2n;
    const tx = await account.execute(calls, { nonce, resourceBounds: rb });
    return { transaction_hash: tx.transaction_hash, relayer: deployer.address };
  });

  const engine = createEngine();
  engine.registerGate(spendingGate);
  engine.registerGate(filesGate);

  const store = createProposalStore({
    filePath: storePath,
    getOwnerPublicKey: readOwnerKey,
    // The chain and the account are what a typed-data signature is bound to. Read
    // them at verification time, never from the request.
    getSignatureContext: async () => {
      const state = loadState();
      return {
        kind: 'resolution',
        accountAddress: state.contracts.gate_account.address,
        chainId: state.chain_id,
      };
    },
  });

  const vendorRoots = options.vendorRoots ?? (() => {
    const scure = findPackageDir('@scure/starknet', PKG_ROOT);
    const curves = findPackageDir('@noble/curves', scure);
    const hashes = findPackageDir('@noble/hashes', scure);
    return { scure, curves, hashes };
  })();
  let vendorCache = null;

  function loadState() {
    if (!existsSync(statePath)) {
      throw new HttpError(500, `state file not found: ${statePath}`);
    }
    return JSON.parse(readFileSync(statePath, 'utf8'));
  }

  function loadSubmissions() {
    if (!existsSync(submissionsPath)) return { submissions: [] };
    return JSON.parse(readFileSync(submissionsPath, 'utf8'));
  }
  function saveSubmission(record) {
    const db = loadSubmissions();
    db.submissions.push(record);
    mkdirSync(dirname(submissionsPath), { recursive: true });
    writeFileSync(submissionsPath, JSON.stringify(db, null, 2));
  }
  // The relay saves 'BROADCAST' when the node accepts the bytes; the FINAL status
  // is only ever written from a receipt read back from the chain, never from us.
  function updateSubmission(txHash, patch) {
    const db = loadSubmissions();
    const target = [...db.submissions]
      .reverse()
      .find((s) => s.tx_hash && normHex(s.tx_hash) === normHex(txHash));
    if (!target) return null;
    Object.assign(target, patch);
    writeFileSync(submissionsPath, JSON.stringify(db, null, 2));
    return target;
  }

  // ---------------------------------------------------------- Layer D: résumé

  // Recompute the agent's trust state from the SIGNED records. This is a read:
  // it cannot move anyone. Every layer of trust is checked again here, because a
  // file on disk is not proof - the signatures are.
  //
  // tolerateWitnessMismatch is for the witness endpoints ONLY: an uncovered
  // record is exactly the state an attestation REPAIRS, so preview/attest must
  // still see the owner, the records and the verified chain. The refusal then
  // rides along WITH the full view instead of replacing it. Every other refusal
  // (identity, evidence, ladder, a broken attestation chain) stays a hard stop.
  async function loadTrustView(options = {}) {
    const tolerateWitnessMismatch = options.tolerateWitnessMismatch === true;
    if (!existsSync(identityPath)) {
      return {
        ok: false,
        error: 'no-identity',
        reason: 'no agent identity has been recorded yet - the Layer D demo ' +
          '(scripts/demo-layer-d.mjs) creates one',
      };
    }

    let identity;
    try {
      identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    } catch (e) {
      return {
        ok: false,
        error: 'identity-unreadable',
        reason: `the identity file is not valid JSON: ${e.message}`,
      };
    }
    const brief = {
      agentId: identity.agentId ?? null,
      owner: identity.owner ?? null,
      purpose: identity.purpose ?? null,
      nonce: identity.nonce ?? null,
      createdAt: identity.createdAt ?? null,
    };

    let owner;
    try {
      owner = await readOwnerKey();
    } catch (e) {
      return {
        ok: false,
        error: 'owner-unreadable',
        reason: `the owner key could not be read from the chain: ${e.message}`,
        identity: brief,
      };
    }
    if (!verifyIdentity(identity, owner)) {
      return {
        ok: false,
        error: 'identity-unverified',
        reason: 'the agent identity is not signed by the owner key the chain reports',
        identity: brief,
      };
    }

    const evidence = createEvidenceStore({ filePath: evidencePath });
    const evidenceCheck = evidence.verifyAll();
    if (!evidenceCheck.ok) {
      return {
        ok: false,
        error: 'evidence-unverified',
        reason: `the evidence file failed verification: ${evidenceCheck.errors.join('; ')}`,
        identity: brief,
      };
    }
    const records = evidence.list(identity.agentId);

    // The typed-data contexts a BROWSER WALLET signature binds to, read at
    // verification time - never from the request. One per owner-signed kind.
    const stateForSignatures = loadState();
    const ladderContext = {
      kind: 'ladder-change',
      accountAddress: stateForSignatures.contracts.gate_account.address,
      chainId: stateForSignatures.chain_id,
    };
    const attestationContext = {
      kind: 'witness-attestation',
      accountAddress: stateForSignatures.contracts.gate_account.address,
      chainId: stateForSignatures.chain_id,
    };

    // Witness verification (Track 3). With an owner-signed attestation chain:
    // the chain itself must walk unbroken, and EVERY record must be signed by
    // the key attested as in effect WHEN THE RECORD WAS MADE - an honest key
    // rotation reads as legitimate history, an uncovered record is a named
    // refusal. Without a chain: exactly the old behavior - one witness across
    // all records passes silently, two or more are surfaced for the screen to
    // shout about (pinned by tests/resume.test.mjs).
    const attestationStore = createAttestationStore({
      filePath: attestationPath, context: attestationContext,
    });
    const attestations = attestationStore.list(identity.agentId);
    let witnessHistory = [];
    let witnessMismatch = null;
    if (attestations.length > 0) {
      const chain = witnessChain({
        agentId: identity.agentId, attestations, ownerPublicKey: owner,
        context: attestationContext,
      });
      if (!chain.ok) {
        const rej = chain.rejected[0];
        return {
          ok: false,
          error: 'witness-chain-unverified',
          reason: `the witness attestation chain is broken at seq ${rej.attestation.seq}: ${rej.reason}`,
          identity: brief,
        };
      }
      const recCheck = verifyRecordsAgainstChain(records, chain);
      if (!recCheck.ok) {
        if (!tolerateWitnessMismatch) {
          return {
            ok: false,
            error: 'evidence-witness-mismatch',
            reason: recCheck.uncovered.reason,
            identity: brief,
          };
        }
        witnessMismatch = recCheck.uncovered.reason;
      }
      witnessHistory = chain.witnesses;
    }

    const ladder = createLadderStore({ filePath: ladderPath, context: ladderContext });
    const ladderCheck = ladder.verifyAll();
    if (!ladderCheck.ok) {
      return {
        ok: false,
        error: 'ladder-unverified',
        reason: `the ladder file failed verification: ${ladderCheck.errors.join('; ')}`,
        identity: brief,
      };
    }
    const changes = ladder.list(identity.agentId);
    const stageState = currentStage({
      agentId: identity.agentId, changes, ownerPublicKey: owner, records,
      context: ladderContext,
    });
    const summary = summarise(records);
    const profile = PROFILES[stageState.stage];

    return {
      ok: witnessMismatch === null,
      ...(witnessMismatch === null
        ? {}
        : { error: 'evidence-witness-mismatch', reason: witnessMismatch }),
      identity,
      owner,
      stage: stageState.stage,
      stageLabel: profile.label,
      profile: serialiseProfile(profile),
      summary,
      records,
      // Every distinct key that signed these records. Two or more WITHOUT an
      // attestation chain explaining the rotation is a contradiction the screen
      // must shout about; WITH a chain it is legitimate, owner-signed history.
      witnesses: [...new Set(records.map((r) => r.witness))],
      // The owner-signed witness history: who spoke for the app, from when, and
      // why. Empty when no attestations exist (the legacy single-witness case).
      witnessHistory,
      changes: changes.map((c) => ({
        ...c,
        digest: ladderChangeDigest(c),
        verified: verifyLadderChange(c, owner, ladderContext),
      })),
      applied: stageState.applied.map((c) => c.seq),
      rejected: stageState.rejected.map((r) => ({
        seq: r.change?.seq ?? null,
        reason: r.reason,
      })),
      root: evidence.root(identity.agentId),
      count: records.length,
      suggestion: suggestNext(stageState.stage, summary),
      transitions: STAGES.filter((s) => validateTransition(stageState.stage, s).ok),
    };
  }

  // The on-chain half: what the registry says about this agent's fingerprint,
  // read fresh. A failure here is reported, never swallowed - the screen shows
  // "the chain did not answer" instead of pretending there is no anchor.
  async function readRegistryAnchor(agentId) {
    const state = loadState();
    const registry = state.contracts?.evidence_registry?.address ?? null;
    const anchorer = state.contracts?.gate_account?.address ?? null;
    const selectors = state.selectors ?? {};
    if (!registry || !selectors.get_anchor || !selectors.get_anchor_count) {
      return {
        available: false,
        registry,
        anchorer,
        error: 'the state file records no EvidenceRegistry address or selectors',
      };
    }
    try {
      const [root, count] = await chainCall(
        registry, selectors.get_anchor, [agentId, anchorer]);
      const [anchorCount] = await chainCall(
        registry, selectors.get_anchor_count, [agentId, anchorer]);
      const recorded = [...(state.layer_d?.anchors ?? [])]
        .reverse().find((a) => normHex(a.agent_id) === normHex(agentId)) ?? null;
      return {
        available: true,
        registry,
        anchorer,
        root,
        count: Number(BigInt(count)),
        anchorCount: Number(BigInt(anchorCount)),
        recordedTx: recorded?.tx_hash ?? null,
        recordedAt: recorded?.date ?? null,
        error: null,
      };
    } catch (e) {
      return {
        available: false,
        registry,
        anchorer,
        error: String(e?.message ?? e),
      };
    }
  }

  async function buildResume() {
    const trust = await loadTrustView();
    const generatedAt = Date.now();
    if (!trust.ok) return { ...trust, generatedAt };

    const { records, ...rest } = trust;
    const anchor = await readAnchor(trust.identity.agentId);
    const matchesRoot = anchor.available
      ? BigInt(anchor.root) === BigInt(trust.root) : null;
    const matchesCount = anchor.available
      ? anchor.count === trust.count : null;

    return {
      ...rest,
      anchor: { ...anchor, matchesRoot, matchesCount },
      recent: records.slice(-10).map((r) => ({
        seq: r.seq,
        at: r.at,
        action: r.action,
        outcome: r.outcome,
        code: r.facts?.code ?? null,
        reason: r.facts?.reason ?? null,
        amount: r.facts?.context?.amount ?? null,
        recipient: r.facts?.context?.recipient ?? null,
      })),
      generatedAt,
    };
  }

  // Append an anchor to the live deployment record - the same place the Layer D
  // demo writes it. The file is re-read immediately before writing so a
  // concurrent writer is not clobbered.
  function recordAnchor(entry) {
    const current = JSON.parse(readFileSync(statePath, 'utf8'));
    current.layer_d ??= {};
    current.layer_d.anchors ??= [];
    current.layer_d.anchors.push(entry);
    writeFileSync(statePath, JSON.stringify(current, null, 2));
  }

  // Build the exact unsigned ladder change the owner will sign. The server
  // chooses every field that could otherwise be lied about - seq, the evidence
  // root and count, and the owner key - so the browser signs facts, not a form.
  function buildLadderChange(trust, body) {
    const to = String(body?.to ?? '');
    const reason = String(body?.reason ?? '').trim();
    if (!STAGES.includes(to)) {
      throw bad(`unknown stage '${to}' - expected one of: ${STAGES.join(', ')}`);
    }
    if (trust.stage !== body?.from) {
      throw conflict(`the agent is '${trust.stage}', not '${body?.from}' - ` +
        'read the résumé again before signing');
    }
    const transition = validateTransition(trust.stage, to);
    if (!transition.ok) throw conflict(transition.reason);
    if (reason.length < 5) {
      throw bad('the reason must be a plain sentence (at least 5 characters)');
    }
    if (trust.count === 0) {
      throw conflict('a ladder change must bind at least one signed record; ' +
        'this agent has none yet, so there is nothing to promote it on');
    }
    return {
      version: 1,
      kind: 'ladder-change',
      agentId: trust.identity.agentId,
      seq: trust.changes.length + 1,
      from: trust.stage,
      to,
      reason,
      evidenceRoot: trust.root,
      evidenceCount: trust.count,
      at: Date.now(),
      owner: trust.owner,
    };
  }

  // Build the exact unsigned witness attestation the owner will sign (Track 3).
  // Like the ladder preview: the server chooses every field that could otherwise
  // be lied about - the agent, the seq, the key being superseded, the timestamps
  // and the owner key - so the browser signs facts, not a form. The first
  // attestation may backdate validFrom to the earliest record so the history the
  // app already has stays covered; a rotation takes effect from the named time.
  function buildWitnessAttestation(trust, body) {
    const reason = String(body?.reason ?? '').trim();
    if (reason.length < 5) {
      throw bad('the reason must be a plain sentence (at least 5 characters)');
    }
    const chain = trust.witnessHistory ?? [];
    const current = chain.length > 0 ? chain[chain.length - 1].witness : null;

    let witness = String(body?.witness ?? '').trim();
    if (!witness) {
      // No explicit key: attest the ONE witness the records already carry (when
      // they all agree) - the natural "make what is already true official"
      // first attestation. Anything else must be named explicitly.
      if (current || trust.witnesses.length !== 1) {
        throw bad('name the witness key this attestation vouches for');
      }
      witness = trust.witnesses[0];
    }
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(witness)) {
      throw bad('the witness must be a 0x-prefixed hex public key');
    }
    if (current && normHex(witness) === normHex(current)) {
      throw conflict('that key is already the current attested witness - ' +
        'nothing to rotate');
    }

    const earliest = trust.records.length > 0
      ? Math.min(...trust.records.map((rec) => Number(rec.at))) : null;
    let validFrom = Date.now();
    if (body?.validFrom !== undefined && body?.validFrom !== null && body?.validFrom !== '') {
      validFrom = Number(body.validFrom);
      if (!Number.isInteger(validFrom) || validFrom <= 0) {
        throw bad('validFrom must be a positive whole number of milliseconds');
      }
    } else if (!current && earliest !== null) {
      validFrom = earliest; // cover every record that already exists
    }
    if (validFrom > Date.now()) {
      throw bad('an attestation cannot be valid from a future time');
    }
    const lastValidFrom = chain.length > 0 ? chain[chain.length - 1].validFrom : null;
    if (lastValidFrom !== null && validFrom < lastValidFrom) {
      throw conflict(`validFrom ${validFrom} is before the current attestation's ` +
        `${lastValidFrom} - time must move forward`);
    }

    return {
      version: 1,
      kind: 'witness-attestation',
      agentId: trust.identity.agentId,
      seq: chain.length + 1,
      witness: normHex(witness),
      supersedes: current,
      validFrom,
      reason,
      at: Date.now(),
      owner: trust.owner,
    };
  }

  // An attestation must never orphan the records that exist: simulate the chain
  // with the new link appended and require EVERY signed record to still be
  // covered by the attestation in effect when it was made. Same philosophy as
  // the ladder's evidence-root binding - checked at preview AND re-checked at
  // apply, because the records can grow in between.
  function checkAttestationCoverage(trust, attestation) {
    const hypothetical = {
      witnesses: [
        ...(trust.witnessHistory ?? []),
        {
          witness: normHex(attestation.witness),
          validFrom: Number(attestation.validFrom),
          seq: Number(attestation.seq),
          reason: attestation.reason,
          supersedes: attestation.supersedes ?? null,
        },
      ],
    };
    const check = verifyRecordsAgainstChain(trust.records, hypothetical);
    if (!check.ok) {
      throw conflict(`this attestation would leave signed records uncovered - ` +
        check.uncovered.reason);
    }
  }

  async function chainStatus(rpcUrl) {
    const rpc = async (method) => {
      let res;
      try {
        res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
        });
      } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
          throw new Error(`the chain node did not answer within ${RPC_TIMEOUT_MS / 1000}s - ` +
            'the read failed loudly instead of hanging');
        }
        throw e;
      }
      const json = await res.json();
      if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
      return json.result;
    };
    const [chainId, blockNumber] = await Promise.all([
      rpc('starknet_chainId'),
      rpc('starknet_blockNumber'),
    ]);
    return { chainId, blockNumber };
  }

  function validateResolution(resolution) {
    if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) {
      throw bad('resolution must be an object');
    }
    if (!RESOLUTION_TYPES.includes(resolution.type)) {
      throw bad(`unknown resolution type '${resolution.type}' - expected one of: ` +
        RESOLUTION_TYPES.join(', '));
    }
    if (resolution.type === 'amend') {
      const a = resolution.amendment;
      if (!a || typeof a !== 'object') throw bad("an 'amend' resolution needs an amendment");
      if (!['raise-per-call-cap', 'raise-window-cap', 'allow-recipient'].includes(a.kind)) {
        throw bad(`unknown amendment kind '${a.kind}'`);
      }
    }
  }

  function parseAgentRequest(body, state, mandate) {
    const recipient = String(body.recipient ?? '').trim();
    const amount = String(body.amount ?? '').trim();
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(recipient)) {
      throw bad('recipient must be a 0x-prefixed hex address');
    }
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      throw bad('amount must be a positive whole number of mock token units');
    }
    return {
      user: `user:${state.keys.owner.address}`,
      agent: `agent:${state.keys.agent_session.session_public_key}`,
      action: 'spend:transfer',
      resource: `token:${mandate.token}`,
      context: {
        recipient,
        amount,
        token: mandate.token,
        now: Math.floor(Date.now() / 1000),
      },
    };
  }

  async function buildPreview(proposalId, resolution) {
    validateResolution(resolution);
    if (!proposalId || typeof proposalId !== 'string') throw bad('proposalId is required');
    const proposal = store.get(proposalId);
    if (!proposal) throw notFound(`no proposal '${proposalId}'`);
    if (proposal.status !== 'PENDING') {
      throw conflict(`proposal '${proposalId}' is already ${proposal.status} - ` +
        'only a pending proposal can be previewed for a new resolution');
    }

    const digest = store.digestFor(proposalId, resolution);
    let calls = [];
    let sideEffects = [];
    if (resolution.type === 'decline') {
      sideEffects = ['the block stands; nothing goes on-chain; the agent gains nothing'];
    } else {
      const state = loadState();
      const mandate = await readMandate();
      const probe = {
        ...proposal,
        status: resolution.type === 'execute-once' ? 'APPROVED_ONCE' : 'AMENDED',
        resolution,
      };
      const out = resolutionToCalls(probe, {
        gateAddress: state.contracts.gate_account.address,
        sessionPublicKey: mandate.sessionPublicKey,
        currentPolicy: mandate,
      });
      calls = out.calls;
      sideEffects = out.sideEffects;
    }
    return { proposal, resolution, digest, calls, sideEffects };
  }

  // ------------------------------------------------------------- relay: plan
  // The relay never builds a transaction body and never signs. It prices one:
  // the estimate (nonce + padded resource bounds) comes from the harness dry-run,
  // and the browser signs over EXACTLY these numbers, so what was priced is what
  // goes to the chain. Everything identity-ish comes from the state file, and the
  // chain id felt is computed from the label, then cross-checked against the hex
  // the state file records - the file must not disagree with itself.
  function relayContext() {
    const state = loadState();
    const gate = state.contracts?.gate_account?.address ?? null;
    if (!gate) throw conflict('the state file records no GateAccount address');
    const label = state.chain_id ?? null;
    if (!label) throw conflict('the state file records no chain id');
    const chainId = chainIdFelt(label);
    if (state.chain_id_hex != null
      && normHex(state.chain_id_hex) !== normHex(chainId)) {
      throw conflict(`the state file disagrees with itself about the chain id: ` +
        `label '${label}' computes to ${chainId} but chain_id_hex records ` +
        `${state.chain_id_hex} - refusing to plan for an ambiguous chain`);
    }
    return { state, gate, label, chainId };
  }

  async function planForCalls(calls, extra = {}) {
    const { gate, label, chainId } = relayContext();
    let estimate;
    try {
      estimate = await dryRunEstimate(calls);
    } catch (e) {
      throw new HttpError(502, `the fee estimate failed: ${e.message}`);
    }
    return {
      ...extra,
      calls,
      sender: gate,
      chainId: label,
      chainIdFelt: chainId,
      nonce: estimate.nonce,
      resourceBounds: estimate.resourceBounds,
      estimateSource: 'gate-account/tools/owner-tx.mjs --dry-run ' +
        '(estimate only - nothing was signed and nothing was sent)',
    };
  }

  // ------------------------------------------------------- relay: outside (phase 5)
  // The wallet path. Same trust split as /api/tx/plan + /api/broadcast, but the
  // wallet never signs OUR transaction - it signs a SNIP-9 OutsideExecution
  // typed data (binding finding: a wallet hashes with its OWN address), and a
  // third party (our gas-only deployer key) carries execute_from_outside_v2.
  // The gate verifies the signature itself, by delegating to the
  // wallet_controller named ON CHAIN - so every identity field here is read
  // from the chain, never from the request.

  const hexBig = (v) => '0x' + BigInt(v).toString(16);
  // A starknet_call answer is an array of felts; 'true' is any nonzero first felt.
  const feltTrue = (out) => BigInt((Array.isArray(out) ? out[0] : out) ?? 0) !== 0n;
  const ANY_CALLER_FELT = hexBig(shortStringEncode('ANY_CALLER'));

  // The guard block both outside endpoints run FIRST - the same checks
  // /api/tx/plan runs before pricing anything: the proposal must be executable,
  // must not already have a final submission, and its approval must still
  // verify against the owner key on chain RIGHT NOW. The calls are recomputed
  // from the LIVE mandate; a stale intent throws instead of being relayed.
  // opts.verifyApplied (RECORD PATH ONLY, OBS-36): when the amendment's target
  // already equals the live policy, the transaction being recorded IS the
  // amendment - the derivation expects exactly the live values instead of
  // refusing a "pointless" change. plan/wire/submit call this WITHOUT the flag,
  // so a pointless cap change can never be signed or authorized again.
  async function outsideGuardedProposal(body, opts = {}) {
    if (!body.proposalId || typeof body.proposalId !== 'string') {
      throw bad('proposalId is required');
    }
    const proposal = store.get(body.proposalId);
    if (!proposal) throw notFound(`no proposal '${body.proposalId}'`);
    if (!EXECUTABLE.includes(proposal.status)) {
      throw conflict(`proposal '${proposal.id}' is ${proposal.status} - only an ` +
        'approved-once or amended proposal has calls to authorize');
    }
    const prior = loadSubmissions().submissions
      .filter((s) => s.proposalId === proposal.id);
    const final = prior.find((s) => s.status === 'SUCCEEDED' || s.status === 'REVERTED');
    if (final) {
      throw conflict(`proposal '${proposal.id}' already went to the chain ` +
        `(${final.status}${final.tx_hash ? `, tx ${final.tx_hash}` : ''}) - ` +
        'refusing a second outside submission');
    }
    const currentOwner = await readOwnerKey();
    if (proposal.ownerPublicKeyAtResolution
      && normHex(proposal.ownerPublicKeyAtResolution) !== normHex(currentOwner)) {
      throw conflict('the owner key on chain has changed since this approval was ' +
        'signed - refusing to act on an approval the current owner did not sign');
    }
    const state = loadState();
    const resolutionContext = {
      kind: 'resolution',
      accountAddress: state.contracts.gate_account.address,
      chainId: state.chain_id,
    };
    const digest = resolutionDigest(proposal, proposal.resolution);
    if (!verifyOwnerSignature(digest, proposal.signature, currentOwner, resolutionContext)) {
      throw conflict('the stored signature no longer verifies against the current ' +
        'owner key - refusing to act on it');
    }
    const mandate = await readMandate();
    let converted;
    try {
      converted = resolutionToCalls(proposal, {
        gateAddress: state.contracts.gate_account.address,
        sessionPublicKey: mandate.sessionPublicKey,
        currentPolicy: mandate,
        verifyApplied: opts.verifyApplied === true,
      });
    } catch (e) {
      throw conflict(`cannot build the on-chain call: ${e.message}`);
    }
    return {
      proposal,
      digest,
      state,
      calls: converted.calls,
      sideEffects: converted.sideEffects,
    };
  }

  // The anchor purpose's guard - the SAME checks /api/anchor/plan runs before
  // pricing anything, so both anchor paths share one definition of "there is a
  // new fingerprint to anchor": the trust state must verify from the signed
  // records, the registry address must be recorded, and the chain must not
  // already hold this exact fingerprint. The calls are rebuilt here on EVERY
  // request, so at submit time a stale authorization is compared against the
  // LIVE trust state - the anchor twin of outsideGuardedProposal's recompute.
  async function outsideGuardedAnchor() {
    const trust = await loadTrustView();
    if (!trust.ok) {
      throw conflict(`the agent's trust state cannot be read: ${trust.reason}`);
    }
    if (trust.count === 0) {
      throw conflict('there is no evidence to anchor yet - the agent has no records');
    }
    const state = loadState();
    const registry = state.contracts?.evidence_registry?.address ?? null;
    if (!registry) {
      throw conflict('the state file records no EvidenceRegistry address');
    }
    const existing = await readAnchor(trust.identity.agentId);
    if (existing.available && BigInt(existing.root) === BigInt(trust.root)
      && existing.count === trust.count) {
      throw conflict('this exact fingerprint is already on chain - there is ' +
        'nothing new to anchor');
    }
    const calls = [{
      to: registry,
      entrypoint: 'anchor',
      calldata: [trust.identity.agentId, trust.root, String(trust.count)],
    }];
    return {
      state,
      calls,
      agentId: trust.identity.agentId,
      root: trust.root,
      count: trust.count,
      existing, // the raw registry read; /api/anchor uses its anchorer field
    };
  }

  // The controller THE CHAIN names on the gate. Everything about signer
  // identity flows from this read; a zero (unregistered) controller means the
  // gate cannot validate any outside signature at all.
  async function outsideController(state) {
    const gate = state.contracts?.gate_account?.address ?? null;
    if (!gate) throw conflict('the state file records no GateAccount address');
    let out;
    try {
      out = await readController(gate);
    } catch (e) {
      throw new HttpError(502, `the controller read failed: ${e.message}`);
    }
    const controller = Array.isArray(out) ? out[0] : out;
    if (!controller || BigInt(controller) === 0n) {
      throw conflict('the gate names no wallet controller on chain - outside ' +
        'execution needs one registered (gate-account/tools/wallet-controller.mjs)');
    }
    return { gate, controller };
  }

  // A fresh SNIP-9 nonce, verified UNUSED on chain. The contract's own
  // duplicated-nonce assert stays authoritative; this read just fails fast
  // with an honest message instead of a paid revert.
  async function drawUnusedOutsideNonce(gate) {
    let nonce = null;
    for (let attempt = 0; attempt < 3 && nonce === null; attempt += 1) {
      const candidate = hexBig(
        BigInt('0x' + randomBytes(16).toString('hex')) % (2n ** 128n));
      try {
        if (feltTrue(await readOutsideNonce(gate, candidate))) nonce = candidate;
      } catch (e) {
        throw new HttpError(502, `the nonce read failed: ${e.message}`);
      }
    }
    if (!nonce) {
      throw conflict('could not draw an unused outside-execution nonce from ' +
        'the chain - refusing to plan with one that might already be burned');
    }
    return nonce;
  }

  // The two purposes' wording, kept in one place so the shared controls below
  // can speak about "this approval" or "this anchor" without branching logic.
  const OUTSIDE_TEXTS = {
    proposal: {
      calls: 'this approval on the LIVE mandate',
      produces: 'this approval produces on the live mandate',
    },
    anchor: {
      calls: 'this anchor on the LIVE trust state',
      produces: 'this anchor produces on the live trust state',
    },
  };

  // Controls 1-4 of the outside relay, shared VERBATIM by both purposes so
  // neither can drift from the other. Every field of the signed message is
  // compared against a source the request does not control: the chain-named
  // controller, this chain's label, the calls recomputed live by the caller's
  // guard, the recorded selector set, the open window, the chain-read nonce
  // and the controller's chain-read key. The authoritative signature check
  // remains the gate's delegation to the controller's is_valid_signature; this
  // is the pre-flight that refuses bad bytes before anyone pays gas.
  async function verifyOutsideAuthorization({
    auth, expectedCalls, state, gate, controller, label, texts,
  }) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      throw bad('authorization is required: the signed SNIP-9 envelope ' +
        '(scheme, r, s, typedData) the wallet produced');
    }
    if (auth.scheme !== 'wallet-snip12-src9' && auth.scheme !== 'snip12-src9') {
      throw bad(`unknown authorization scheme '${auth.scheme}' - expected ` +
        'wallet-snip12-src9 (native wallet) or snip12-src9');
    }
    if (!auth.r || !auth.s) {
      throw bad('the authorization carries no signature - the relay only ' +
        'carries wallet-signed authorizations');
    }
    // The FULL signature array the wallet produced (concise or standard).
    // The gate calls the controller's is_valid_signature with exactly this,
    // so the wire must carry it verbatim — not just the owner's r/s.
    const rawSignature = Array.isArray(auth.signature) && auth.signature.length > 0
      ? auth.signature
      : [auth.r, auth.s];
    let parsedSig;
    try {
      parsedSig = normalizeWalletSignature(rawSignature);
    } catch (e) {
      throw bad(`the authorization's signature array cannot be parsed: ${e.message}`);
    }
    if (normHex(parsedSig.r) !== normHex(auth.r) || normHex(parsedSig.s) !== normHex(auth.s)) {
      throw conflict('the authorization\'s r/s do not match the owner component of ' +
        'its own signature array - refusing to relay a mismatched envelope');
    }
    const typedData = auth.typedData;
    if (!typedData || typedData.primaryType !== 'OutsideExecution') {
      throw bad('the authorization carries no OutsideExecution typed data - ' +
        'the exact message the signer saw is part of the envelope');
    }

    // Control 1 - signer identity. The address the wallet claims must be the
    // controller THE CHAIN names on this gate; a signature from any other
    // account cannot authorize it (the gate would refuse too - this refuses
    // before anyone pays gas).
    if (auth.scheme === 'wallet-snip12-src9') {
      if (!auth.signerAddress) {
        throw bad('a wallet authorization must carry the wallet address ' +
          '(signerAddress) it was signed from');
      }
      if (normHex(auth.signerAddress) !== normHex(controller)) {
        throw conflict(`the wallet signed as ${auth.signerAddress}, but the ` +
          `gate's controller on chain is ${controller} - a signature from ` +
          'any other account cannot authorize this gate');
      }
    }

    // Control 2 - the message fields, each against a source the request does
    // not control: this chain, the recomputed calls from the LIVE state, the
    // recorded selector set, and the open window.
    const msg = typedData.message;
    if (!msg || typeof msg !== 'object') throw bad('the typed data has no message');
    if (typedData.domain?.chainId !== label) {
      throw conflict(`the typed data is for chain '${typedData.domain?.chainId}', ` +
        `not '${label}' - refusing to relay a cross-chain authorization`);
    }
    if (normHex(msg.Caller ?? -1) !== ANY_CALLER_FELT) {
      throw conflict('the typed data names a specific caller, not ANY_CALLER - ' +
        'this relay only carries authorizations anyone may submit');
    }
    if (!Array.isArray(msg.Calls) || msg.Calls.length !== expectedCalls.length) {
      throw conflict(`the signed message carries ${msg.Calls?.length ?? 0} call(s), ` +
        `but ${texts.calls} produces ${expectedCalls.length} - ` +
        'refusing to relay signed calls that are not the approved ones');
    }
    for (let i = 0; i < expectedCalls.length; i += 1) {
      const want = expectedCalls[i];
      const got = msg.Calls[i];
      const wantSel = selectorFromName(want.entrypoint);
      const recorded = state.selectors?.[want.entrypoint];
      if (recorded && normHex(recorded) !== normHex(wantSel)) {
        throw conflict(`the state file's recorded selector for '${want.entrypoint}' ` +
          `disagrees with the computed one - refusing to guess which is right`);
      }
      const wantCd = (want.calldata ?? []).map((v) => normHex(v));
      const gotCd = (got?.Calldata ?? []).map((v) => normHex(v));
      if (normHex(got?.To ?? -1) !== normHex(want.to)
        || normHex(got?.Selector ?? -1) !== normHex(wantSel)
        || wantCd.length !== gotCd.length
        || wantCd.some((v, j) => v !== gotCd[j])) {
        throw conflict(`signed call #${i + 1} is not the call ${texts.produces} - ` +
          'the typed data was edited or built against a stale policy; refusing to relay');
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const after = BigInt(msg['Execute After'] ?? -1);
    const before = BigInt(msg['Execute Before'] ?? -1);
    if (!(after < BigInt(now) && BigInt(now) < before)) {
      throw conflict('the signed execution window is not open right now ' +
        `(after ${after}, before ${before}, now ${now}) - the gate would ` +
        'refuse it too; re-plan for a fresh window');
    }

    // Control 3 - the nonce, read from the chain: an already-burned nonce
    // means this exact authorization was already executed.
    const nonce = hexBig(msg.Nonce ?? -1);
    let nonceUnused;
    try {
      nonceUnused = feltTrue(await readOutsideNonce(gate, nonce));
    } catch (e) {
      throw new HttpError(502, `the nonce read failed: ${e.message}`);
    }
    if (!nonceUnused) {
      throw conflict(`the signed nonce ${nonce} is already consumed on chain - ` +
        'this authorization was already used; refusing to replay it');
    }

    // Control 4 - the signature. The SNIP-9 digest is recomputed HERE, bound
    // to the CHAIN-READ controller (the same binding the contract uses), and
    // verified against the controller's public key read FROM THE CHAIN.
    let controllerKey;
    try {
      const out = await readControllerPublicKey(controller);
      controllerKey = Array.isArray(out) ? out[0] : out;
    } catch (e) {
      throw new HttpError(502, `the controller key read failed: ${e.message}`);
    }
    if (!controllerKey || BigInt(controllerKey) === 0n) {
      throw conflict(`the controller ${controller} exposes no public key the ` +
        'server can pre-verify against - refusing to relay unverifiable bytes');
    }
    // getMessageHash returns a BigInt; the verifier and the JSON record both
    // take hex strings (@scure's verify refuses BigInts, JSON cannot hold them).
    const digest = hexBig(getMessageHash(typedData, controller));
    if (!verifyOwnerSignature(digest, { r: auth.r, s: auth.s }, controllerKey)) {
      throw conflict('the SNIP-9 signature does not verify against the public ' +
        `key of the controller the chain names (${controller}) - refusing to relay`);
    }

    // The wire, packed FLAT and explicitly (OBS-16: CallData.compile would
    // length-prefix every nested Call). OutsideExecution serializes as:
    // caller, nonce, execute_after, execute_before, Span<Call> (len, then per
    // call: to, selector, calldata_len, calldata...), Span<felt252> (len, sig).
    const wireCalldata = [
      hexBig(msg.Caller),
      nonce,
      hexBig(after),
      hexBig(before),
      hexBig(msg.Calls.length),
      ...msg.Calls.flatMap((c) => [
        hexBig(c.To), hexBig(c.Selector), hexBig(c.Calldata.length),
        ...c.Calldata.map((v) => hexBig(v)),
      ]),
      hexBig(parsedSig.signature.length), ...parsedSig.signature.map((v) => hexBig(v)),
    ];

    return { typedData, msg, digest, nonce, after, before, wireCalldata };
  }

  // One definition of "the chain has spoken about this transaction": read the
  // receipt verbatim, and when it is final, patch the stored submission with
  // the FINAL status (never ours) and - for outside submissions - the nonce
  // burn read back from the chain (replay closed). Shared by /api/tx/receipt
  // and /api/outside/record so the relay path and the wallet-submitted path
  // (OBS-31) can never disagree about what a record means.
  async function completeSubmissionFromReceipt(hash) {
    let answer;
    try {
      answer = await readReceipt(hash);
    } catch (e) {
      throw new HttpError(502, `the node could not be reached: ${e.message}`);
    }
    if (answer?.error) {
      // "Not found yet" is the normal pending state - report the node
      // verbatim, do not dress it up as final and do not crash.
      return { final: false, receipt: null, submission: null, error: answer.error };
    }
    const receipt = answer?.result ?? null;
    const execution = receipt?.execution_status ?? null;
    const final = execution === 'SUCCEEDED' || execution === 'REVERTED';
    let updated = null;
    if (final) {
      const patch = {
        status: execution,
        revert_reason: receipt?.revert_reason ?? null,
      };
      // Outside submissions: the record is only COMPLETE when the chain also
      // says the one-shot nonce is burned (replay closed). Read back, never
      // assumed - the same rule as the final status itself.
      const prior = loadSubmissions().submissions
        .filter((s) => s.tx_hash && normHex(s.tx_hash) === normHex(hash))
        .pop();
      if (prior?.kind === 'outside' && execution === 'SUCCEEDED' && prior.nonce) {
        try {
          const gate = loadState().contracts.gate_account.address;
          patch.nonce_consumed = !(feltTrue(await readOutsideNonce(gate, prior.nonce)));
        } catch (e) {
          patch.nonce_consumed = null;
          patch.nonce_read_error = String(e?.message ?? e);
        }
      }
      updated = updateSubmission(hash, patch);
    }
    return { final, receipt, submission: updated ?? null, error: null };
  }

  async function handleApi(req, res, url) {
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && path === '/api/mandate') {
      const state = loadState();
      const mandate = await readMandate();
      const [owner, status] = await Promise.allSettled([
        readOwnerKey(),
        chainStatus(state.rpc_endpoints_verified.cartridge.url),
      ]);
      // The baseline for the lock card is the LIVE owner record - keys.owner_current,
      // written from the phase-6 handover (handover.json's newOwnerPublicKey and its
      // chain read-back). keys.owner is deliberately HISTORICAL evidence of the
      // pre-handover pasted key; comparing the chain against it lit a false RECORD
      // MISMATCH on 2026-10-28 (OBS-35). The fallback keeps pre-handover records
      // working, and a genuinely different live key still mismatches - the check
      // keeps its teeth.
      const recorded = state.keys.owner_current?.public_key
        ?? state.keys.owner.public_key ?? null;
      const ownerPublicKey = owner.status === 'fulfilled' ? owner.value : null;
      return sendJson(res, 200, {
        network: 'starknet-sepolia',
        chainId: state.chain_id ?? null,
        chainIdHex: state.chain_id_hex ?? null,
        gate: state.contracts.gate_account.address,
        token: mandate.token,
        merchant: state.keys.merchant?.address ?? null,
        stranger: state.keys.stranger?.address ?? null,
        mandate,
        ownerPublicKey,
        ownerKeyError: owner.status === 'rejected'
          ? String(owner.reason?.message ?? owner.reason) : null,
        recordedOwnerPublicKey: recorded,
        ownerKeyMatchesRecord: ownerPublicKey !== null && recorded !== null
          ? normHex(ownerPublicKey) === normHex(recorded) : null,
        status: status.status === 'fulfilled' ? status.value : null,
        statusError: status.status === 'rejected'
          ? String(status.reason?.message ?? status.reason) : null,
        gates: engine.listGates(),
        fetchedAt: Date.now(),
      });
    }

    if (req.method === 'GET' && path === '/api/proposals') {
      const proposals = store.list().map((p) => (
        p.resolution ? { ...p, digest: resolutionDigest(p, p.resolution) } : p));
      return sendJson(res, 200, {
        proposals,
        submissions: loadSubmissions().submissions,
      });
    }

    if (req.method === 'GET' && path === '/api/owner-pubkey') {
      const ownerPublicKey = await readOwnerKey();
      const state = loadState();
      return sendJson(res, 200, {
        ownerPublicKey,
        recordedOwnerPublicKey: state.keys.owner.public_key ?? null,
      });
    }

    if (req.method === 'GET' && path === '/api/audit') {
      const state = loadState();
      const proposals = store.list();
      let currentOwner = null;
      let ownerError = null;
      try {
        currentOwner = await readOwnerKey();
      } catch (e) {
        ownerError = String(e?.message ?? e);
      }
      const enriched = proposals.map((p) => {
        if (!p.resolution || !p.signature) return p;
        const digest = resolutionDigest(p, p.resolution);
        let validNow = null;
        if (currentOwner) {
          try {
            validNow = verifyOwnerSignature(digest, p.signature, currentOwner, {
              kind: 'resolution',
              accountAddress: state.contracts.gate_account.address,
              chainId: state.chain_id,
            });
          } catch {
            validNow = false;
          }
        }
        return { ...p, digest, signatureValidNow: validNow };
      });
      return sendJson(res, 200, {
        proposals: enriched,
        submissions: loadSubmissions().submissions,
        demoRuns: state.layer_c_demo ?? [],
        currentOwner,
        ownerError,
        generatedAt: Date.now(),
      });
    }

    if (req.method === 'GET' && path === '/api/resume') {
      return sendJson(res, 200, await buildResume());
    }

    // The console's OWN read of an account's owner key, straight from the
    // chain. A browser tab cannot always reach the chain through the wallet's
    // injected provider: the provider fetches from the PAGE's origin, which
    // real wallets fail at the transport layer ("Failed to fetch" - CORS or an
    // extension-internal proxy, observed live 2026-10-26 on Ready X). The key
    // must still come from THE CHAIN, never from the extension's word, so the
    // console reads it here - server-side, CORS-free - and reports WHICH
    // getter answered, because the signature shape the browser expects
    // depends on it. Public chain data; reveals nothing that is not on chain.
    if (req.method === 'GET' && path === '/api/chain/key') {
      const address = url.searchParams.get('address') ?? '';
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
        return sendJson(res, 400, {
          error: 'address must be a hex felt: 0x followed by up to 64 hex digits',
        });
      }
      let key;
      let getter;
      try {
        try {
          const direct = await readPublicKey(address);
          key = Array.isArray(direct) ? direct[0] : direct;
          getter = 'get_public_key';
        } catch {
          const out = await readControllerPublicKey(address);
          key = Array.isArray(out) ? out[0] : out;
          getter = 'get_owner';
        }
      } catch (e) {
        throw new HttpError(502, `the console's chain read of ${address} failed: ${e.message}`);
      }
      if (!key || BigInt(key) === 0n) {
        throw new HttpError(502, `the chain returned no owner key for ${address} - ` +
          'refusing to guess what the wallet holds');
      }
      return sendJson(res, 200, { ok: true, key: normHex(key), getter });
    }

    if (req.method === 'POST' && path === '/api/ladder/preview') {
      const body = await readJson(req);
      const trust = await loadTrustView();
      if (!trust.ok) {
        throw conflict(`the agent's trust state cannot be read: ${trust.reason}`);
      }
      const change = buildLadderChange(trust, body);
      return sendJson(res, 200, {
        change,
        digest: ladderChangeDigest(change),
        stage: trust.stage,
        // Show the owner exactly what the new stage would allow, computed from
        // the same PROFILES table the door enforces - not from screen copy.
        before: serialiseProfile(PROFILES[trust.stage]),
        after: serialiseProfile(PROFILES[change.to]),
        // The ladder only suggests; the owner decides. Say plainly whether the
        // evidence backs this move, so an override is a choice, not a default.
        suggestion: trust.suggestion,
        earned: trust.suggestion?.to === change.to,
      });
    }

    // Apply a ladder change the BROWSER signed. The server is a scribe here: it
    // re-verifies the signature against the owner key on chain, then re-checks
    // that the change still binds the evidence that exists right now. A signed
    // change for an older snapshot is refused rather than quietly applied.
    if (req.method === 'POST' && path === '/api/ladder/apply') {
      const body = await readJson(req);
      const change = body.change;
      const signature = body.signature;
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        throw bad('a ladder change is required');
      }
      if (!signature?.r || !signature?.s) {
        throw bad('a ladder change needs the owner signature that goes with it');
      }
      const signed = { ...change, signature };
      const errors = validateLadderChange(signed);
      if (errors.length > 0) {
        throw bad(`invalid ladder change: ${errors.join('; ')}`);
      }

      const owner = await readOwnerKey();
      if (normHex(change.owner) !== normHex(owner)) {
        throw conflict('this change is signed for a different owner than the one ' +
          'the chain reports - refusing to record it');
      }
      const digest = ladderChangeDigest(signed);
      const state = loadState();
      const ladderContext = {
        kind: 'ladder-change',
        accountAddress: state.contracts.gate_account.address,
        chainId: state.chain_id,
      };
      if (!verifyDigest(digest, signature, owner, ladderContext)) {
        throw conflict('the ladder signature does not verify against the owner ' +
          'key on chain - refusing to record it');
      }

      const trust = await loadTrustView();
      if (!trust.ok) {
        throw conflict(`the agent's trust state cannot be read: ${trust.reason}`);
      }
      if (change.agentId !== trust.identity.agentId) {
        throw conflict('this change is for a different agent');
      }
      if (change.from !== trust.stage) {
        throw conflict(`the agent is '${trust.stage}', not '${change.from}'`);
      }
      if (change.seq !== trust.changes.length + 1) {
        throw conflict(`this change is seq ${change.seq}, but the next one must ` +
          `be ${trust.changes.length + 1}`);
      }
      const transition = validateTransition(change.from, change.to);
      if (!transition.ok) throw conflict(transition.reason);
      if (Number(change.evidenceCount) !== trust.count
        || BigInt(change.evidenceRoot) !== BigInt(trust.root)) {
        throw conflict('the evidence changed after this change was signed - ' +
          'preview and sign it again');
      }

      // The store enforces the same rules a third time and writes atomically.
      // Built WITH the ladder context so a wallet-signed (typed-data) change
      // passes the store's own re-check, exactly like the endpoint's.
      const store = createLadderStore({ filePath: ladderPath, context: ladderContext });
      store.append(signed);
      return sendJson(res, 200, {
        digest,
        applied: signed.seq,
        resume: await buildResume(),
      });
    }

    // Preview the exact witness attestation the owner will sign (Track 3). Like
    // the ladder preview: the server chooses every field that could be lied
    // about, checks the new link cannot orphan existing records, and the browser
    // recomputes the digest itself before anything is signed.
    if (req.method === 'POST' && path === '/api/witness/preview') {
      const body = await readJson(req);
      // Tolerate an uncovered record: vouching/rotating is HOW the owner
      // repairs it. Any other refusal is a hard stop, same as the ladder.
      const trust = await loadTrustView({ tolerateWitnessMismatch: true });
      if (!trust.ok && trust.error !== 'evidence-witness-mismatch') {
        throw conflict(`the agent's trust state cannot be read: ${trust.reason}`);
      }
      const attestation = buildWitnessAttestation(trust, body);
      checkAttestationCoverage(trust, attestation);
      const history = trust.witnessHistory ?? [];
      return sendJson(res, 200, {
        attestation,
        digest: witnessAttestationDigest(attestation),
        current: history.length > 0 ? history[history.length - 1] : null,
      });
    }

    // Record an attestation the BROWSER signed. The server is a scribe here: it
    // re-verifies the signature against the owner key on chain (raw OR wallet
    // typed-data), refuses one for a different agent or a stale seq, re-checks
    // that no signed record is orphaned, and the store then enforces the chain
    // rules (seq, supersedes, forward time) once more and writes atomically.
    if (req.method === 'POST' && path === '/api/witness/attest') {
      const body = await readJson(req);
      const attestation = body.attestation;
      const signature = body.signature;
      if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
        throw bad('a witness attestation is required');
      }
      if (!signature?.r || !signature?.s) {
        throw bad('a witness attestation needs the owner signature that goes with it');
      }
      const signed = { ...attestation, signature };
      const errors = validateWitnessAttestation(signed);
      if (errors.length > 0) {
        throw bad(`invalid witness attestation: ${errors.join('; ')}`);
      }

      const owner = await readOwnerKey();
      if (normHex(attestation.owner) !== normHex(owner)) {
        throw conflict('this attestation names a different owner than the one ' +
          'the chain reports - refusing to record it');
      }
      const state = loadState();
      const attestationContext = {
        kind: 'witness-attestation',
        accountAddress: state.contracts.gate_account.address,
        chainId: state.chain_id,
      };
      const digest = witnessAttestationDigest(signed);
      if (!verifyDigest(digest, signature, owner, attestationContext)) {
        throw conflict('the attestation signature does not verify against the ' +
          'owner key on chain - refusing to record it');
      }

      // Tolerate an uncovered record here too - recording the attestation is
      // the repair. The coverage guard below then proves the repair is real:
      // after this link, EVERY signed record must be covered.
      const trust = await loadTrustView({ tolerateWitnessMismatch: true });
      if (!trust.ok && trust.error !== 'evidence-witness-mismatch') {
        throw conflict(`the agent's trust state cannot be read: ${trust.reason}`);
      }
      if (normHex(attestation.agentId) !== normHex(trust.identity.agentId)) {
        throw conflict('this attestation is for a different agent');
      }
      const nextSeq = (trust.witnessHistory?.length ?? 0) + 1;
      if (attestation.seq !== nextSeq) {
        throw conflict(`this attestation is seq ${attestation.seq}, but the next ` +
          `one must be ${nextSeq}`);
      }
      checkAttestationCoverage(trust, attestation);

      const store = createAttestationStore({
        filePath: attestationPath, context: attestationContext,
      });
      try {
        store.append(signed);
      } catch (e) {
        throw conflict(e.message);
      }
      return sendJson(res, 200, {
        digest,
        applied: signed.seq,
        resume: await buildResume(),
      });
    }

    // Write the current evidence fingerprint to Starknet through the
    // GateAccount. This is the on-chain half of a promotion: the chain proves
    // the fingerprint existed, the owner signature on the ladder change says
    // what it earned.
    if (req.method === 'POST' && path === '/api/anchor') {
      // The server-run demo path. The guard is SHARED with /api/anchor/plan and
      // /api/outside/plan (purpose: anchor) - one definition of "there is a new
      // fingerprint to anchor", so the three can never disagree.
      const guarded = await outsideGuardedAnchor();
      const { state, calls } = guarded;
      let result;
      try {
        result = await submitCalls(calls);
      } catch (e) {
        throw new HttpError(502, `owner transaction failed to run: ${e.message}`);
      }
      if (result.status === 'SUCCEEDED') {
        recordAnchor({
          date: new Date().toISOString(),
          agent_id: guarded.agentId,
          root: guarded.root,
          count: guarded.count,
          anchorer: guarded.existing.anchorer
            ?? state.contracts?.gate_account?.address ?? null,
          tx_hash: result.tx_hash ?? null,
          source: 'console',
        });
      }
      // Read the chain again rather than trusting what was just sent.
      const after = await readAnchor(guarded.agentId);
      return sendJson(res, 200, {
        status: result.status,
        tx_hash: result.tx_hash ?? null,
        revert_reason: result.revert_reason ?? null,
        message: result.message ?? null,
        calls,
        anchor: after,
      });
    }

    if (req.method === 'POST' && path === '/api/requests') {
      const body = await readJson(req);
      const state = loadState();
      const mandate = await readMandate();
      const request = parseAgentRequest(body, state, mandate);
      const decision = engine.decide(request, { spend: mandate });
      let proposal = null;
      if (decision.verdict !== 'ALLOW') {
        proposal = store.create(request, decision, 'asked from the console');
      }
      return sendJson(res, 200, { decision, proposal });
    }

    if (req.method === 'POST' && path === '/api/preview') {
      const body = await readJson(req);
      const preview = await buildPreview(body.proposalId, body.resolution);
      return sendJson(res, 200, preview);
    }

    if (req.method === 'POST' && path === '/api/plan') {
      const body = await readJson(req);
      if (!body.proposalId || typeof body.proposalId !== 'string') {
        throw bad('proposalId is required');
      }
      const proposal = store.get(body.proposalId);
      if (!proposal) throw notFound(`no proposal '${body.proposalId}'`);
      if (!EXECUTABLE.includes(proposal.status)) {
        throw conflict(`proposal '${proposal.id}' is ${proposal.status} - ` +
          'only an approved-once or amended proposal has an on-chain plan');
      }
      const state = loadState();
      const mandate = await readMandate();
      let converted;
      try {
        converted = resolutionToCalls(proposal, {
          gateAddress: state.contracts.gate_account.address,
          sessionPublicKey: mandate.sessionPublicKey,
          currentPolicy: mandate,
        });
      } catch (e) {
        throw conflict(`cannot build the on-chain call: ${e.message}`);
      }
      return sendJson(res, 200, {
        calls: converted.calls,
        sideEffects: converted.sideEffects,
      });
    }

    if (req.method === 'POST' && path === '/api/resolve') {
      const body = await readJson(req);
      if (!body.proposalId || typeof body.proposalId !== 'string') {
        throw bad('proposalId is required');
      }
      validateResolution(body.resolution);
      try {
        const proposal = await store.resolve(
          body.proposalId, body.resolution, body.signature);
        return sendJson(res, 200, { proposal });
      } catch (e) {
        throw asHttpError(e);
      }
    }

    if (req.method === 'POST' && path === '/api/submit') {
      const body = await readJson(req);
      if (!body.proposalId || typeof body.proposalId !== 'string') {
        throw bad('proposalId is required');
      }
      const proposal = store.get(body.proposalId);
      if (!proposal) throw notFound(`no proposal '${body.proposalId}'`);
      if (!EXECUTABLE.includes(proposal.status)) {
        throw conflict(`proposal '${proposal.id}' is ${proposal.status} - only an ` +
          'approved-once or amended proposal can be submitted');
      }

      const prior = loadSubmissions().submissions
        .filter((s) => s.proposalId === proposal.id);
      const final = prior.find((s) => s.status === 'SUCCEEDED' || s.status === 'REVERTED');
      if (final) {
        throw conflict(`proposal '${proposal.id}' was already submitted ` +
          `(${final.status}${final.tx_hash ? `, tx ${final.tx_hash}` : ''}) - ` +
          'refusing to submit twice');
      }

      // The approval must still be the CURRENT owner's. A key rotation between
      // signing and submission invalidates the approval - do not execute it.
      const currentOwner = await readOwnerKey();
      if (proposal.ownerPublicKeyAtResolution
        && normHex(proposal.ownerPublicKeyAtResolution) !== normHex(currentOwner)) {
        throw conflict('the owner key on chain has changed since this approval was ' +
          'signed - refusing to submit an approval the current owner did not sign');
      }
      const state = loadState();
      const resolutionContext = {
        kind: 'resolution',
        accountAddress: state.contracts.gate_account.address,
        chainId: state.chain_id,
      };
      const digest = resolutionDigest(proposal, proposal.resolution);
      if (!verifyOwnerSignature(digest, proposal.signature, currentOwner, resolutionContext)) {
        throw conflict('the stored signature no longer verifies against the current ' +
          'owner key - refusing to submit');
      }

      // Recompute from the LIVE mandate: if the policy moved since the preview,
      // this throws instead of executing a stale intent.
      const mandate = await readMandate();
      let converted;
      try {
        converted = resolutionToCalls(proposal, {
          gateAddress: state.contracts.gate_account.address,
          sessionPublicKey: mandate.sessionPublicKey,
          currentPolicy: mandate,
        });
      } catch (e) {
        throw conflict(`refusing to submit: ${e.message}`);
      }

      let result;
      try {
        result = await submitCalls(converted.calls);
      } catch (e) {
        throw new HttpError(502, `owner transaction failed to run: ${e.message}`);
      }

      const submission = {
        proposalId: proposal.id,
        submittedAt: Date.now(),
        status: result.status,
        tx_hash: result.tx_hash ?? null,
        revert_reason: result.revert_reason ?? null,
        message: result.message ?? null,
        digest,
        calls: converted.calls,
        sideEffects: converted.sideEffects,
        log: typeof result.log === 'string' ? result.log.slice(-1500) : null,
      };
      saveSubmission(submission);
      return sendJson(res, 200, { submission });
    }

    // ---------------------------------------------------------------- relay
    // The last hop, inverted. The browser asks for a plan (calls + estimate),
    // signs the transaction hash itself with the key already in the tab, and
    // /api/broadcast carries the finished bytes after re-checking them against
    // the chain. The relay cannot substitute calls, because it never builds
    // them - it only prices them and carries them.

    if (req.method === 'POST' && path === '/api/tx/plan') {
      const body = await readJson(req);
      if (!body.proposalId || typeof body.proposalId !== 'string') {
        throw bad('proposalId is required');
      }
      const proposal = store.get(body.proposalId);
      if (!proposal) throw notFound(`no proposal '${body.proposalId}'`);
      if (!EXECUTABLE.includes(proposal.status)) {
        throw conflict(`proposal '${proposal.id}' is ${proposal.status} - only an ` +
          'approved-once or amended proposal has a transaction to sign');
      }
      // The same replay guard /api/submit enforces: a proposal that already
      // reached the chain does not get a second plan.
      const prior = loadSubmissions().submissions
        .filter((s) => s.proposalId === proposal.id);
      const final = prior.find((s) => s.status === 'SUCCEEDED' || s.status === 'REVERTED');
      if (final) {
        throw conflict(`proposal '${proposal.id}' already went to the chain ` +
          `(${final.status}${final.tx_hash ? `, tx ${final.tx_hash}` : ''}) - ` +
          'refusing to plan a second submission');
      }
      // The approval must still be the CURRENT owner's, and still verify.
      const currentOwner = await readOwnerKey();
      if (proposal.ownerPublicKeyAtResolution
        && normHex(proposal.ownerPublicKeyAtResolution) !== normHex(currentOwner)) {
        throw conflict('the owner key on chain has changed since this approval was ' +
          'signed - refusing to plan a transaction for an approval the current ' +
          'owner did not sign');
      }
      const state = loadState();
      const resolutionContext = {
        kind: 'resolution',
        accountAddress: state.contracts.gate_account.address,
        chainId: state.chain_id,
      };
      const digest = resolutionDigest(proposal, proposal.resolution);
      if (!verifyOwnerSignature(digest, proposal.signature, currentOwner, resolutionContext)) {
        throw conflict('the stored signature no longer verifies against the current ' +
          'owner key - refusing to plan');
      }
      // Recompute from the LIVE mandate: if the policy moved since the approval,
      // this throws instead of pricing a stale intent.
      const mandate = await readMandate();
      let converted;
      try {
        converted = resolutionToCalls(proposal, {
          gateAddress: state.contracts.gate_account.address,
          sessionPublicKey: mandate.sessionPublicKey,
          currentPolicy: mandate,
        });
      } catch (e) {
        throw conflict(`cannot build the on-chain call: ${e.message}`);
      }
      const plan = await planForCalls(converted.calls, {
        kind: 'proposal',
        proposalId: proposal.id,
        digest,
        sideEffects: converted.sideEffects,
      });
      return sendJson(res, 200, plan);
    }

    if (req.method === 'POST' && path === '/api/broadcast') {
      const body = await readJson(req);
      const tx = body.transaction;
      if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
        throw bad('transaction is required: the finished, signed RPC body ' +
          'the browser built and signed');
      }
      if (!Array.isArray(tx.signature) || tx.signature.length !== 2) {
        throw bad('the transaction carries no signature - the relay only ' +
          'carries owner-signed transactions');
      }
      // Optional audit-trail tag for owner actions (the v0.4 install): it
      // labels the RECORD and nothing else - the three controls below are
      // identical for every transaction the relay carries, tagged or not.
      let actionTag = null;
      if (body.action != null) {
        if (body.action !== 'upgrade') {
          throw bad(`unknown action tag '${String(body.action)}' - the relay ` +
            "only records the 'upgrade' tag");
        }
        actionTag = 'upgrade';
      }
      const { gate, chainId, label } = relayContext();

      // Control 1 - sender. The relay carries THIS account's transactions or
      // nothing; a transaction from any other address is refused before any
      // crypto runs.
      if (!tx.sender_address || normHex(tx.sender_address) !== normHex(gate)) {
        throw conflict(`the transaction is from ${tx.sender_address ?? 'nothing'}, ` +
          `not the GateAccount ${gate} - the relay only carries this account's ` +
          'transactions');
      }

      // Control 2 - the hash. Recomputed here from the FINISHED body, with OUR
      // chain id. A body edited after signing hashes differently; a body built
      // for another chain hashes differently. Either way control 3 then fails.
      let hash;
      try {
        hash = hashFromBody(tx, chainId);
      } catch (e) {
        throw bad(`the transaction body cannot be relayed: ${e.message}`);
      }

      // Control 3 - the signature, against the owner key read FROM THE CHAIN,
      // with the same verifier every other owner signature passes through.
      const currentOwner = await readOwnerKey();
      if (!verifyOwnerSignature(hash,
        { r: tx.signature[0], s: tx.signature[1] }, currentOwner)) {
        throw conflict('the signature does not verify against the owner key ' +
          `currently on chain, over the hash of exactly these bytes on ${label} - ` +
          'refusing to relay');
      }

      // Optional audit-trail link: when the browser says which proposal this
      // transaction executes, the replay guard from /api/submit applies too.
      let proposalId = null;
      if (body.proposalId != null) {
        if (typeof body.proposalId !== 'string') throw bad('proposalId must be a string');
        const proposal = store.get(body.proposalId);
        if (!proposal) throw notFound(`no proposal '${body.proposalId}'`);
        const prior = loadSubmissions().submissions
          .filter((s) => s.proposalId === proposal.id);
        const final = prior.find((s) => s.status === 'SUCCEEDED' || s.status === 'REVERTED');
        if (final) {
          throw conflict(`proposal '${proposal.id}' was already broadcast ` +
            `(${final.status}${final.tx_hash ? `, tx ${final.tx_hash}` : ''}) - ` +
            'refusing to relay it twice');
        }
        proposalId = proposal.id;
      }

      // The bytes go to the node EXACTLY as the browser signed them. Nothing is
      // added, reordered or re-encoded.
      let answer;
      try {
        answer = await sendTransaction(tx);
      } catch (e) {
        throw new HttpError(502, `the node could not be reached: ${e.message}`);
      }
      if (answer?.error) {
        // The node's answer, verbatim - including its error code and data.
        return sendJson(res, 502, {
          relayed: false,
          error: answer.error,
          message: `the node refused the transaction: ` +
            `${answer.error?.message ?? 'no message given'}`,
        });
      }
      const txHash = answer?.result?.transaction_hash ?? null;
      if (!txHash) {
        return sendJson(res, 502, {
          relayed: false,
          answer, // verbatim, so nothing is hidden
          message: 'the node answered with neither a transaction hash nor an error',
        });
      }

      const submission = {
        proposalId,
        ...(actionTag ? { action: actionTag } : {}),
        submittedAt: Date.now(),
        status: 'BROADCAST', // the FINAL status comes from a receipt, never from us
        via: 'relay',
        tx_hash: txHash,
        computedHash: hash,
        revert_reason: null,
        message: null,
        log: null,
      };
      saveSubmission(submission);
      return sendJson(res, 200, { relayed: true, result: answer.result, submission });
    }

    if (req.method === 'GET' && path === '/api/tx/receipt') {
      const hash = url.searchParams.get('hash');
      if (!hash || !/^0x[0-9a-fA-F]+$/.test(hash)) {
        throw bad('a transaction hash is required (?hash=0x...)');
      }
      return sendJson(res, 200, await completeSubmissionFromReceipt(hash));
    }

    // ---------------------------------------------- owner actions (v0.4 install)
    // Not every owner-signed transaction executes a proposal. Installing a
    // declared class (`upgrade`) is an owner action in its own right: planned
    // from the state file's pending_upgrade RECORD - never from the request -
    // priced by a live estimate, signed IN THE BROWSER with the owner key, and
    // carried by the same relay under the same three controls. The replay guard
    // is the chain itself: once the gate runs the new class, planning refuses.

    if (req.method === 'GET' && path === '/api/owner/upgrade') {
      const state = loadState();
      const { gate, label } = relayContext();
      let currentClassHash;
      try {
        currentClassHash = await readClassHash(gate);
      } catch (e) {
        throw new HttpError(502, `the node could not be reached for the gate's ` +
          `current class hash: ${e.message}`);
      }
      const pending = state.pending_upgrade ?? null;
      return sendJson(res, 200, {
        recordedVersion: state.contracts?.gate_account?.version ?? null,
        gate,
        chain: label,
        currentClassHash,
        pending,
        alreadyApplied: pending
          ? normHex(currentClassHash) === normHex(pending.class_hash)
          : null,
      });
    }

    if (req.method === 'POST' && path === '/api/owner/plan') {
      const body = await readJson(req);
      const action = body?.action;
      if (action !== 'upgrade') {
        throw bad(`unknown owner action '${String(action ?? '(none)')}' - the ` +
          "only owner action this console plans is 'upgrade'");
      }
      const state = loadState();
      const pending = state.pending_upgrade;
      if (!pending?.class_hash) {
        throw conflict('no pending upgrade is recorded in the state file - a ' +
          'new class must be declared first (scripts/declare-v04.sh records it ' +
          'as pending_upgrade)');
      }
      const { gate } = relayContext();
      let currentClassHash;
      try {
        currentClassHash = await readClassHash(gate);
      } catch (e) {
        throw new HttpError(502, `the node could not be reached for the gate's ` +
          `current class hash: ${e.message}`);
      }
      if (normHex(currentClassHash) === normHex(pending.class_hash)) {
        throw conflict(`the gate ALREADY runs class ${pending.class_hash} - ` +
          'there is nothing to install (the chain says so, not a remembered flag)');
      }
      const calls = [{ to: gate, entrypoint: 'upgrade', calldata: [pending.class_hash] }];
      const plan = await planForCalls(calls, {
        kind: 'owner-action',
        action: 'upgrade',
        currentClassHash,
        newClassHash: pending.class_hash,
        pendingVersion: pending.version ?? null,
        sideEffects: [
          "the gate's code is replaced IN PLACE; every piece of state survives " +
          '- mandate, sessions, policies, controller, balances, history ' +
          '(snforge t34/t40 pin exactly this)',
          'from this class on, the registered wallet controller may call the ' +
          'admin entrypoints directly - future owner actions sign FROM THE ' +
          'WALLET with no key export (this upgrade is the last one that needs ' +
          'the pasted key)',
        ],
      });
      return sendJson(res, 200, plan);
    }

    // -------------------------------------------------- the outside relay (phase 5)
    // The wallet signs; this server is just one of the infinite anonymous
    // submitters SNIP-9 allows - with one honest difference: it refuses to
    // carry anything that does not re-verify here first.

    if (req.method === 'POST' && path === '/api/outside/plan') {
      const body = await readJson(req);
      // Two purposes share this endpoint: an approved proposal's calls, or the
      // résumé fingerprint's anchor call. Both are rebuilt from live reads; the
      // request only picks which.
      const purpose = body?.purpose === 'anchor' ? 'anchor' : 'proposal';
      const guarded = purpose === 'anchor'
        ? await outsideGuardedAnchor()
        : await outsideGuardedProposal(body);
      const { label } = relayContext(); // cross-checks the state file's chain id
      const { gate, controller } = await outsideController(guarded.state);

      // The controller's public key, best effort: the browser shows which
      // wallet controls the gate, and /api/outside/submit re-reads it anyway.
      let controllerPublicKey = null;
      try {
        const out = await readControllerPublicKey(controller);
        controllerPublicKey = Array.isArray(out) ? out[0] : out;
      } catch { controllerPublicKey = null; }

      const nonce = await drawUnusedOutsideNonce(gate);

      const now = Math.floor(Date.now() / 1000);
      const executeAfter = now - 60; // the contract asserts execute_after < now, strictly
      const executeBefore = now + 900;
      const calls = guarded.calls.map((c) => ({
        to: c.to, selector: c.entrypoint, calldata: c.calldata,
      }));
      const common = {
        kind: 'outside',
        purpose,
        calls,
        chainId: label,
        caller: 'ANY_CALLER',
        nonce,
        executeAfter,
        executeBefore,
        gate,
        controller,
        controllerPublicKey,
        relayer: guarded.state.keys?.deployer?.address ?? null,
        note: 'the wallet signs this SNIP-9 typed data (authorizeCalls); the ' +
          'server relays execute_from_outside_v2 with its gas-only deployer ' +
          'key and records nothing until the receipt comes back',
      };
      if (purpose === 'anchor') {
        // The browser binds these to the fingerprint the résumé screen shows;
        // a mismatch there is a refusal, not a warning.
        return sendJson(res, 200, {
          ...common,
          agentId: guarded.agentId,
          root: guarded.root,
          count: guarded.count,
        });
      }
      return sendJson(res, 200, {
        ...common,
        proposalId: guarded.proposal.id,
        digest: guarded.digest,
        sideEffects: guarded.sideEffects,
      });
    }

    if (req.method === 'POST' && path === '/api/outside/submit') {
      const body = await readJson(req);
      const purpose = body?.purpose === 'anchor' ? 'anchor' : 'proposal';
      // The guard re-runs at SUBMIT time: the calls the authorization is
      // compared against are rebuilt from the live state right now, so a plan
      // that went stale between signing and submitting is refused, not relayed.
      const guarded = purpose === 'anchor'
        ? await outsideGuardedAnchor()
        : await outsideGuardedProposal(body);
      const { label } = relayContext();
      const { gate, controller } = await outsideController(guarded.state);

      const checked = await verifyOutsideAuthorization({
        auth: body.authorization,
        expectedCalls: guarded.calls,
        state: guarded.state,
        gate,
        controller,
        label,
        texts: OUTSIDE_TEXTS[purpose],
      });

      let answer;
      try {
        answer = await relayOutside({
          gate, wireCalldata: checked.wireCalldata, state: guarded.state,
        });
      } catch (e) {
        // The relayer/node failure VERBATIM; nothing is recorded as sent.
        throw new HttpError(502, `the outside relay failed: ${e.message}`);
      }
      const txHash = answer?.transaction_hash ?? null;
      if (!txHash) {
        return sendJson(res, 502, {
          relayed: false,
          answer, // verbatim, so nothing is hidden
          message: 'the relayer answered with no transaction hash',
        });
      }

      if (purpose === 'anchor') {
        // NO submission record here - deliberately. The anchor's only record
        // is written by /api/anchor/record, and only after a SUCCEEDED receipt
        // AND a fresh read-back of the registry. A relay answer is a tx hash,
        // not a fact about the chain.
        return sendJson(res, 200, {
          relayed: true,
          txHash,
          purpose: 'anchor',
          relayer: answer?.relayer ?? null,
          scheme: body.authorization.scheme,
          signerAddress: body.authorization.signerAddress ?? null,
          controller,
          nonce: checked.nonce,
          digest: checked.digest,
          anchor: {
            agentId: guarded.agentId,
            root: guarded.root,
            count: guarded.count,
          },
        });
      }

      const submission = {
        proposalId: guarded.proposal.id,
        submittedAt: Date.now(),
        status: 'BROADCAST', // the FINAL status comes from a receipt, never from us
        kind: 'outside',
        via: 'outside-relay',
        tx_hash: txHash,
        relayer: answer?.relayer ?? null,
        scheme: body.authorization.scheme,
        signerAddress: body.authorization.signerAddress ?? null,
        controller,
        nonce: checked.nonce,
        digest: checked.digest,
        revert_reason: null,
        message: null,
        log: null,
      };
      saveSubmission(submission);
      return sendJson(res, 200, { relayed: true, txHash, submission });
    }

    // ------------------------------------------- the wallet-submitted outside (OBS-31)
    // Ready X's signing simulation replays the authorized CALLS from the wallet,
    // so a controller-bound self-call (set_spending_policy) can NEVER pass that
    // model: from any caller but the gate it answers 'Account: unauthorized' -
    // the exact panic tests/lib.cairo pins for an outsider. The relayer path
    // therefore dies in the wallet popup no matter how valid it is. The answer
    // that keeps every control: the wallet carries execute_from_outside_v2 as
    // its OWN transaction. /api/outside/wire runs the SAME guard and the SAME
    // four controls as the relay and hands the wire call back UNRELAYED; the
    // wallet sends it (simulation now matches reality: ANY_CALLER binding, its
    // own signature, open window, fresh nonce, gate runs the self-call as
    // itself); /api/outside/record writes the record from THE CHAIN's copy of
    // that transaction and from the receipt - never from the request's word.
    if (req.method === 'POST' && path === '/api/outside/wire') {
      const body = await readJson(req);
      const guarded = await outsideGuardedProposal(body);
      const { label } = relayContext();
      const { gate, controller } = await outsideController(guarded.state);
      const checked = await verifyOutsideAuthorization({
        auth: body.authorization,
        expectedCalls: guarded.calls,
        state: guarded.state,
        gate,
        controller,
        label,
        texts: OUTSIDE_TEXTS.proposal,
      });
      return sendJson(res, 200, {
        to: gate,
        entrypoint: 'execute_from_outside_v2',
        calldata: checked.wireCalldata,
        nonce: checked.nonce,
        digest: checked.digest,
        controller,
      });
    }

    if (req.method === 'POST' && path === '/api/outside/record') {
      const body = await readJson(req);
      const txHash = body.txHash;
      if (!txHash || !/^0x[0-9a-fA-F]+$/.test(String(txHash))) {
        throw bad('txHash must be a hex transaction hash (?txHash=0x...)');
      }
      let answer;
      try {
        answer = await readTransaction(txHash);
      } catch (e) {
        throw new HttpError(502, `the transaction read failed: ${e.message}`);
      }
      const tx = answer?.result ?? null;
      if (answer?.error || !tx) {
        throw conflict(`the chain has no transaction ${txHash} - refusing to ` +
          'record a submission it cannot read back');
      }
      // A retry for an already-recorded transaction completes the EXISTING
      // record from the receipt: no second record, and no re-run of the
      // proposal guard (that guard exists to refuse a second SUBMISSION; this
      // transaction is already the chain's, and its calls were verified when
      // the record was first written).
      const existing = loadSubmissions().submissions
        .filter((s) => s.tx_hash && normHex(s.tx_hash) === normHex(txHash)).pop() ?? null;
      if (existing) {
        if (body.proposalId && existing.proposalId !== body.proposalId) {
          throw conflict(`tx ${txHash} is already recorded against proposal ` +
            `'${existing.proposalId}' - refusing to also record it as ` +
            `'${body.proposalId}'`);
        }
        const done = await completeSubmissionFromReceipt(txHash);
        return sendJson(res, 200, {
          recorded: true,
          final: done.final,
          receipt: done.receipt,
          submission: done.submission ?? existing,
        });
      }
      // verifyApplied (OBS-36): the tx being adopted may be the one that ALREADY
      // applied the amendment - the live policy then equals the target, and the
      // expected calls are the live values. Every other control below is unchanged.
      const guarded = await outsideGuardedProposal(body, { verifyApplied: true });
      const state = guarded.state;
      const { gate, controller } = await outsideController(state);
      // The transaction's own words, parsed. Account-invoke calldata is flat
      // (OBS-16): [callsLen, to, selector, cdLen, ...wire]; the OutsideExecution
      // wire is [caller, nonce, after, before, innerLen, (to, selector, cdLen,
      // cd...)*, sigLen, sig...]. Every field below comes from THE CHAIN's copy
      // of the transaction - the request body contributed only its hash.
      const cd = (tx.calldata ?? []).map((v) => hexBig(v));
      const selOutside = hexBig(state.selectors.execute_from_outside_v2);
      const shape = `tx ${txHash}`;
      if (cd.length < 4 || BigInt(cd[0]) !== 1n) {
        throw conflict(`${shape} carries ${cd[0] ?? 'no'} call(s), not exactly one - ` +
          'refusing to record it as a single outside execution');
      }
      if (normHex(cd[1]) !== normHex(gate) || normHex(cd[2]) !== normHex(selOutside)) {
        throw conflict(`${shape} does not call execute_from_outside_v2 on this gate - ` +
          "refusing to record it as this proposal's submission");
      }
      const wireLen = Number(BigInt(cd[3]));
      const wire = cd.slice(4, 4 + wireLen);
      if (wire.length !== wireLen) {
        throw conflict(`${shape} calldata is truncated mid-authorization - refusing`);
      }
      if (normHex(wire[0]) !== ANY_CALLER_FELT) {
        throw conflict(`${shape} names a specific caller, not ANY_CALLER - this ` +
          'record path only covers authorizations anyone may submit');
      }
      const nonce = wire[1];
      // The inner calls, compared against what the LIVE mandate produces right
      // now - control 2's rule applied to the chain's copy of the calls. (The
      // window is NOT re-checked here: the chain enforced it at execution time,
      // and a receipt read later would otherwise refuse an honest record.)
      const innerLen = Number(BigInt(wire[4]));
      const inner = [];
      let at = 5;
      for (let i = 0; i < innerLen; i += 1) {
        const cdLen = Number(BigInt(wire[at + 2]));
        inner.push({
          to: wire[at], selector: wire[at + 1],
          calldata: wire.slice(at + 3, at + 3 + cdLen),
        });
        at += 3 + cdLen;
      }
      if (inner.length !== guarded.calls.length) {
        throw conflict(`${shape} carries ${inner.length} inner call(s), but the live ` +
          `mandate produces ${guarded.calls.length} - refusing to record it`);
      }
      for (let i = 0; i < inner.length; i += 1) {
        const want = guarded.calls[i];
        const got = inner[i];
        const wantSel = hexBig(selectorFromName(want.entrypoint));
        const wantCd = (want.calldata ?? []).map((v) => normHex(v));
        if (normHex(got.to) !== normHex(want.to)
          || normHex(got.selector) !== normHex(wantSel)
          || wantCd.length !== got.calldata.length
          || wantCd.some((v, j) => v !== normHex(got.calldata[j]))) {
          throw conflict(`${shape} inner call #${i + 1} is not the call the live mandate ` +
            'produces - refusing to record a different execution as this approval');
        }
      }
      // One record per transaction, written once, from the chain's copy.
      const submission = {
        proposalId: guarded.proposal.id,
        submittedAt: Date.now(),
        status: 'BROADCAST', // the FINAL status comes from a receipt, never from us
        kind: 'outside',
        via: 'wallet-submitted',
        tx_hash: txHash,
        sender: tx.sender_address ?? null,
        relayer: null, // nobody carried it for the owner: the wallet sent it itself
        scheme: 'wallet-snip12-src9',
        signerAddress: tx.sender_address ?? null,
        controller,
        nonce,
        digest: null, // verified at /api/outside/wire, and again by the chain itself
        revert_reason: null,
        message: null,
        log: null,
      };
      saveSubmission(submission);
      const done = await completeSubmissionFromReceipt(txHash);
      return sendJson(res, 200, {
        recorded: true,
        final: done.final,
        receipt: done.receipt,
        submission: done.submission ?? submission,
      });
    }

    if (req.method === 'POST' && path === '/api/anchor/plan') {
      // The same guard /api/anchor runs before touching the chain, but the
      // output is a PLAN for the browser to sign - nothing is submitted here.
      // The guard is SHARED with /api/outside/plan (purpose: anchor), so the
      // pasted-key and wallet paths can never disagree about what is anchorable.
      const guarded = await outsideGuardedAnchor();
      const plan = await planForCalls(guarded.calls, {
        kind: 'anchor',
        agentId: guarded.agentId,
        root: guarded.root,
        count: guarded.count,
      });
      return sendJson(res, 200, plan);
    }

    if (req.method === 'POST' && path === '/api/anchor/record') {
      // The record is written only when the CHAIN says the anchor happened:
      // a SUCCEEDED receipt for this transaction AND the registry holding
      // exactly the claimed fingerprint, read back fresh.
      const body = await readJson(req);
      const { tx_hash: txHash, agentId, root, count } = body;
      if (!txHash || !agentId || root == null || count == null) {
        throw bad('tx_hash, agentId, root and count are all required');
      }
      let answer;
      try {
        answer = await readReceipt(txHash);
      } catch (e) {
        throw new HttpError(502, `the node could not be reached: ${e.message}`);
      }
      if (answer?.error) {
        throw conflict(`the chain has no receipt for ${txHash}: ` +
          `${answer.error?.message ?? 'unknown error'}`);
      }
      if (answer?.result?.execution_status !== 'SUCCEEDED') {
        throw conflict(`transaction ${txHash} is ` +
          `${answer?.result?.execution_status ?? 'not final'} - only a SUCCEEDED ` +
          'anchor is recorded');
      }
      const onchain = await readAnchor(agentId);
      if (!onchain.available) {
        throw conflict(`the registry could not be read back: ${onchain.error}`);
      }
      if (BigInt(onchain.root) !== BigInt(root)
        || onchain.count !== Number(count)) {
        throw conflict(`the chain holds root ${onchain.root} / count ` +
          `${onchain.count}, not the claimed ${root} / ${count} - refusing to ` +
          'record a fingerprint the chain does not have');
      }
      const state = loadState();
      const already = (state.layer_d?.anchors ?? [])
        .some((a) => a.tx_hash && normHex(a.tx_hash) === normHex(txHash));
      if (already) {
        throw conflict(`tx ${txHash} is already recorded in the state file - ` +
          'refusing to record the same anchor twice');
      }
      recordAnchor({
        date: new Date().toISOString(),
        agent_id: agentId,
        root,
        count: Number(count),
        anchorer: state.contracts?.gate_account?.address ?? null,
        tx_hash: txHash,
        source: 'console-relay',
      });
      // Read the chain again rather than trusting what was just written.
      const after = await readAnchor(agentId);
      return sendJson(res, 200, { recorded: true, anchor: after });
    }

    throw new HttpError(404, `no API route for ${req.method} ${path}`);
  }

  // ---------------------------------------------------------------- static

  function resolveVendor(pathname) {
    if (!vendorCache) {
      vendorCache = [
        ['/vendor/scure/starknet/', vendorRoots.scure],
        ['/vendor/noble/curves/', vendorRoots.curves],
        ['/vendor/noble/hashes/', vendorRoots.hashes],
      ];
    }
    for (const [prefix, root] of vendorCache) {
      if (pathname.startsWith(prefix)) {
        return { root, rest: pathname.slice(prefix.length) };
      }
    }
    return null;
  }

  function serveStatic(res, pathname, headOnly = false) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw bad('malformed URL path');
    }
    if (rel.includes('\0')) throw bad('malformed URL path');
    if (rel === '/') rel = '/index.html';

    let root = webDir;
    let relPath = rel.replace(/^\/+/, '');
    const vendor = resolveVendor(rel);
    if (vendor) {
      root = vendor.root;
      relPath = vendor.rest;
    }

    const rootReal = realpathSync(root);
    const filePath = resolve(rootReal, relPath);
    if (filePath !== rootReal && !filePath.startsWith(rootReal + sep)) {
      throw new HttpError(403, 'path escapes the served directory');
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new HttpError(404, 'not found');
    }

    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    let body = readFileSync(filePath);

    const headers = {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };

    if (ext === '.html') {
      // The import map is inline, so the page's CSP uses a per-response nonce.
      const nonce = randomBytes(16).toString('base64');
      body = Buffer.from(body.toString('utf8').replaceAll('__CSP_NONCE__', nonce), 'utf8');
      headers['content-security-policy'] = [
        "default-src 'self'",
        // Wallet extensions (Argent X, Braavos) inject window.starknet into the
        // page's MAIN world, and Chrome applies the PAGE's CSP to main-world
        // scripts (developer.chrome.com > Content scripts > Content Security
        // Policy). Without the chrome-extension: scheme a strict nonce CSP
        // makes every native-wallet connect impossible (track 2, phase 3).
        // This does not weaken the console against a malicious extension in
        // any real sense: an extension's content scripts already share the
        // DOM and can read or modify anything on the page, nonce or not.
        `script-src 'self' 'nonce-${nonce}' chrome-extension:`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        'img-src \'self\' data:',
        // The same main-world rule applies to the wallet's FETCHES: the
        // injected provider and Ready X's signing simulation talk to the
        // wallet's OWN rpc node from this page's origin. With a bare
        // connect-src 'self' those fetches die - "Failed to fetch" at connect
        // and "Tx not executed: Argent multicall failed" at signing, both
        // observed live 2026-10-26 (OBS-30) - so the wallet's node host is
        // allowlisted here. Bounded list, never a bare https: - the page must
        // not gain the ability to phone home anywhere else. If a future wallet
        // build moves RPC host, the console log names the blocked host and the
        // refusal says so; add it here.
        "connect-src 'self' https://rpc.starknet-sepolia.lava.build " +
          'https://api.cartridge.gg',
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; ');
      headers['referrer-policy'] = 'no-referrer';
      headers['x-frame-options'] = 'DENY';
    }

    if (headOnly) headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    if (headOnly) {
      res.end();
      return;
    }
    res.end(body);
  }

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((e) => {
        const err = asHttpError(e);
        if (err.status >= 500) console.error(`[api] ${req.method} ${url.pathname}:`, err.message);
        sendJson(res, err.status, { error: err.message });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    try {
      serveStatic(res, url.pathname, req.method === 'HEAD');
    } catch (e) {
      const err = asHttpError(e);
      sendJson(res, err.status, { error: err.message });
    }
  });

  return server;
}

// Spawn the existing owner submitter and parse its machine-readable last line.
// This is the harness's stand-in for "the user's wallet submits the transaction".
export function runOwnerTx(ownerTxPath, calls, { timeoutMs = 240_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [ownerTxPath, '--calls', JSON.stringify(calls)], {
      cwd: dirname(ownerTxPath),
      windowsHide: true,
    });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`owner-tx.mjs did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const match = out.match(/^OWNER_TX_RESULT (.+)$/m);
      if (!match) {
        reject(new Error('owner-tx.mjs printed no OWNER_TX_RESULT line:\n' + out.slice(-2000)));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(match[1]);
      } catch (e) {
        reject(new Error(`could not parse OWNER_TX_RESULT: ${e.message}`));
        return;
      }
      resolvePromise({ ...parsed, log: out });
    });
  });
}

// The estimate half of the harness: owner-tx.mjs --dry-run prices the transaction
// (padded, exactly like the live path) WITHOUT signing or submitting anything.
// The browser then signs over those very bounds, so what was priced is what goes.
export function runOwnerTxDryRun(ownerTxPath, calls, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath,
      [ownerTxPath, '--calls', JSON.stringify(calls), '--dry-run'], {
        cwd: dirname(ownerTxPath),
        windowsHide: true,
      });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`owner-tx.mjs --dry-run did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const match = out.match(/^OWNER_TX_RESULT (.+)$/m);
      if (!match) {
        reject(new Error('owner-tx.mjs --dry-run printed no OWNER_TX_RESULT line:\n' + out.slice(-2000)));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(match[1]);
      } catch (e) {
        reject(new Error(`could not parse OWNER_TX_RESULT: ${e.message}`));
        return;
      }
      if (parsed.status !== 'DRY_RUN') {
        reject(new Error(`owner-tx.mjs --dry-run ended ${parsed.status}: ${parsed.message ?? ''}`));
        return;
      }
      if (!parsed.nonce || !parsed.resourceBounds) {
        reject(new Error('owner-tx.mjs --dry-run returned no nonce or resourceBounds'));
        return;
      }
      resolvePromise({ nonce: parsed.nonce, resourceBounds: parsed.resourceBounds });
    });
  });
}

// A plain JSON-RPC call. The relay uses this for exactly two things: carrying a
// finished, signed transaction (starknet_addInvokeTransaction) and reading a
// receipt. The server adds nothing to the transaction and reads nothing secret.
export async function rpcCall(rpcUrl, method, params, { timeoutMs = 20_000 } = {}) {
  let res;
  let text;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A silent node must produce a loud error, not an endless hang (OBS-35:
      // the owner's "Read again" spun forever on exactly that).
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    text = await res.text();
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return {
        error: {
          code: 'TIMEOUT',
          message: `the chain node did not answer within ${timeoutMs / 1000}s - ` +
            'the read failed loudly instead of hanging',
        },
      };
    }
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'HTTP', message: `the node answered ${res.status} with non-JSON`, body: text.slice(0, 300) } };
  }
}

// ------------------------------------------------------------------ start

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT ?? 4173);
  const server = createConsoleServer({
    statePath: process.env.STATE_PATH ?? DEFAULT_STATE,
    storePath: process.env.STORE_PATH ?? DEFAULT_STORE,
  });
  server.on('error', (e) => {
    console.error(`server failed: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`permission console: http://127.0.0.1:${port}`);
    console.log('owner key: never sent to this server (browser-side signing only)');
    console.log('harness: owner-tx.mjs submits the final transaction (testnet only)');
  });
}
