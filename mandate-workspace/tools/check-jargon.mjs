// The jargon gate. Run: node tools/check-jargon.mjs
//
// The product rule this enforces: the UI has NO crypto-native surface. No
// addresses, keys, hashes, gas, chain names, or signing vocabulary anywhere a
// user can read, except inside the two approved places (the confirmation
// popup and receipt drawers), which must be fenced with crypto-surface
// markers so this gate can see exactly where the machine layer is allowed to
// speak.
//
// Rules checked, all mechanically:
//   1. UI files (index.html, app.js, vocab.js, stores.js, decide.js,
//      style.css, tokens.css): banned crypto words only inside crypto-surface
//      blocks. decide.js and stores.js are fenced whole-file: they are the
//      machine layer the screens call, never plain-language copy.
//   2. Machine files (data.js, serve.mjs): exempt from the word scan, but
//      forbidden from rendering anything (no HTML, no DOM access).
//   3. app.js: every error that reaches display state must pass through
//      plainError() - a raw server message can never reach a screen.
//   4. tokens.css: every oklch() colour must be inside the sRGB gamut
//      (browsers clip out-of-gamut values, breaking hex promises), and any
//      hex comment next to a token must equal the computed hex.
//   5. index.html: the favicon hex must equal the accent token's rendered
//      hex, and the nonce placeholders must survive for the production CSP.
//   6. style.css: no colour literals at all - every colour comes from a
//      token, so a re-theme can never leave a stray hard-coded value.
//   7. The 44px control floor and prefers-reduced-motion support exist.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(resolve(HERE, '..'), 'app');

const UI_FILES = ['index.html', 'app.js', 'vocab.js', 'stores.js', 'decide.js', 'style.css', 'tokens.css'];
const MACHINE_FILES = ['data.js', 'serve.mjs'];

const fail = [];
const read = (f) => readFileSync(join(APP, f), 'utf8');

// ---------------------------------------------------------------- 1. words

// Crypto-native vocabulary. Word boundaries keep "design", "blockchain"
// (caught separately), "gasp" etc. from false-positiving on "sign"/"chain"/"gas".
const BANNED = [
  [/0x[0-9a-fA-F]{4,}/i, 'hex identifier'],
  [/\bwallets?\b/i, 'wallet'],
  [/\bblockchains?\b/i, 'blockchain'],
  [/\bchains?\b/i, 'chain'],
  [/\bstarknet\b/i, 'starknet'],
  [/\bsepolia\b/i, 'sepolia'],
  [/\bethereum\b/i, 'ethereum'],
  [/\btestnets?\b/i, 'testnet'],
  [/\bmainnets?\b/i, 'mainnet'],
  [/\bgas\b/i, 'gas'],
  [/\bnonces?\b/i, 'nonce'],
  [/\bhash(es)?\b/i, 'hash'],
  [/\btransactions?\b/i, 'transaction'],
  [/\btx\b/i, 'tx'],
  [/\baddress(es)?\b/i, 'address'],
  [/\bfelts?\b/i, 'felt'],
  [/\brpc\b/i, 'rpc'],
  [/\bsignature[s]?\b/i, 'signature'],
  [/\bsign(s|ed|ing)?\b/i, 'sign'],
  [/\bcontracts?\b/i, 'contract'],
  [/\b(private|public|secret)\s+key(s)?\b/i, 'key material'],
  [/\bkeypairs?\b/i, 'keypair'],
  [/\bbroadcast(s|ed|ing)?\b/i, 'broadcast'],
  [/\bblock\s+number\b/i, 'block number'],
];

function scanWords(file, source) {
  let excluded = false;
  source.split('\n').forEach((line, i) => {
    if (line.includes('crypto-surface:start')) { excluded = true; return; }
    if (line.includes('crypto-surface:end')) { excluded = false; return; }
    if (excluded) return;
    // Mechanical plumbing that can never be user-facing copy: the CSP nonce
    // attribute (required verbatim so the production server can inject it)
    // and the browser's routing property. Strip before scanning.
    const scannable = line
      .replaceAll('nonce="__CSP_NONCE__"', '')
      .replaceAll('location.hash', '');
    for (const [re, label] of BANNED) {
      const m = re.exec(scannable);
      if (m) fail.push(`${file}:${i + 1} banned ${label} "${m[0]}" -> ${line.trim().slice(0, 88)}`);
    }
  });
  if (excluded) fail.push(`${file}: unclosed crypto-surface block`);
}

for (const f of UI_FILES) {
  let src;
  try { src = read(f); } catch { fail.push(`${f}: missing`); continue; }
  scanWords(f, src);
}

// ---------------------------------------------------------------- 2. machine files

const RENDER_PATTERNS = [
  [/<\s*(div|span|p|a|button|form|section|nav|main|aside|header|footer|ul|li|table|h[1-6]|strong|em|svg|html|body|script|style|label|input|select)\b/i, 'HTML tag'],
  [/innerHTML|outerHTML|insertAdjacentHTML/i, 'DOM injection'],
  [/\bdocument\s*\./i, 'DOM access'],
];

for (const f of MACHINE_FILES) {
  let src;
  try { src = read(f); } catch { fail.push(`${f}: missing`); continue; }
  src.split('\n').forEach((line, i) => {
    for (const [re, label] of RENDER_PATTERNS) {
      if (re.test(line)) fail.push(`${f}:${i + 1} machine layer must not render (${label}) -> ${line.trim().slice(0, 88)}`);
    }
  });
}

// ---------------------------------------------------------------- 3. error discipline

let appJs = '';
try { appJs = read('app.js'); } catch { /* already reported */ }
if (appJs) {
  if (!/import\s*\{[^}]*\bplainError\b[^}]*\}\s*from\s*'\.\/vocab\.js'/.test(appJs)) {
    fail.push('app.js: must import plainError from ./vocab.js');
  }
  for (const m of appJs.matchAll(/(\w*Error)\s*=\s*([^;\n]+)/g)) {
    const rhs = m[2].trim();
    if (rhs !== 'null' && !rhs.startsWith('plainError(')) {
      fail.push(`app.js: raw error reaches display state: ${m[1]} = ${rhs.slice(0, 64)}`);
    }
  }
}

// ---------------------------------------------------------------- 4. colour gamut

// oklch -> sRGB, the same math the browser uses. oog = out of gamut.
function toHex(Lpct, C, H) {
  const L = Lpct / 100, h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = 0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const oog = [r, g, bb].some((v) => v < -0.0001 || v > 1.0001);
  const f = (x) => { const t = Math.min(1, Math.max(0, x)); return t <= 0.0031308 ? 12.92 * t : 1.055 * t ** (1 / 2.4) - 0.055; };
  return { hex: '#' + [f(r), f(g), f(bb)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''), oog };
}

let tokensCss = '';
let accentHex = null;
try { tokensCss = read('tokens.css'); } catch { /* already reported */ }
const TOKEN_RE = /--color-([\w-]+):\s*oklch\(\s*(\d+(?:\.\d+)?)%\s+(\d*\.?\d+)\s+(\d+(?:\.\d+)?)\s*\)\s*;\s*(?:\/\*\s*#([0-9a-fA-F]{6})\s*\*\/)?/g;
for (const m of tokensCss.matchAll(TOKEN_RE)) {
  const [, name, L, C, H, commentHex] = m;
  const { hex, oog } = toHex(Number(L), Number(C), Number(H));
  if (oog) fail.push(`tokens.css: --color-${name} oklch(${L}% ${C} ${H}) is OUT OF sRGB GAMUT (browser clips it to ${hex})`);
  if (commentHex && commentHex.toLowerCase() !== hex.slice(1)) {
    fail.push(`tokens.css: --color-${name} promises #${commentHex.toLowerCase()} but renders ${hex}`);
  }
  if (name === 'accent') accentHex = hex.slice(1);
}
if (tokensCss && !accentHex) fail.push('tokens.css: --color-accent not found');

// ---------------------------------------------------------------- 5. favicon + nonce

let html = '';
try { html = read('index.html'); } catch { /* already reported */ }
if (html) {
  const iconLine = html.split('\n').find((l) => l.includes('rel="icon"'));
  const fav = iconLine && iconLine.match(/%23([0-9a-fA-F]{6})/);
  if (!fav) fail.push('index.html: favicon must carry the accent hex (%23rrggbb)');
  else if (accentHex && fav[1].toLowerCase() !== accentHex) {
    fail.push(`index.html: favicon #${fav[1].toLowerCase()} != accent #${accentHex} (they must be the same colour)`);
  }
  if (!/<script type="importmap" nonce="__CSP_NONCE__">/.test(html)) {
    fail.push('index.html: importmap must keep nonce="__CSP_NONCE__" for the production CSP');
  }
  if (!/<script type="module" src="\/app\.js" nonce="__CSP_NONCE__"><\/script>/.test(html)) {
    fail.push('index.html: module script must keep nonce="__CSP_NONCE__" for the production CSP');
  }
  if (!html.includes('/vendor/scure/starknet/')) {
    fail.push('index.html: importmap must map the vendored crypto libraries the tested modules import');
  }
}

// ---------------------------------------------------------------- 6. no colour literals in style.css

let styleCss = '';
try { styleCss = read('style.css'); } catch { /* already reported */ }
if (styleCss) {
  const LITERALS = [
    [/#[0-9a-fA-F]{3,8}\b/, 'hex colour'],
    [/\brgba?\(/, 'rgb()'],
    [/\bhsla?\(/, 'hsl()'],
    [/\boklch\(/, 'oklch()'],
  ];
  styleCss.split('\n').forEach((line, i) => {
    for (const [re, label] of LITERALS) {
      const m = re.exec(line);
      if (m) fail.push(`style.css:${i + 1} colour literal (${label}) "${m[0]}" - use a token`);
    }
  });
}

// ---------------------------------------------------------------- 7. floors

if (tokensCss && !/--control-h:\s*2\.75rem/.test(tokensCss)) {
  fail.push('tokens.css: --control-h must stay at the 44px floor (2.75rem)');
}
if (styleCss && !/prefers-reduced-motion/.test(styleCss)) {
  fail.push('style.css: missing prefers-reduced-motion support');
}

// The 44px control floor, enforced: every interactive control must size its
// tap target from var(--control-h), never a smaller px literal. Decorative
// elements (dots, meters, badges, icons) are exempt by name.
if (styleCss) {
  const INTERACTIVE = ['.btn', '.quick', '.control', '.nav-item', '.drawer-close'];
  const DECORATIVE_OK = ['.dot', '.meter', '.nav-badge', '.read-chip', '.step-n', '.tick', '.nav-ico', '.meter-fill', '.brand-mark'];
  // Split into "selector { body }" blocks (flat rules only; this file has none nested).
  const blocks = [...styleCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, sel0, body] of blocks) {
    const sel = sel0.trim();
    const isInteractive = INTERACTIVE.some((c) => sel.split(/[,\s]/).some((part) => part === c || part.startsWith(c + '-') || part.startsWith(c + ':') || part.startsWith(c + '[') || part.startsWith(c + '.')));
    if (!isInteractive) continue;
    // A px height/min-height below 44 on an interactive control is a violation.
    for (const hm of body.matchAll(/(min-height|height)\s*:\s*(\d+(?:\.\d+)?)px/g)) {
      if (Number(hm[2]) < 44) fail.push(`style.css: ${sel} sets ${hm[1]}:${hm[2]}px - below the 44px control floor`);
    }
    // And it must actually reach for the token (unless it only ever inherits size).
    if (!/var\(--control-h\)/.test(body) && !DECORATIVE_OK.some((d) => sel.includes(d))) {
      // Only complain if the block tries to set a height at all.
      if (/(min-height|height)\s*:/.test(body)) {
        fail.push(`style.css: ${sel} sets a height without var(--control-h)`);
      }
    }
  }
}

// ---------------------------------------------------------------- verdict

if (fail.length) {
  console.error(`jargon gate: FAILED (${fail.length})`);
  for (const f of fail) console.error('  ' + f);
  process.exit(1);
}
console.log('jargon gate: clean');
console.log(`  UI files scanned: ${UI_FILES.join(', ')}`);
console.log(`  machine layer (no rendering): ${MACHINE_FILES.join(', ')}`);
console.log(`  accent renders #${accentHex}; favicon matches; all tokens in sRGB gamut`);
