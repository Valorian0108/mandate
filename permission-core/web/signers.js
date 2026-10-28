// The one door between "the owner decided" and "the owner signed".
//
// Until this module existed, four screens each handled a private key in their own
// way: the approvals screen, the résumé ladder, the evidence anchor, and the final
// transaction. Four copies of the same validation, the same derivation, and four
// chances to drift. A real wallet (track 2, phase 3) would have been a fifth.
//
// A Signer is the only thing a screen holds. It never sees key material. Every
// implementation must provide exactly this:
//
//   kind                                  'pasted-key' today; 'argent-x' next
//   publicKey                             x-only Starknet public key, as the chain stores it
//   signTypedData(typedData, account)     -> { r, s, digest }
//   signMandateAction({...})              -> { scheme: 'snip12-v1', r, s, typedData }
//   authorizeCalls({...})                 -> { scheme: 'snip12-src9', r, s, typedData }
//   signInvoke(tx, body)                  -> { signature: {r,s}, body }
//   checkAgainst(ownerPublicKey)          -> { matches, derived } or { error }
//
// The pasted-key implementation is deliberately small: it delegates every hash to
// web/typed-data.js and web/tx-signer.js, the two modules already pinned against
// starknet.js by drift tests. It adds no maths of its own, so there is nothing new
// to drift.
//
// The key lives in this closure and nowhere else. Dropping the signer reference is
// forgetting the key; nothing is written to storage, cookies, or the server.

import { getStarkKey, Point } from '@scure/starknet';

import {
  outsideExecutionTypedData,
  signMandateAction as signMandateActionWithKey,
  signTypedData as signTypedDataWithKey,
} from './typed-data.js';
import { signInvokeTx } from './tx-signer.js';

const hex = (value) => '0x' + BigInt(value).toString(16);

function norm(value) {
  return '0x' + BigInt(value).toString(16);
}

// Same rule the server applies: a positive field element below the curve order.
// Kept here so a signer can never be built from a value that cannot sign.
export function isValidPrivateKey(key) {
  const k = String(key ?? '').trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(k)) return false;
  try {
    const value = BigInt(k);
    if (value <= 0n) return false;
    const { n } = Point.CURVE();
    if (value >= n) return false;
    getStarkKey(k); // derives without throwing
    return true;
  } catch {
    return false;
  }
}

// The first implementation: a key typed into the page. It is the bridge that lets
// every screen move to the interface before a wallet exists, and it stays as the
// recovery path for a user whose wallet is unavailable.
export function createPastedKeySigner(privateKey) {
  const key = String(privateKey ?? '').trim();
  if (!isValidPrivateKey(key)) {
    throw new Error('that is not a valid Starknet private key (hex, below the curve order)');
  }
  const publicKey = getStarkKey(key);

  return Object.freeze({
    kind: 'pasted-key',
    publicKey,

    // A typed-data message the owner can read. Used for mandate decisions.
    signTypedData(typedData, accountAddress) {
      return signTypedDataWithKey(typedData, accountAddress, key);
    },

    // The envelope a new record stores. Same carrier the approvals screen shows.
    signMandateAction({ chainId, accountAddress, kind, digest, note }) {
      return signMandateActionWithKey({
        chainId, accountAddress, kind, digest, note, privateKey: key,
      });
    },

    // SRC-9 outside execution: the owner authorises a list of calls, not a
    // transaction envelope. Phase 5 consumes this; the drift test pins its hash
    // to starknet.js now so a wallet can produce the same signature later.
    authorizeCalls({
      chainId,
      accountAddress,
      caller = 'ANY_CALLER',
      nonce,
      executeAfter,
      executeBefore,
      calls,
    }) {
      const typedData = outsideExecutionTypedData({
        chainId, caller, nonce, executeAfter, executeBefore, calls,
      });
      const { r, s } = signTypedDataWithKey(typedData, accountAddress, key);
      return { scheme: 'snip12-src9', r, s, typedData };
    },

    // The FINAL transaction: the exact invoke-v3 hash, signed in this tab.
    signInvoke(tx, body) {
      return signInvokeTx(tx, body, key);
    },

    // Does this key derive to the owner the CHAIN reports? Not to a key the app
    // happens to believe in. A missing chain key is a refusal, never a pass.
    checkAgainst(ownerPublicKey) {
      if (ownerPublicKey === undefined || ownerPublicKey === null || ownerPublicKey === '') {
        return { derived: publicKey, matches: false, error: 'the owner key on chain is not loaded' };
      }
      try {
        return { derived: publicKey, matches: norm(publicKey) === norm(ownerPublicKey) };
      } catch {
        return { derived: publicKey, matches: false, error: 'the owner key on chain is not a felt' };
      }
    },
  });
}

// For screens: turn whatever is in a key box into either a signer and its check,
// or a signer-less result carrying a plain error. Never throws at the UI.
export function signerForInput(key, ownerPublicKey) {
  const raw = String(key ?? '').trim();
  if (!raw) return { signer: null, check: null };
  try {
    const signer = createPastedKeySigner(raw);
    return { signer, check: signer.checkAgainst(ownerPublicKey) };
  } catch (e) {
    return { signer: null, check: { error: e.message } };
  }
}

// Exposed for tests and for phase 3's connector: the x-only key for any private
// key, using the library rather than a remembered constant.
export { getStarkKey };
