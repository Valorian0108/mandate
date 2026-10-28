// Browser-side owner signing. This file is served to the page and runs in the
// tab - the owner private key never leaves it.
//
// It mirrors the server's digest algorithm EXACTLY (src/proposals.mjs:
// stableStringify + sha256 masked to 250 bits). That duplication is deliberate:
// the browser recomputes the digest it is about to sign, and the server verifies
// the signature against its own computation. If the two implementations ever
// drift, the server rejects the signature - loudly, not silently.
//
// Curve operations come from @scure/starknet (the same library the server uses).
// No curve constant is typed from memory.

import { getStarkKey, sign, Point } from '@scure/starknet';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

const MASK_250 = (1n << 250n) - 1n;

// Must match src/proposals.mjs stableStringify byte for byte.
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  if (typeof value === 'bigint') return '"' + value.toString() + '"';
  return JSON.stringify(value);
}

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// The exact thing the owner signs: full proposal + resolution intent.
export function resolutionDigest(proposal, resolution) {
  if (!proposal?.id || !proposal.request || !proposal.blockedBecause) {
    throw new Error('cannot compute a digest without the full proposal (id, request, blockedBecause)');
  }
  const preimage = stableStringify({
    v: 1,
    proposal: {
      id: proposal.id,
      request: proposal.request,
      blockedBecause: proposal.blockedBecause,
    },
    resolution,
  });
  return '0x' + (BigInt('0x' + bytesToHex(sha256(utf8ToBytes(preimage)))) & MASK_250)
    .toString(16).padStart(64, '0');
}

// Normalise a felt exactly like src/evidence.mjs normFelt: no masking, so public
// keys and roots keep every bit. A masked value would sign the wrong thing.
function normFelt(value) {
  if (value === undefined || value === null) {
    throw new Error('a felt value is required');
  }
  return '0x' + BigInt(value).toString(16);
}

// The exact thing the owner signs to move an agent's trust. Must match
// src/ladder.mjs ladderChangeDigest byte for byte: same fields, same order, same
// 250-bit mask. If the two ever drift, the server rejects the signature loudly.
export function ladderChangeDigest(change) {
  if (!change?.agentId || !change.evidenceRoot) {
    throw new Error('cannot compute a ladder digest without the agent id and the evidence root');
  }
  const preimage = stableStringify({
    v: 1,
    kind: 'layer-d:ladder-change',
    agentId: change.agentId,
    seq: Number(change.seq),
    from: change.from,
    to: change.to,
    reason: change.reason,
    evidenceRoot: normFelt(change.evidenceRoot),
    evidenceCount: Number(change.evidenceCount),
    at: Number(change.at),
    owner: normFelt(change.owner),
  });
  return '0x' + (BigInt('0x' + bytesToHex(sha256(utf8ToBytes(preimage)))) & MASK_250)
    .toString(16).padStart(64, '0');
}

// The exact thing the owner signs to vouch for an app witness key (Track 3).
// Must match src/attestations.mjs witnessAttestationDigest byte for byte: same
// fields, same order, same 250-bit mask, same null handling for the genesis
// link's supersedes. If the two ever drift, the server rejects the signature
// loudly - and tests/signer.test.mjs catches the drift before an owner hits it.
export function witnessAttestationDigest(att) {
  if (!att?.agentId || !att.witness) {
    throw new Error('cannot compute an attestation digest without the agent id and the witness key');
  }
  const preimage = stableStringify({
    v: 1,
    kind: 'layer-d:witness-attestation',
    agentId: att.agentId,
    seq: Number(att.seq),
    witness: normFelt(att.witness),
    supersedes: att.supersedes === null || att.supersedes === undefined
      ? null
      : normFelt(att.supersedes),
    validFrom: Number(att.validFrom),
    reason: att.reason,
    at: Number(att.at),
    owner: normFelt(att.owner),
  });
  return '0x' + (BigInt('0x' + bytesToHex(sha256(utf8ToBytes(preimage)))) & MASK_250)
    .toString(16).padStart(64, '0');
}

export function isValidPrivateKey(key) {
  const k = String(key ?? '').trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(k)) return false;
  try {
    const v = BigInt(k);
    if (v <= 0n) return false;
    const { n } = Point.CURVE();
    if (v >= n) return false;
    getStarkKey(k); // derives without throwing
    return true;
  } catch {
    return false;
  }
}

// x-only public key, exactly what GateAccount stores and get_public_key returns.
export function ownerPublicKeyFromPrivate(key) {
  return getStarkKey(String(key).trim());
}

// Signs any digest with the owner key. Proposals and ladder changes use the same
// curve and the same key; only the digest differs. `signResolution` is kept as an
// alias because that is what the proposal flow calls it.
export function signDigest(digest, ownerPrivateKey) {
  const sig = sign(digest, String(ownerPrivateKey).trim());
  return {
    r: '0x' + sig.r.toString(16),
    s: '0x' + sig.s.toString(16),
  };
}

export const signResolution = signDigest;
