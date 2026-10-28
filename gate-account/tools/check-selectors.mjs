// Cross-check: selectors computed by starknet.js vs selectors baked into the compiled
// Sierra artifacts that were actually declared on Sepolia.
//
// The artifact is the ground truth here - those selector values are what the chain routes on.
// If the whitelist we register on-chain used a wrong selector, the agent's legitimate
// transfer would be rejected (or worse, an unintended one allowed). Two independent sources
// must agree.
import { readFileSync } from 'node:fs';
import * as sn from 'starknet';

const getSel = sn.selector?.getSelector ?? sn.hash?.getSelector;

const ART = {
  GateAccount: '../target/release/gate_account_GateAccount.contract_class.json',
  ERC20Mock: '../target/release/gate_account_ERC20Mock.contract_class.json',
};

// Pull name -> selector straight out of the artifact: walk the ABI in order and zip with
// the EXTERNAL entry points ordered by function_idx.
function artifactSelectors(label, file) {
  const cls = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const abi = typeof cls.abi === 'string' ? JSON.parse(cls.abi) : cls.abi;

  const names = [];
  const walk = (items) => {
    const list = Array.isArray(items) ? items : (items?.items ?? []);
    for (const it of list) {
      if (it.type === 'function') names.push(it.name);
      else if (it.type === 'interface' || it.type === 'impl') walk(it.items);
    }
  };
  // The Sierra class `abi` is a JSON *string* holding a bare array of entries.
  walk(abi);

  const external = [...(cls.entry_points_by_type?.EXTERNAL ?? [])].sort(
    (x, y) => x.function_idx - y.function_idx,
  );
  const all = new Set(external.map((e) => e.selector.toLowerCase()));

  // Positional zip is NOT valid: entry_points are ordered by function_idx, which is a
  // rotation of the ABI's declaration order (is_valid_signature, declared last in the ABI,
  // is entry point 0). Compare as SETS - that is the real question anyway: does every
  // selector we would write into the whitelist exist in the deployed class?
  const computed = new Map();
  for (const fn of names) {
    const s = getSel(fn);
    computed.set(fn, (typeof s === 'bigint' ? '0x' + s.toString(16) : s).toLowerCase());
  }

  const missingFromArtifact = [...computed].filter(([, sel]) => !all.has(sel));
  const unaccounted = [...all].filter((sel) => ![...computed.values()].includes(sel));

  const results = [`\n=== ${label} ===`];
  results.push(
    `  abi functions: ${names.length}, EXTERNAL entry points: ${external.length}`,
  );
  results.push(
    `  computed selectors present in deployed class: ${computed.size - missingFromArtifact.length}/${computed.size}`,
  );
  for (const [fn, sel] of missingFromArtifact) results.push(`  MISSING ${fn} = ${sel}`);
  results.push(
    `  artifact selectors not matched by any ABI name: ${unaccounted.length}${unaccounted.length ? ' -> ' + unaccounted.join(', ') : ''}`,
  );
  results.push(
    `  set equality: ${missingFromArtifact.length === 0 && unaccounted.length === 0 && computed.size === all.size ? 'EXACT' : 'DIFFERS'}`,
  );
  return { results, map: computed, all };
}

const results = [];
for (const [label, file] of Object.entries(ART)) {
  results.push(...artifactSelectors(label, file).results);
}

// The specific constants the on-chain whitelist / blocklist depend on.
const gate = artifactSelectors('GateAccount', ART.GateAccount);
const token = artifactSelectors('ERC20Mock', ART.ERC20Mock);
const critical = [
  ['transfer', token, 'ERC20Mock'],
  ['balance_of', token, 'ERC20Mock'],
  ['add_or_update_session_key', gate, 'GateAccount'],
  ['set_spending_policy', gate, 'GateAccount'],
  ['allow_recipient', gate, 'GateAccount'],
  ['get_session_data', gate, 'GateAccount'],
];
results.push('\n=== critical constants present in deployed classes ===');
for (const [fn, a, which] of critical) {
  const sel = (typeof getSel(fn) === 'bigint' ? '0x' + getSel(fn).toString(16) : getSel(fn)).toLowerCase();
  const present = a.all.has(sel);
  results.push(`  ${present ? 'OK  ' : 'MISS'} ${which}.${fn} = ${sel}`);
}

console.log(results.join('\n'));
