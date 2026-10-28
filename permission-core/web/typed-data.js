// SNIP-12 typed data, revision 1 ("ACTIVE"). This is the carrier a real wallet
// can display and sign: the owner reads the action in their wallet, the wallet
// signs a structured message, and our server verifies it against the owner key
// the CHAIN reports.
//
// Every rule here was read out of starknet.js 10.8.0's implementation
// (dist/index.mjs, typedData section) and OpenZeppelin cairo-contracts v4.0.1
// (packages/utils/src/cryptography/snip12.cairo +
// packages/account/src/extensions/src9/snip12_utils.cairo). tests/typed-data.test.mjs
// pins this module against starknet.js as the oracle: same type strings, same
// Poseidon hashing, same message hash. If they ever drift, the test fails loudly.
//
// Deliberately revision-1 only. Old records keep their raw-digest signatures
// ("digest-v1"); new typed-data records are "snip12-v1". Refusing the legacy
// revision here means a legacy-shaped message can never be mistaken for a new one.
//
// This module must stay free of `node:` imports: the browser loads it directly,
// and the server imports the same file so both sides hash identically.

import { keccak, poseidonHashMany, sign } from '@scure/starknet';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export const REVISION_ACTIVE = '1';

// Domain for mandate actions (resolutions, ladder changes). The name is ours and
// is part of what the wallet shows; the account address is bound separately by
// SNIP-12's message hash (signer argument), not by the domain.
export const MANDATE_DOMAIN_NAME = 'Demi Mandate';
export const MANDATE_DOMAIN_VERSION = '1';

// SRC-9's canonical domain, read from OpenZeppelin's SRC9Component
// (SNIP12MetadataImpl): name 'Account.execute_from_outside', version 2.
export const SRC9_DOMAIN_NAME = 'Account.execute_from_outside';
export const SRC9_DOMAIN_VERSION = '2';

const PRIME = 0x800000000000011000000000000000000000000000000000000000000000001n;
const MAX_FELT = PRIME - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_I128 = (1n << 127n) - 1n;
const MIN_I128 = -(1n << 127n);
const MESSAGE_PREFIX = 'StarkNet Message';

// starknet.js's revision-1 preset types. Only u256 is included because it is the
// one preset a caller could reasonably put in a message; the others are refused
// loudly rather than hashed wrongly.
const PRESET_TYPES = {
  u256: [
    { name: 'low', type: 'u128' },
    { name: 'high', type: 'u128' },
  ],
};

const DOMAIN_TYPE = 'StarknetDomain';

// ---------------------------------------------------------------- primitives

const hex = (v) => '0x' + BigInt(v).toString(16);

function fail(message) {
  throw new Error(`typed data: ${message}`);
}

function isHexString(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

function isAscii(value) {
  return typeof value === 'string' && /^[\x00-\x7F]*$/.test(value);
}

// Starknet short string: 1-31 ASCII bytes packed big-endian into one felt.
export function shortStringEncode(value) {
  if (!isAscii(value)) fail(`'${value}' is not ASCII`);
  const bytes = utf8ToBytes(value);
  if (bytes.length === 0 || bytes.length > 31) {
    fail(`short string must be 1-31 bytes, got '${value}'`);
  }
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

export function shortStringDecode(value) {
  let v = BigInt(value);
  let out = '';
  while (v > 0n) {
    out = String.fromCharCode(Number(v & 0xffn)) + out;
    v >>= 8n;
  }
  return out;
}

function feltValue(value, label) {
  if (value === undefined || value === null) fail(`${label} is required`);
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string' && !isHexString(value)) {
    // Short strings are accepted where the type is shortstring; felt values
    // must be explicit numbers, never silently interpreted.
    fail(`${label} must be a number or hex string, got '${value}'`);
  }
  let v;
  try {
    v = BigInt(value);
  } catch {
    fail(`${label} is not a felt: ${value}`);
  }
  if (v < 0n || v > MAX_FELT) fail(`${label} is outside the felt range`);
  return v;
}

function assertRange(value, label, min, max) {
  const v = BigInt(value);
  if (v < min || v > max) fail(`${label} (${v}) is out of bounds [${min}, ${max}]`);
  return v;
}

// The oracle's getHex: a string that parses as a number (decimal or hex) is that
// number; anything else is a short string. This matters: OpenZeppelin's SRC-9
// domain uses version = 2 and revision = 1 as NUMBERS, not ASCII '2' / '1'.
function valueToFelt(value, type) {
  if (typeof value === 'string') {
    if (isHexString(value)) return BigInt(value);
    if (/^-?[0-9]+$/.test(value)) return BigInt(value);
    if (type === 'shortstring') return shortStringEncode(value);
    fail(`'${value}' is not a number or hex value for type ${type}`);
  }
  return BigInt(value);
}

// starknet.js byteArrayFromString: 31-byte chunks, then the pending word and its
// byte length. ASCII only, because a Starknet short string is ASCII.
export function byteArrayFromString(value) {
  if (!isAscii(value)) fail(`string is not ASCII: '${value}'`);
  const chars = [...value];
  const chunks = [];
  for (let i = 0; i < chars.length; i += 31) chunks.push(chars.slice(i, i + 31).join(''));
  if (chunks.length === 0) return { data: [], pending_word: 0n, pending_word_len: 0 };
  const last = chunks[chunks.length - 1];
  if (last.length === 31) {
    return { data: chunks.map(shortStringEncode), pending_word: 0n, pending_word_len: 0 };
  }
  chunks.pop();
  return {
    data: chunks.map(shortStringEncode),
    pending_word: shortStringEncode(last),
    pending_word_len: last.length,
  };
}

// sn_keccak, exactly what Starknet uses for entrypoint selectors and SNIP-12
// type hashes.
export function selectorFromName(name) {
  return keccak(utf8ToBytes(name));
}

function prepareSelector(value) {
  if (typeof value === 'string' && isHexString(value)) return BigInt(value);
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return selectorFromName(value);
  fail(`selector must be a hex felt or a name, got ${value}`);
}

// ---------------------------------------------------------------- type encoding

function allTypes(types) {
  return { ...types, ...PRESET_TYPES };
}

// Collect the type and every named type it depends on. Mirrors the oracle's
// getDependencies for the shapes we use: named structs and `T*` arrays.
function collectDependencies(types, type, deps = new Set()) {
  const base = type.endsWith('*') ? type.slice(0, -1) : type;
  if (!types[base] || deps.has(base)) return deps;
  deps.add(base);
  for (const field of types[base]) {
    collectDependencies(types, field.type, deps);
  }
  return deps;
}

function quote(value) {
  return `"${value}"`;
}

// encodeType: primary type first, then its dependencies sorted by name. Every
// name and type is quoted (revision 1). This string is what the type hash covers.
export function encodeType(types, primaryType) {
  const merged = allTypes(types);
  if (!merged[primaryType]) fail(`unknown primary type '${primaryType}'`);
  const deps = collectDependencies(merged, primaryType);
  deps.delete(primaryType);
  const ordered = [primaryType, ...[...deps].sort()];
  return ordered
    .map((name) => {
      const fields = merged[name]
        .map((field) => `${quote(field.name)}:${quote(field.type)}`)
        .join(',');
      return `${quote(name)}(${fields})`;
    })
    .join('');
}

export function getTypeHash(types, primaryType) {
  return selectorFromName(encodeType(types, primaryType));
}

// ---------------------------------------------------------------- value encoding

function encodeValue(types, type, value, ctx = {}) {
  const merged = allTypes(types);

  if (merged[type]) return [type, getStructHash(merged, type, value)];
  if (PRESET_TYPES[type]) return [type, getStructHash(PRESET_TYPES, type, value)];

  if (type.endsWith('*')) {
    if (!Array.isArray(value)) fail(`'${ctx.key ?? type}' must be an array`);
    const elementType = type.slice(0, -1);
    const hashes = value.map((entry) => encodeValue(merged, elementType, entry)[1]);
    return [type, poseidonHashMany(hashes)];
  }

  switch (type) {
    case 'felt':
    case 'shortstring': {
      const v = valueToFelt(value, type);
      assertRange(v, type, 0n, MAX_FELT);
      return [type, v];
    }
    case 'ClassHash':
    case 'ContractAddress': {
      const v = valueToFelt(value, type);
      assertRange(v, type, 0n, MAX_FELT);
      return [type, v];
    }
    case 'bool': {
      if (typeof value !== 'boolean') fail(`bool field '${ctx.key ?? type}' must be true or false`);
      return [type, value ? 1n : 0n];
    }
    case 'u128':
    case 'timestamp': {
      const v = valueToFelt(value, type);
      assertRange(v, type, 0n, MAX_U128);
      return [type, v];
    }
    case 'i128': {
      const v = BigInt(value);
      assertRange(v, type, MIN_I128, MAX_I128);
      return [type, v < 0n ? PRIME + v : v];
    }
    case 'selector':
      return ['felt', prepareSelector(value)];
    case 'string': {
      if (typeof value !== 'string') fail(`string field '${ctx.key ?? type}' must be a string`);
      const byteArray = byteArrayFromString(value);
      return [
        type,
        poseidonHashMany([
          BigInt(byteArray.data.length),
          ...byteArray.data,
          byteArray.pending_word,
          BigInt(byteArray.pending_word_len),
        ]),
      ];
    }
    default:
      fail(`unsupported type '${type}' - refusing to guess how it hashes`);
  }
}

function encodeData(types, type, data) {
  const merged = allTypes(types);
  const fields = merged[type];
  if (!fields) fail(`unknown type '${type}'`);
  const values = [getTypeHash(merged, type)];
  for (const field of fields) {
    if (data[field.name] === undefined || data[field.name] === null) {
      fail(`missing data for '${field.name}' in '${type}'`);
    }
    values.push(encodeValue(merged, field.type, data[field.name], { parent: type, key: field.name })[1]);
  }
  return values;
}

export function getStructHash(types, type, data) {
  return poseidonHashMany(encodeData(types, type, data));
}

// ---------------------------------------------------------------- message hash

// SNIP-12 revision 1: poseidonMany(['StarkNet Message', domainHash, account,
// messageHash]). The domain is 'StarknetDomain' (lowercase n) in revision 1 -
// the legacy revision used 'StarkNetDomain' and Pedersen hashing instead.
export function getMessageHash(typedData, accountAddress) {
  if (!typedData || typeof typedData !== 'object') fail('a typed data object is required');
  const { types, primaryType, domain, message } = typedData;
  if (!types || !primaryType || !domain || !message) {
    fail('typed data needs types, primaryType, domain and message');
  }
  if (!types[DOMAIN_TYPE]) fail(`revision 1 requires a '${DOMAIN_TYPE}' type`);
  if (String(domain.revision) !== REVISION_ACTIVE) {
    fail(`only revision ${REVISION_ACTIVE} is supported (got '${domain.revision}')`);
  }
  if (!types[primaryType]) fail(`primary type '${primaryType}' is missing from types`);
  if (accountAddress === undefined || accountAddress === null) fail('the signer account is required');
  return poseidonHashMany([
    shortStringEncode(MESSAGE_PREFIX),
    getStructHash(types, DOMAIN_TYPE, domain),
    BigInt(accountAddress),
    getStructHash(types, primaryType, message),
  ]);
}

// ---------------------------------------------------------------- our carriers

function mandateDomain(chainId) {
  if (!chainId) fail('a chain id is required (e.g. SN_SEPOLIA)');
  return {
    name: MANDATE_DOMAIN_NAME,
    version: MANDATE_DOMAIN_VERSION,
    chainId,
    revision: REVISION_ACTIVE,
  };
}

const MANDATE_TYPES = {
  StarknetDomain: [
    { name: 'name', type: 'shortstring' },
    { name: 'version', type: 'shortstring' },
    { name: 'chainId', type: 'shortstring' },
    { name: 'revision', type: 'shortstring' },
  ],
  MandateAction: [
    { name: 'kind', type: 'shortstring' },
    { name: 'digest', type: 'felt' },
    { name: 'note', type: 'string' },
  ],
};

// The note serves two masters: the screen (any Unicode) and this carrier (ASCII
// only - the string encoder refuses everything else, loudly and rightly). The
// browser proof of the wallet path (2026-10-26) caught display typography
// crossing that line: notes built with the UI's shortened addresses carry '…'
// (U+2026), so every wallet-signed resolution was refused at the encoder.
// Typographic look-alikes are folded to ASCII HERE, at the single entry point
// every signer goes through - what the owner reads is unchanged - and anything
// with no ASCII look-alike (emoji, accented letters) stays a loud refusal.
const NOTE_FOLDS = {
  '\u2026': '...', // … ellipsis, as produced by the UI's short()/shortAddress()
  '\u2014': '--', // — em dash
  '\u2013': '-', // – en dash
  '\u2018': "'", // ‘ left single quote
  '\u2019': "'", // ’ right single quote
  '\u201c': '"', // “ left double quote
  '\u201d': '"', // ” right double quote
  '\u00a0': ' ', // non-breaking space (copy-paste)
};

export function foldNoteAscii(note) {
  return note.replace(/[\u2026\u2014\u2013\u2018\u2019\u201c\u201d\u00a0]/g, (ch) => NOTE_FOLDS[ch]);
}

// The human-readable carrier for an off-chain owner decision. `digest` is the
// existing canonical digest (proposals.mjs / ladder.mjs), so the signature still
// binds exactly the same bytes as before; `note` is what the wallet displays.
export function mandateActionTypedData({ chainId, kind, digest, note }) {
  if (!kind) fail('a mandate action kind is required');
  if (!digest) fail('a mandate action digest is required');
  if (typeof note !== 'string' || note.length === 0) {
    fail('a mandate action needs a plain-language note for the owner to read');
  }
  return {
    types: JSON.parse(JSON.stringify(MANDATE_TYPES)),
    primaryType: 'MandateAction',
    domain: mandateDomain(chainId),
    message: { kind, digest: hex(digest), note: foldNoteAscii(note) },
  };
}

// SRC-9 outside execution, exactly the shape OpenZeppelin's component hashes and
// starknet.js's OutsideExecutionTypesV2 describes (including the spaced names).
const OUTSIDE_EXECUTION_TYPES = {
  StarknetDomain: [
    { name: 'name', type: 'shortstring' },
    { name: 'version', type: 'shortstring' },
    { name: 'chainId', type: 'shortstring' },
    { name: 'revision', type: 'shortstring' },
  ],
  OutsideExecution: [
    { name: 'Caller', type: 'ContractAddress' },
    { name: 'Nonce', type: 'felt' },
    { name: 'Execute After', type: 'u128' },
    { name: 'Execute Before', type: 'u128' },
    { name: 'Calls', type: 'Call*' },
  ],
  Call: [
    { name: 'To', type: 'ContractAddress' },
    { name: 'Selector', type: 'selector' },
    { name: 'Calldata', type: 'felt*' },
  ],
};

const ANY_CALLER = shortStringEncode('ANY_CALLER');

export function outsideExecutionTypedData({
  chainId,
  caller,
  nonce,
  executeAfter,
  executeBefore,
  calls,
}) {
  if (!Array.isArray(calls) || calls.length === 0) fail('outside execution needs at least one call');
  const codedCaller = caller === 'ANY_CALLER' || caller === undefined ? ANY_CALLER : BigInt(caller);
  return {
    types: JSON.parse(JSON.stringify(OUTSIDE_EXECUTION_TYPES)),
    primaryType: 'OutsideExecution',
    domain: {
      name: SRC9_DOMAIN_NAME,
      version: SRC9_DOMAIN_VERSION,
      chainId,
      revision: REVISION_ACTIVE,
    },
    message: {
      Caller: hex(codedCaller),
      Nonce: hex(nonce),
      'Execute After': hex(executeAfter),
      'Execute Before': hex(executeBefore),
      Calls: calls.map((call) => ({
        To: hex(call.to),
        Selector: hex(prepareSelector(call.selector)),
        Calldata: (call.calldata ?? []).map((v) => hex(v)),
      })),
    },
  };
}

// ---------------------------------------------------------------- signing

// Sign a typed data message with a private key. Kept here so the browser and the
// tests use the exact same path; the server never calls this with an owner key.
export function signTypedData(typedData, accountAddress, privateKey) {
  const digest = getMessageHash(typedData, accountAddress);
  // @scure's sign takes bytes or a hex string, not a BigInt.
  const sig = sign(hex(digest), String(privateKey).trim());
  return { r: hex(sig.r), s: hex(sig.s), digest };
}

// The full envelope a new record stores: the scheme, the signature, and the exact
// message the owner saw. The server re-derives the digest from its own records and
// refuses the envelope if any field disagrees.
export function signMandateAction({
  chainId,
  accountAddress,
  kind,
  digest,
  note,
  privateKey,
}) {
  const typedData = mandateActionTypedData({ chainId, kind, digest, note });
  const { r, s } = signTypedData(typedData, accountAddress, privateKey);
  return { scheme: 'snip12-v1', r, s, typedData };
}
