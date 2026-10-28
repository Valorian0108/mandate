// One-shot verification for the Hallmark slop-fix pass. Run: node tools/check-style.mjs
// Every claim here is computed from the files on disk - nothing is asserted from memory.
import { readFileSync } from 'node:fs';

const css = readFileSync('web/style.css', 'utf8');
const tokens = readFileSync('web/tokens.css', 'utf8');
const html = readFileSync('web/index.html', 'utf8');
const app = readFileSync('web/app.js', 'utf8');

const fail = [];

if (/on-accent/.test(css) || /on-accent/.test(tokens)) fail.push('on-accent still referenced');

const lits = [...css.matchAll(/(?:padding|margin)(?:-top|-left|-right|-bottom)?\s*:\s*[^;]*?(\d)px/g)]
  .filter((m) => [1, 2, 3, 5, 6].includes(+m[1]));
if (lits.length) fail.push('literal sub-4px paddings/margins: ' + lits.map((m) => m[0]).join(' | '));

// oklch(percent L) -> sRGB, with gamut flag (chroma reduction is what browsers do)
function toHex(Lpct, C, H) {
  const L = Lpct / 100, h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const oog = [r, g, bb].some((v) => v < -0.0001 || v > 1.0001);
  const f = (x) => { const t = Math.min(1, Math.max(0, x)); return t <= 0.0031308 ? 12.92 * t : 1.055 * t ** (1 / 2.4) - 0.055; };
  return { hex: '#' + [f(r), f(g), f(bb)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''), oog };
}

// Gate 48: the favicon hex must equal the accent token's real rendered hex.
const accentTok = tokens.match(/--color-accent:\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/);
if (!accentTok) fail.push('could not parse --color-accent from tokens.css');
else {
  const { hex, oog } = toHex(+accentTok[1], +accentTok[2], +accentTok[3]);
  const fav = html.match(/fill='(%23[0-9a-f]{6})'/);
  const favHex = '#' + (fav ? fav[1].slice(3) : '??????');
  console.log('accent token ->', hex, oog ? '(OOG!)' : '(in gamut)', '| favicon ->', favHex);
  if (oog) fail.push('accent token is out of sRGB gamut - hex would not be exact');
  if (favHex !== hex) fail.push(`favicon hex ${favHex} != accent hex ${hex}`);
}

// Gate 54: right-of-title mono-caps replaced by lowercase .readout.
// The original one-shot pass left exactly 12; the console has since grown new
// screens (wallet status, ladder, resume) that use the same pattern, so the
// durable invariant is a FLOOR - readouts may be added, never reverted to
// mono-caps. (Same lesson as OBS-21: pin invariants, not one moment's count.)
const readouts = (app.match(/class="readout"/g) || []).length;
const labels = (app.match(/class="label"/g) || []).length;
console.log(`app.js: readout x${readouts}, label x${labels}`);
if (readouts < 12) fail.push(`expected at least 12 readouts, found ${readouts}`);
if (!/\.readout\s*\{/.test(css)) fail.push('style.css has no .readout rule');

// No debug residue anywhere in the served code.
if (/\[trace\]|TRACE-|__renders/.test(app)) fail.push('trace instrumentation still in app.js');

// 44px floor: every control rule must reference --control-h.
for (const sel of ['.btn {', '.btn--sm {', '.input,', '.nav a {', '.pick {', '.copy {', '.skip {']) {
  const re = new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm');
  const m = re.exec(css);
  if (!m) { fail.push(`selector ${sel} not found`); continue; }
  const block = css.slice(m.index, css.indexOf('}', m.index));
  if (!/--control-h/.test(block)) fail.push(`${sel} does not use --control-h`);
}
if (!/--control-h:\s*2\.75rem/.test(tokens)) fail.push('--control-h token missing or not 2.75rem');

console.log(fail.length ? 'FAIL:\n' + fail.join('\n') : 'ALL SOURCE CHECKS PASS');
process.exit(fail.length ? 1 : 0);
