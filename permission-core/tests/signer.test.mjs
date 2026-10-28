// The browser half of the signing path, checked against the server half.
//
// Why this file exists: web/signer.js DUPLICATES src/proposals.mjs's digest
// algorithm on purpose - the browser recomputes the digest it is about to sign
// so it cannot be tricked into signing something the server described differently.
// Duplication is only safe if it is TESTED to agree. Every case below is the
// digest check standing alone: if the two implementations drift, these fail
// loudly instead of the UI silently signing the wrong bytes.
//
// The last test walks the ACTUAL served import graph and refuses to pass if any
// module the page loads needs Node (a `node:` import). That is the browser-safety
// claim verified, not asserted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getStarkKey, Point } from '@scure/starknet';

import {
  isValidPrivateKey, ladderChangeDigest as browserLadderDigest,
  ownerPublicKeyFromPrivate, resolutionDigest as browserDigest,
  signResolution as browserSign, stableStringify as browserStable,
  witnessAttestationDigest as browserWitnessDigest,
} from '../web/signer.js';
import {
  resolutionDigest as serverDigest, signResolution as serverSign,
  stableStringify as serverStable, verifyOwnerSignature,
} from '../src/proposals.mjs';
import { ladderChangeDigest as serverLadderDigest } from '../src/ladder.mjs';
import { witnessAttestationDigest as serverWitnessDigest } from '../src/attestations.mjs';
import { createConsoleServer } from '../web/server.mjs';

const OWNER_PRIV = '0x1';
const OWNER_PUB = getStarkKey(OWNER_PRIV); // x-only, exactly what the chain stores

const TRANSFER_SELECTOR =
  '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e';

function proposal(overrides = {}) {
  return {
    id: 'fe0098ada34c9af3',
    createdAt: 1761000000000,
    request: {
      user: 'user:0x2502f82a',
      agent: 'agent:0x100d2c0e',
      action: 'spend:transfer',
      resource: 'token:0x01f51d51',
      context: {
        recipient: '0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38',
        amount: '25',
        token: '0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd',
        now: 1761000000,
      },
    },
    blockedBecause: {
      verdict: 'DENY',
      gate: 'spend',
      action: 'spend:transfer',
      code: 'over-per-call-cap',
      reason: 'amount 25 exceeds the per-call cap of 20',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------- digest agreement

test('the browser digest equals the server digest for every resolution shape', () => {
  const p = proposal();
  const resolutions = [
    { type: 'execute-once' },
    { type: 'decline' },
    { type: 'amend', amendment: { kind: 'raise-per-call-cap', token: p.request.context.token, maxPerCall: '30' } },
    { type: 'amend', amendment: { kind: 'allow-recipient', token: p.request.context.token, recipient: p.request.context.recipient } },
    // Key order must not matter: canonical JSON sorts at every level.
    { type: 'amend', amendment: { maxPerCall: '30', kind: 'raise-per-call-cap', token: p.request.context.token } },
  ];
  for (const r of resolutions) {
    assert.equal(browserDigest(p, r), serverDigest(p, r),
      `digest drift for ${JSON.stringify(r)}`);
    assert.match(browserDigest(p, r), /^0x[0-9a-f]{64}$/, 'digest is 64 hex chars, 0x-prefixed');
    assert.ok(BigInt(browserDigest(p, r)) < Point.CURVE().p,
      'the digest must be below the field order or the chain could not check it');
  }
});

test('the digest covers the whole proposal: tampering anywhere changes it', () => {
  const r = { type: 'amend', amendment: { kind: 'raise-per-call-cap', token: '0x01f5', maxPerCall: '30' } };
  const base = serverDigest(proposal(), r);
  const tampered = [
    proposal({ id: 'fe0098ada34c9af4' }),
    proposal({ request: { ...proposal().request, context: { ...proposal().request.context, amount: '26' } } }),
    proposal({ request: { ...proposal().request, context: { ...proposal().request.context, recipient: '0x16cb' } } }),
    proposal({ blockedBecause: { ...proposal().blockedBecause, reason: 'amount 25 exceeds the per-call cap of 21' } }),
  ];
  for (const t of tampered) {
    assert.notEqual(serverDigest(t, r), base, 'a changed proposal must not share a digest');
    assert.equal(browserDigest(t, r), serverDigest(t, r), 'both sides agree on the new digest too');
  }
  // And the resolution itself: a signed "30" is not a signed "50".
  const bigger = { ...r, amendment: { ...r.amendment, maxPerCall: '50' } };
  assert.notEqual(serverDigest(proposal(), bigger), base);
});

test('stableStringify agrees byte for byte, including bigints and unicode', () => {
  const values = [
    { b: 2, a: [1, { d: null, c: true }], z: 'plain' },
    { nested: { deep: { deeper: { x: 1n, y: '0x14' } } } },
    { reason: 'cap 20 — exceeded', note: 'naïve café ✓' },
    [],
    {},
    0,
    -0.5,
    '',
  ];
  for (const v of values) {
    assert.equal(browserStable(v), serverStable(v),
      `stableStringify drift on ${serverStable(v)}`);
  }
  // The canonical form is real: same content, different key order, same bytes.
  assert.equal(browserStable({ a: 1, b: 2 }), browserStable({ b: 2, a: 1 }));
  assert.equal(serverStable({ a: 1, b: 2 }), serverStable({ b: 2, a: 1 }));
});

// The résumé screen signs ladder changes in the browser. If web/signer.js and
// src/ladder.mjs ever drift, every signature the screen produces is rejected by
// the server - this test is what catches the drift before an owner hits it.
test('the browser ladder digest equals the server ladder digest for every change shape', () => {
  const base = {
    version: 1,
    kind: 'ladder-change',
    agentId: '0x01bd3b9f890b7a660ae0158b4e29d548eb0c5c014ef7beaaaddf3088a41941be',
    seq: 2,
    from: 'probation',
    to: 'trusted',
    reason: 'five clean runs inside every limit',
    evidenceRoot: '0x025975b6a3f8ea1a2b9c4d7e0f1234567890abcdef1234567890abcdef12345125b',
    evidenceCount: 4,
    at: 1761000000000,
    owner: OWNER_PUB,
  };
  const shapes = [
    base,
    // Numbers arrive as decimal strings over JSON: the digest must not care.
    { ...base, seq: '2', evidenceCount: '4', at: '1761000000000' },
    // Uppercase and zero-padded felts normalise to the same thing.
    { ...base, evidenceRoot: base.evidenceRoot.toUpperCase().replace('0X', '0x0'), owner: `0x0${OWNER_PUB.slice(2).toUpperCase()}` },
    // Unicode in the reason is signed byte for byte.
    { ...base, reason: 'earned — 3 clean runs ✓' },
    // Key order must not matter: canonical JSON sorts at every level.
    { owner: base.owner, at: base.at, evidenceCount: base.evidenceCount, evidenceRoot: base.evidenceRoot, reason: base.reason, to: base.to, from: base.from, seq: base.seq, agentId: base.agentId, kind: base.kind, version: base.version },
  ];
  for (const c of shapes) {
    assert.equal(browserLadderDigest(c), serverLadderDigest(c),
      `ladder digest drift for ${JSON.stringify(c)}`);
    assert.match(browserLadderDigest(c), /^0x[0-9a-f]{64}$/, 'digest is 64 hex chars, 0x-prefixed');
    assert.ok(BigInt(browserLadderDigest(c)) < Point.CURVE().p,
      'the digest must be below the field order or the chain could not check it');
  }

  // Tampering with ANY signed field changes the digest - the server verifies
  // against this, so a silent difference here would be a forged-promotion hole.
  const baseDigest = serverLadderDigest(base);
  const tampered = [
    { ...base, seq: 3 },
    { ...base, from: 'new' },
    { ...base, to: 'established' },
    { ...base, reason: `${base.reason}.` },
    { ...base, evidenceRoot: `0x${(BigInt(base.evidenceRoot) + 1n).toString(16)}` },
    { ...base, evidenceCount: 5 },
    { ...base, at: base.at + 1 },
    { ...base, owner: getStarkKey('0x2') },
    { ...base, agentId: `0x${'11'.repeat(32)}` },
  ];
  for (const t of tampered) {
    assert.notEqual(serverLadderDigest(t), baseDigest, 'a changed ladder change must not share a digest');
    assert.equal(browserLadderDigest(t), serverLadderDigest(t), 'both sides agree on the new digest too');
  }

  // The browser refuses to digest an incomplete change rather than sign a partial one.
  assert.throws(() => browserLadderDigest({ ...base, agentId: undefined }), /agent id/i);
  assert.throws(() => browserLadderDigest({ ...base, evidenceRoot: null }), /evidence root/i);

  // End to end: the browser's signature over its own digest verifies on the
  // server against the chain owner key - which is exactly what /api/ladder/apply does.
  const digest = browserLadderDigest(base);
  const sig = browserSign(digest, OWNER_PRIV);
  assert.equal(verifyOwnerSignature(serverLadderDigest(base), sig, OWNER_PUB), true);
  assert.equal(verifyOwnerSignature(serverLadderDigest({ ...base, to: 'established' }), sig, OWNER_PUB), false,
    'a signature for probation -> trusted must not verify over a different move');
});

// The résumé screen also signs witness ATTESTATIONS in the browser (Track 3).
// web/signer.js duplicates src/attestations.mjs's digest on purpose, for the
// same reason as above - and this is the drift check for that duplication. If
// the two ever disagree, every attestation the screen produces is rejected by
// /api/witness/attest, and the owner's witness controls are dead in the water.
test('the browser witness digest equals the server witness digest for every attestation shape', () => {
  const witness = getStarkKey('0x3');
  const previous = getStarkKey('0x4');
  const base = {
    version: 1,
    kind: 'witness-attestation',
    agentId: '0x01bd3b9f890b7a660ae0158b4e29d548eb0c5c014ef7beaaaddf3088a41941be',
    seq: 2,
    witness,
    supersedes: previous,
    validFrom: 1761000000000,
    reason: 'rotated after a leak; the old key is history',
    at: 1761000001000,
    owner: OWNER_PUB,
  };
  const shapes = [
    base,
    // The genesis link supersedes nothing - null must survive into the preimage,
    // and an omitted supersedes must mean the same thing on both sides.
    { ...base, seq: 1, supersedes: null },
    { ...base, seq: 1, supersedes: undefined },
    // Numbers arrive as decimal strings over JSON: the digest must not care.
    { ...base, seq: '2', validFrom: '1761000000000', at: '1761000001000' },
    // Uppercase and zero-padded felts normalise to the same thing.
    { ...base, witness: witness.toUpperCase().replace('0X', '0x0'), owner: `0x0${OWNER_PUB.slice(2).toUpperCase()}` },
    // Unicode in the reason is signed byte for byte.
    { ...base, reason: 'rotated — the old key stays history ✓' },
    // Key order must not matter: canonical JSON sorts at every level.
    { owner: base.owner, at: base.at, reason: base.reason, validFrom: base.validFrom, supersedes: base.supersedes, witness: base.witness, seq: base.seq, agentId: base.agentId, kind: base.kind, version: base.version },
  ];
  for (const a of shapes) {
    assert.equal(browserWitnessDigest(a), serverWitnessDigest(a),
      `witness digest drift for ${JSON.stringify(a)}`);
    assert.match(browserWitnessDigest(a), /^0x[0-9a-f]{64}$/, 'digest is 64 hex chars, 0x-prefixed');
    assert.ok(BigInt(browserWitnessDigest(a)) < Point.CURVE().p,
      'the digest must be below the field order or the chain could not check it');
  }

  // Tampering with ANY signed field changes the digest - the server verifies
  // against this, so a silent difference here would be a forged-attestation hole.
  const baseDigest = serverWitnessDigest(base);
  const tampered = [
    { ...base, seq: 3 },
    { ...base, witness: getStarkKey('0x5') },
    { ...base, supersedes: null },                  // a rotation rewritten as a genesis
    { ...base, supersedes: getStarkKey('0x6') },    // linked to a different key
    { ...base, validFrom: base.validFrom + 1 },
    { ...base, reason: `${base.reason}.` },
    { ...base, at: base.at + 1 },
    { ...base, owner: getStarkKey('0x2') },
    { ...base, agentId: `0x${'11'.repeat(32)}` },
  ];
  for (const t of tampered) {
    assert.notEqual(serverWitnessDigest(t), baseDigest, 'a changed attestation must not share a digest');
    assert.equal(browserWitnessDigest(t), serverWitnessDigest(t), 'both sides agree on the new digest too');
  }

  // The browser refuses to digest an incomplete attestation rather than sign a partial one.
  assert.throws(() => browserWitnessDigest({ ...base, agentId: undefined }), /agent id/i);
  assert.throws(() => browserWitnessDigest({ ...base, witness: null }), /witness key/i);

  // End to end: the browser's signature over its own digest verifies on the
  // server against the chain owner key - which is exactly what /api/witness/attest does.
  const digest = browserWitnessDigest(base);
  const sig = browserSign(digest, OWNER_PRIV);
  assert.equal(verifyOwnerSignature(serverWitnessDigest(base), sig, OWNER_PUB), true);
  assert.equal(verifyOwnerSignature(serverWitnessDigest({ ...base, witness: getStarkKey('0x5') }), sig, OWNER_PUB), false,
    'a signature vouching for one witness key must not verify over a different one');
});

// ---------------------------------------------------------------- signing

test('a browser signature verifies against the owner key the chain reports', () => {
  const r = { type: 'amend', amendment: { kind: 'raise-per-call-cap', token: '0x01f5', maxPerCall: '30' } };
  const digest = browserDigest(proposal(), r);
  const sig = browserSign(digest, OWNER_PRIV);

  assert.deepEqual(Object.keys(sig).sort(), ['r', 's']);
  assert.match(sig.r, /^0x[0-9a-f]+$/);
  assert.match(sig.s, /^0x[0-9a-f]+$/);
  // The server verifies with the x-only key it read from the chain.
  assert.equal(verifyOwnerSignature(digest, sig, OWNER_PUB), true);
  // A signature over a different digest must not verify.
  const other = { ...r, amendment: { ...r.amendment, maxPerCall: '31' } };
  assert.equal(verifyOwnerSignature(browserDigest(proposal(), other), sig, OWNER_PUB), false);
  // And the browser's signature must equal the server's own signer output.
  assert.deepEqual(browserSign(digest, OWNER_PRIV), serverSign(digest, OWNER_PRIV));
});

test('the browser derives the same public key as the library and rejects bad keys', () => {
  assert.equal(ownerPublicKeyFromPrivate(OWNER_PRIV), OWNER_PUB);
  assert.equal(ownerPublicKeyFromPrivate(`  ${OWNER_PRIV}  `), OWNER_PUB, 'whitespace is trimmed');

  const { n } = Point.CURVE(); // curve order from the library, never typed from memory
  const bad = [
    '', null, undefined,
    'not-a-key',
    '0x',
    '1ef15c18599971b7beced415a40f0c7deacfd9b0d1819e03d723d8bc943cfca', // no 0x
    '0x0', '-0x1', '0xzz',
    '0x' + n.toString(16), // == curve order: not a valid scalar
    '0x' + (n + 7n).toString(16),
  ];
  for (const k of bad) {
    assert.equal(isValidPrivateKey(k), false, `should reject ${String(k)}`);
  }
  assert.equal(isValidPrivateKey('0x1'), true);
  assert.equal(isValidPrivateKey('0x' + (n - 1n).toString(16)), true);
});

test('the browser refuses to digest an incomplete proposal rather than sign a partial one', () => {
  const r = { type: 'decline' };
  assert.throws(() => browserDigest({}, r), /full proposal/i);
  assert.throws(() => browserDigest({ id: 'x', request: {} }, r), /full proposal/i);
  assert.throws(() => browserDigest({ id: 'x', request: {}, blockedBecause: null }, r), /full proposal/i);
});

// ---------------------------------------------------------------- browser safety

const IMPORT_MAP = {
  '@scure/starknet': '/vendor/scure/starknet/index.js',
  '@noble/curves/': '/vendor/noble/curves/',
  '@noble/hashes/': '/vendor/noble/hashes/',
};

function resolveSpec(spec, fromPath) {
  if (spec.startsWith('@noble/curves/')) return IMPORT_MAP['@noble/curves/'] + spec.slice('@noble/curves/'.length);
  if (spec.startsWith('@noble/hashes/')) return IMPORT_MAP['@noble/hashes/'] + spec.slice('@noble/hashes/'.length);
  if (spec === '@scure/starknet') return IMPORT_MAP['@scure/starknet'];
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return new URL(spec, `http://x${fromPath}`).pathname;
  }
  return null; // bare specifier we do not serve - reported below
}

test('the served crypto graph the page loads needs no Node builtins', async (t) => {
  const server = createConsoleServer({
    statePath: 'unused', storePath: 'unused',
    readMandate: async () => ({}), readOwnerKey: async () => OWNER_PUB,
    submitCalls: async () => ({ status: 'SUCCEEDED' }),
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const port = server.address().port;
  t.after(() => new Promise((res) => server.close(res)));

  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  for (const [spec, target] of Object.entries(IMPORT_MAP)) {
    assert.ok(page.includes(`"${spec}"`), `the import map must cover ${spec}`);
    assert.ok(page.includes(`"${target}"`), `the import map must point ${spec} at ${target}`);
  }

  const queue = ['/vendor/scure/starknet/index.js', '/signer.js'];
  const seen = new Set();
  const offenders = [];
  const unresolved = [];

  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 200, `the page imports ${path}, which must be served (got ${res.status})`);
    const code = await res.text();

    for (const m of code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (/^node:/.test(spec) || /^(fs|path|crypto|os|url|buffer|stream|util|http|https|net|events|child_process)$/.test(spec)) {
        offenders.push(`${path} -> ${spec}`);
      }
      const next = resolveSpec(spec, path);
      if (next === null) unresolved.push(`${path} -> ${spec}`);
      else if (next.endsWith('.js')) queue.push(next);
    }
    if (/\bprocess\.(env|platform|version|binding)\b/.test(code)) {
      offenders.push(`${path} uses process.*`);
    }
  }

  assert.deepEqual(offenders, [], 'the page must not load anything Node-only');
  assert.deepEqual(unresolved, [], 'every import the page needs must be mapped by the server');
  assert.ok(seen.size >= 10, `walked the real graph (${seen.size} modules) - a near-empty walk would prove nothing`);
});
