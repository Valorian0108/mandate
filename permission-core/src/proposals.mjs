// The proposal flow: what makes ASK_USER real.
//
// When the engine blocks an agent action (DENY) or defers to the user (ASK_USER),
// a PROPOSAL is created: who wants what, and exactly why the mandate blocks it.
// Nothing happens to a proposal except through a resolution that carries a
// signature from the OWNER key - the same key the blockchain itself checks
// (get_public_key on the GateAccount). That is the anti-theater property:
//
//   The company can create proposals, list them, even edit its own database.
//   It CANNOT approve one. Only the holder of the owner key can.
//
// Resolutions:
//   execute-once : the owner signs and submits the exact requested action themselves
//                  (the agent never gets extra power; the user acts).
//   amend        : the owner signs an on-chain mandate change (e.g. raise the
//                  per-call cap, allow a merchant); the agent may retry AFTER the
//                  change is on-chain and the engine re-reads it.
//   decline      : recorded; the block stands.
//
// Signatures are Starknet ECDSA (@scure/starknet - the same curve the chain uses)
// over a digest that covers the FULL proposal plus the resolution intent, so a
// signature for "15 to merchant once" cannot be replayed as "50 to merchant" or
// as a mandate amendment. Curve constants come from the library (Point.CURVE()),
// never hardcoded from memory - the ISRC6_ID lesson.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as stark from '@scure/starknet';
import {
  getMessageHash,
  MANDATE_DOMAIN_NAME,
  MANDATE_DOMAIN_VERSION,
  REVISION_ACTIVE,
} from '../web/typed-data.js';

const { a: CURVE_A, b: CURVE_B, p: CURVE_P } = stark.Point.CURVE();
const MASK_250 = (1n << 250n) - 1n; // digests must be < field order (~2^251)

// ---------------------------------------------------------------- digest

// Canonical JSON: sorted keys at every level, so two objects with the same
// content always produce the same bytes.
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  if (typeof value === 'bigint') return '"' + value.toString() + '"';
  return JSON.stringify(value);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// The thing the owner actually signs: proposal content + resolution intent.
export function resolutionDigest(proposal, resolution) {
  const preimage = stableStringify({
    v: 1,
    proposal: {
      id: proposal.id,
      request: proposal.request,
      blockedBecause: proposal.blockedBecause,
    },
    resolution,
  });
  return '0x' + (BigInt('0x' + sha256Hex(preimage)) & MASK_250).toString(16).padStart(64, '0');
}

// ---------------------------------------------------------------- owner signatures

export function signResolution(digest, ownerPrivateKey) {
  const sig = stark.sign(digest, ownerPrivateKey);
  return {
    r: '0x' + sig.r.toString(16),
    s: '0x' + sig.s.toString(16),
  };
}

// Starknet stores only the x coordinate of the owner public key on-chain.
// Reconstruct both curve points with that x (y and -y) and accept the signature
// if EITHER verifies - only the owner's private key can produce one that does.
function pointBytesFromX(x, y) {
  const toBytes = (v) =>
    Uint8Array.from(v.toString(16).padStart(64, '0').match(/../g).map((h) => parseInt(h, 16)));
  return Uint8Array.from([4, ...toBytes(x), ...toBytes(y)]);
}

function verifyRawOwnerSignature(digest, signature, ownerPublicKeyX) {
  const x = BigInt(ownerPublicKeyX);
  const mod = (v) => ((v % CURVE_P) + CURVE_P) % CURVE_P;
  const rhs = mod(mod(mod(x * x) * x) + mod(CURVE_A * x) + CURVE_B);
  let y;
  try {
    y = stark.Fp251.sqrt(rhs);
  } catch {
    return false; // x is not on the curve at all
  }
  // @scure/starknet's verify wants a Signature instance, not a plain {r,s} object.
  const sig = new stark.Signature(BigInt(signature.r), BigInt(signature.s));
  return (
    stark.verify(sig, digest, pointBytesFromX(x, y)) ||
    stark.verify(sig, digest, pointBytesFromX(x, mod(-y)))
  );
}

// ---------------------------------------------------------------- signature schemes

// Old records carry a raw {r,s} signature over the canonical digest: "digest-v1".
// New records carry a SNIP-12 typed-data message the owner's wallet displayed:
// "snip12-v1". A native wallet (Argent X, track 2 phase 3) signs the same message
// but can only bind ITS OWN address into the hash - starknet.js's Account passes
// `this.address` into Signer.signMessage and a dapp cannot override it - so its
// envelope carries the wallet address it signed with: "wallet-snip12-v1". The
// scheme is explicit on new records; a missing scheme means the old format, so
// every signature ever recorded keeps verifying.
export const SIGNATURE_SCHEMES = Object.freeze({
  DIGEST_V1: 'digest-v1',
  SNIP12_V1: 'snip12-v1',
  WALLET_SNIP12_V1: 'wallet-snip12-v1',
});

const KNOWN_SCHEMES = Object.values(SIGNATURE_SCHEMES);

export function signatureScheme(signature) {
  const scheme = signature?.scheme ?? SIGNATURE_SCHEMES.DIGEST_V1;
  if (!KNOWN_SCHEMES.includes(scheme)) {
    throw new Error(`unknown signature scheme '${scheme}' - expected ` +
      `one of: ${KNOWN_SCHEMES.join(', ')}`);
  }
  return scheme;
}

// A typed-data signature is only accepted when EVERYTHING it claims matches the
// server's own recomputation: our domain, this chain, this kind of action, and
// exactly this digest. The typed data is the carrier, never the source of truth.
// `hashAddress` is the address the SNIP-12 hash binds - the GateAccount for
// in-tab signatures, the wallet's own address for wallet signatures.
function verifyMandateActionSignature(digest, signature, ownerPublicKeyX, context, hashAddress) {
  const typedData = signature?.typedData;
  if (!typedData || typeof typedData !== 'object') return false;
  try {
    if (typedData.primaryType !== 'MandateAction') return false;
    const domain = typedData.domain ?? {};
    if (domain.name !== MANDATE_DOMAIN_NAME) return false;
    if (String(domain.version) !== String(MANDATE_DOMAIN_VERSION)) return false;
    if (String(domain.chainId) !== String(context.chainId)) return false;
    if (String(domain.revision) !== REVISION_ACTIVE) return false;
    const message = typedData.message ?? {};
    if (message.kind !== context.kind) return false;
    if (BigInt(message.digest) !== BigInt(digest)) return false;
    const messageHash = getMessageHash(typedData, hashAddress);
    // @scure's verify takes a hex string, not a BigInt.
    return verifyRawOwnerSignature('0x' + messageHash.toString(16), signature, ownerPublicKeyX);
  } catch {
    return false;
  }
}

export function verifyOwnerSignature(digest, signature, ownerPublicKeyX, context = null) {
  let scheme;
  try {
    scheme = signatureScheme(signature);
  } catch {
    return false;
  }
  if (scheme === SIGNATURE_SCHEMES.SNIP12_V1) {
    if (!context?.kind || !context?.accountAddress || !context?.chainId) return false;
    return verifyMandateActionSignature(
      digest, signature, ownerPublicKeyX, context, context.accountAddress);
  }
  if (scheme === SIGNATURE_SCHEMES.WALLET_SNIP12_V1) {
    if (!context?.kind || !context?.chainId) return false;
    // The envelope must say which address the wallet bound into the hash. It is
    // not trusted as an identity claim - it only selects the hash. A forged
    // address yields a hash no signature of this wallet can match, and the
    // ECDSA check against the chain-read OWNER key is still the only gate.
    const signer = signature?.signerAddress;
    if (typeof signer !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(signer)) return false;
    return verifyMandateActionSignature(digest, signature, ownerPublicKeyX, context, signer);
  }
  return verifyRawOwnerSignature(digest, signature, ownerPublicKeyX);
}

// ---------------------------------------------------------------- store

const RESOLUTION_TYPES = {
  'execute-once': 'APPROVED_ONCE',
  amend: 'AMENDED',
  decline: 'DECLINED',
};

export function createProposalStore({
  filePath,
  getOwnerPublicKey,
  getSignatureContext = null,
  now = () => Date.now(),
}) {
  if (typeof getOwnerPublicKey !== 'function') {
    throw new Error('a proposal store REQUIRES getOwnerPublicKey() - approvals must be ' +
      'verifiable against the owner key, and the chain is the source of truth for it');
  }

  function load() {
    if (!existsSync(filePath)) return { proposals: [] };
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }
  function save(db) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(db, null, 2));
  }

  // Create a proposal from a blocked/deferred decision. `decision` comes straight
  // from engine.decide - the reason the user will read is the engine's own words.
  function create(request, decision, contextNote = '') {
    if (decision.verdict === 'ALLOW') {
      throw new Error('an ALLOWED action needs no proposal - proposals exist for blocks');
    }
    const db = load();
    const createdAt = now();
    const id = sha256Hex(stableStringify({ request, createdAt, n: db.proposals.length }))
      .slice(0, 16);
    const proposal = {
      id,
      createdAt,
      request,
      blockedBecause: {
        verdict: decision.verdict,
        code: decision.code,
        reason: decision.reason,
        gate: decision.gate,
      },
      contextNote,
      status: 'PENDING',
      resolution: null,
      signature: null,
      resolvedAt: null,
    };
    db.proposals.push(proposal);
    save(db);
    return proposal;
  }

  // Resolve with an owner signature. THROWS (rather than silently failing) when:
  //   - the proposal is unknown or already resolved (no double-spends of approvals)
  //   - the resolution type is not one the flow defines
  //   - the signature does not verify against the on-chain owner key
  async function resolve(proposalId, resolution, signature) {
    const status = RESOLUTION_TYPES[resolution?.type];
    if (!status) {
      throw new Error(`unknown resolution type '${resolution?.type}' - ` +
        `expected one of: ${Object.keys(RESOLUTION_TYPES).join(', ')}`);
    }
    if (resolution.type === 'amend' && !resolution.amendment) {
      throw new Error("an 'amend' resolution must say exactly what changes (amendment)");
    }
    const db = load();
    const proposal = db.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error(`no proposal '${proposalId}'`);
    if (proposal.status !== 'PENDING') {
      throw new Error(`proposal '${proposalId}' is already ${proposal.status} - ` +
        'resolutions are final and cannot be re-resolved');
    }
    if (!signature?.r || !signature?.s) {
      throw new Error('a resolution without an owner signature is not a resolution - ' +
        'the user must sign (this is the whole point)');
    }

    const digest = resolutionDigest(proposal, resolution);
    const ownerPub = await getOwnerPublicKey();
    let scheme = null;
    try {
      scheme = signatureScheme(signature);
    } catch {
      // Falls through to the verifier below, which rejects it as an invalid
      // signature rather than surfacing a different error path.
    }
    let context = null;
    if (scheme === SIGNATURE_SCHEMES.SNIP12_V1 || scheme === SIGNATURE_SCHEMES.WALLET_SNIP12_V1) {
      if (!getSignatureContext) {
        throw new Error('this server cannot verify typed-data signatures: no account ' +
          'context was configured - refusing the approval');
      }
      context = await getSignatureContext();
    }
    if (!verifyOwnerSignature(digest, signature, ownerPub, context)) {
      throw new Error('signature does not verify against the OWNER key - rejected. ' +
        'Only the user can approve; the app, the agent and this database cannot.');
    }

    proposal.status = status;
    proposal.resolution = resolution;
    proposal.signature = signature;
    proposal.resolvedAt = now();
    proposal.ownerPublicKeyAtResolution = ownerPub;
    save(db);
    return proposal;
  }

  // Convenience for the user-side signer UI: the digest to sign for a resolution.
  function digestFor(proposalId, resolution) {
    const db = load();
    const proposal = db.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new Error(`no proposal '${proposalId}'`);
    return resolutionDigest(proposal, resolution);
  }

  function list(status) {
    const db = load();
    return status ? db.proposals.filter((p) => p.status === status) : db.proposals;
  }
  function get(proposalId) {
    return load().proposals.find((p) => p.id === proposalId) ?? null;
  }

  return { create, resolve, digestFor, list, get };
}

// ---------------------------------------------------------------- live owner key

// Reads the owner public key from the deployed GateAccount on Sepolia. This is
// what binds proposal approvals to the chain: the verifier asks the NETWORK who
// the owner is, not the company's database.
export async function chainOwnerPublicKey({ statePath } = {}) {
  const path = statePath ??
    new URL('../../gate-account/.sepolia/state.json', import.meta.url);
  const { readFileSync: rf } = await import('node:fs');
  const state = JSON.parse(rf(path, 'utf8'));
  const { call } = await import('./mandate-reader.mjs');
  const [pub] = await call(
    state.contracts.gate_account.address,
    state.selectors.get_public_key,
    [],
  );
  return pub;
}
