#!/usr/bin/env node
/**
 * SideStage R3 "Ticket" retheme sweep — plan sidestage-red-yellow-retheme-2026-08-13, P-003.
 *
 * WHY THIS EXISTS. P-002 replaced the :root token block with the R3 light-cream palette
 * (D-004), but the BODY of every stylesheet still carried the pre-retheme dark-navy + cyan
 * theme: navy panel gradients and dark inset wells painted on a cream page, cyan borders and
 * glows, pale-blue text, and near-black label text sitting on the new red CTA fill. This
 * routes every one of those literals onto a token (D-002: "no component-level palette forks,
 * no new hardcoded hexes; a component needing a colour that has no token gets a new named
 * token").
 *
 * WHY IT IS PROPERTY-AWARE AND NOT A find/replace. The same literal means different things in
 * different declarations: rgba(155,191,235,.22) is a hairline BORDER in one rule and a chip
 * BACKGROUND in the next, and on a light ground those need opposite treatments (a border token
 * vs a sunken-surface token). A literal->literal table cannot express that, so each occurrence
 * is classified by the CSS property it belongs to and mapped by (family, role).
 *
 * Run `node tools/retheme-sweep.mjs` to preview every decision, `--write` to apply.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'src');
const WRITE = process.argv.includes('--write');

const FILES = [
  'styles.css',
  'auction.css',
  'BuyerProductRail.css',
  'event-creation/event-creation.css',
  'events/event-manager.css',
];

/**
 * The :root / .density-* blocks in styles.css ARE the token definitions — the one place a raw
 * hex is correct. Sweeping them would rewrite the palette into self-references.
 */
const PROTECTED = { 'styles.css': (line) => line <= 93 };

/** Colour families of the retired dark theme, by RGB triple. */
const FAMILY = new Map();
const fam = (name, triples) => triples.forEach((t) => FAMILY.set(t, name));
fam('cyan', ['98,216,255', '118,231,255', '138,218,255']);
fam('navywell', ['4,13,28', '7,17,34', '6,21,37', '4,12,24', '10,30,47', '11,20,40', '13,27,52', '20,18,49']);
fam('steel', ['155,191,235', '147,191,221', '185,201,223']);
fam('success', ['101,239,196', '116,224,173', '133,240,205']);
fam('yellow', ['246,199,111', '255,197,110']);
fam('warning', ['255,183,95']);
fam('danger', ['251,113,133']);
fam('violet', ['143,125,255', '167,139,250']);
fam('white', ['255,255,255']);
fam('shadow', ['0,0,0', '3,8,21']);
fam('videodark', ['5,11,22']);
/** Already-R3 values that were hand-inlined rather than routed through their token. */
fam('brandred', ['214,43,31']);
fam('brandyellow', ['255,196,0']);
fam('ink', ['42,31,26']);

const HEX = new Map(Object.entries({
  '#62d8ff': 'cyan-solid',
  '#7188a9': 'muted', '#627a9e': 'muted', '#7d8da8': 'muted',
  '#afbdd0': 'muted', '#9eb2c6': 'muted', '#b9c9df': 'muted', '#7088ab': 'muted',
  '#f7fbff': 'text', '#edf7ff': 'text', '#eaf5ff': 'text',
  '#dcd6ff': 'text', '#c9ffef': 'text', '#b7f7e5': 'text',
  '#ff9caa': 'danger-solid', '#ff7286': 'danger-solid',
  '#ffb5bd': 'danger-solid', '#ff9d9d': 'danger-solid',
  '#65efc4': 'success-solid',
  '#ffc56e': 'yellow-solid',
  '#8f7dff': 'violet-solid',
  '#061525': 'on-red', '#21122e': 'on-yellow', '#2b2110': 'on-yellow',
  '#050b16': 'video',
  '#FFF3E0': 'bg-top',
}));

/**
 * Exact declarations rewritten wholesale. Two cases the per-literal mapper cannot reach:
 * multi-stop gradients (a stop's replacement depends on its position, not its own value), and
 * text-on-fill (#061525 is correct ON CYAN and illegible on the red that replaced it, so the
 * mapping follows the sibling background declaration, not the literal).
 */
const EXACT = [
  // --- panel gradients: navy-on-dark becomes a warm hairline lift on white -------------------
  ['background: linear-gradient(145deg, rgba(28, 54, 94, .82), var(--surface));',
   'background: var(--panel-grad);'],
  ['background: linear-gradient(145deg, rgba(22, 57, 88, .88), rgba(18, 34, 62, .8));',
   'background: var(--panel-grad-brand);'],
  ['background: linear-gradient(145deg, rgba(22,57,88,.88), rgba(18,34,62,.8));',
   'background: var(--panel-grad-brand);'],
  ['background: linear-gradient(145deg, rgba(47, 40, 88, .72), var(--surface));',
   'background: var(--panel-grad-yellow);'],
  ['background: linear-gradient(145deg, rgba(25,68,64,.82), rgba(18,34,62,.8));',
   'background: var(--panel-grad-success);'],
  ['background: linear-gradient(145deg, rgba(62, 46, 106, .55), var(--surface));',
   'background: var(--panel-grad-yellow);'],
  ['background: linear-gradient(145deg, rgba(28, 54, 94, .72), var(--surface));',
   'background: var(--panel-grad);'],
  ['background: linear-gradient(150deg, rgba(27, 53, 91, .86), rgba(13, 27, 52, .9));',
   'background: var(--panel-grad);'],
  ['background: linear-gradient(150deg, rgba(24, 60, 96, .86), rgba(13, 27, 52, .9));',
   'background: var(--panel-grad);'],
  // --- text on a brand fill: follows the fill, not the old literal ---------------------------
  ['.button.primary { color: #061525; background: var(--accent); border-color: var(--accent); box-shadow: 0 8px 28px rgba(98, 216, 255, .19); }',
   '.button.primary { color: var(--on-brand-red); background: var(--brand-red); border-color: var(--brand-red); box-shadow: 0 8px 28px color-mix(in srgb, var(--brand-red) 26%, transparent); }'],
  ['.button.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); }',
   '.button.primary:hover { background: var(--brand-red-hover); border-color: var(--brand-red-hover); }'],
  ['color: #061525; background: var(--accent);', 'color: var(--on-brand-red); background: var(--brand-red);'],
  ['color: #061525; background: var(--amber);', 'color: var(--on-brand-yellow); background: var(--brand-yellow);'],
  ['color: #21122e; background: var(--violet);', 'color: var(--on-brand-yellow); background: var(--brand-yellow);'],
  // --- the live-video inset stays deliberately dark on the light page (D-004) ----------------
  ['background: radial-gradient(circle at 50% 45%, rgba(98,216,255,.12), transparent 34%), #050b16;',
   'background: radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--brand-red) 14%, transparent), transparent 34%), var(--video-inset-bg);'],
  ['background: rgba(5,11,22,.82);', 'background: color-mix(in srgb, var(--video-inset-bg) 82%, transparent);'],
  ['background: rgba(5, 11, 22, .82);', 'background: color-mix(in srgb, var(--video-inset-bg) 82%, transparent);'],
  // --- the page wash: already-R3 values, but inlined instead of routed -----------------------
  ['background: radial-gradient(circle at 50% -15%, rgba(214, 43, 31, .07), transparent 40%), radial-gradient(circle at 100% 25%, rgba(255, 196, 0, .09), transparent 35%), linear-gradient(180deg, #FFF3E0 0%, var(--bg) 70%);',
   'background: radial-gradient(circle at 50% -15%, color-mix(in srgb, var(--brand-red) 7%, transparent), transparent 40%), radial-gradient(circle at 100% 25%, color-mix(in srgb, var(--brand-yellow) 9%, transparent), transparent 35%), linear-gradient(180deg, var(--bg-top) 0%, var(--bg) 70%);'],
  // --- chrome that was a dark translucent bar and must become a frosted light one ------------
  ['background: rgba(11, 20, 40, .78);', 'background: color-mix(in srgb, var(--surface) 86%, transparent);'],
];

/**
 * `color: var(--accent)` was legible cyan-on-navy; the same token now resolves to the CTA red,
 * which is a fill colour, not a text colour. Route text uses onto the text-safe siblings the
 * token block already defines (--red-text / --yellow-text are the AA-on-cream pair).
 */
const TEXT_TOKEN = [
  [/color:\s*var\(--accent\)/g, 'color: var(--red-text)'],
  [/color:\s*var\(--accent-strong\)/g, 'color: var(--red-text)'],
  [/color:\s*var\(--cyan\)/g, 'color: var(--red-text)'],
  [/color:\s*var\(--amber\)/g, 'color: var(--yellow-text)'],
  [/color:\s*var\(--violet\)/g, 'color: var(--yellow-text)'],
];

const pct = (a) => {
  const n = Math.round(parseFloat(a) * 1000) / 10;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
};
const mix = (token, alpha) => `color-mix(in srgb, var(${token}) ${pct(alpha)}, transparent)`;

/** (family, role, alpha) -> replacement. `role` is the CSS property class of the occurrence. */
function mapAlpha(family, role, alpha) {
  const a = parseFloat(alpha);
  switch (family) {
    case 'cyan':
      return role === 'shadow' ? mix('--brand-red', alpha)
        : role === 'text' ? 'var(--red-text)'
        : mix('--brand-red', alpha);
    case 'navywell':
      // On the dark theme a higher alpha meant a deeper well. On cream, the high-alpha uses are
      // all form controls / opaque chrome, which read as WHITE fields against the page; the
      // low-alpha ones are recessed wells, which read as a deeper cream.
      return a >= 0.4 ? 'var(--surface)' : 'var(--surface-sunken)';
    case 'steel':
      return role === 'border' ? 'var(--border)'
        : role === 'text' ? 'var(--muted)'
        : 'var(--surface-sunken)';
    case 'white':
      return role === 'shadow' ? null // an inset white top-highlight is a no-op on white; leave it
        : role === 'border' ? 'var(--border)'
        : 'var(--surface-glass)';
    case 'shadow':
      return `rgb(var(--shadow-hue) / ${pct(alpha)})`;
    case 'success': return role === 'text' ? 'var(--success)' : mix('--success', alpha);
    case 'yellow': return role === 'text' ? 'var(--yellow-text)' : mix('--brand-yellow', alpha);
    case 'warning': return role === 'text' ? 'var(--warning)' : mix('--warning', alpha);
    case 'danger': return role === 'text' ? 'var(--danger)' : mix('--danger', alpha);
    case 'violet': return role === 'text' ? 'var(--yellow-text)' : mix('--brand-yellow', alpha);
    case 'videodark': return mix('--video-inset-bg', alpha);
    case 'brandred': return mix('--brand-red', alpha);
    case 'brandyellow': return mix('--brand-yellow', alpha);
    case 'ink': return mix('--text', alpha);
    default: return null;
  }
}

const HEX_MAP = {
  'cyan-solid': () => 'var(--brand-red)',
  muted: () => 'var(--muted)',
  text: () => 'var(--text)',
  'danger-solid': () => 'var(--danger)',
  'success-solid': () => 'var(--success)',
  'yellow-solid': () => 'var(--brand-yellow)',
  'violet-solid': () => 'var(--yellow-text)',
  'on-red': () => 'var(--on-brand-red)',
  'on-yellow': () => 'var(--on-brand-yellow)',
  video: () => 'var(--video-inset-bg)',
  'bg-top': () => 'var(--bg-top)',
};

/** Which CSS property does the character at `idx` belong to? */
function roleAt(text, idx) {
  const start = Math.max(text.lastIndexOf(';', idx), text.lastIndexOf('{', idx), text.lastIndexOf('\n', idx));
  const decl = text.slice(start + 1, idx);
  const prop = (decl.match(/([-a-z]+)\s*:/i) || [, ''])[1].toLowerCase();
  if (/shadow/.test(prop)) return 'shadow';
  if (/^(border|outline)/.test(prop)) return 'border';
  if (/^background/.test(prop)) return 'bg';
  if (prop === 'color' || /-color$/.test(prop)) return prop === 'border-color' ? 'border' : 'text';
  if (/^(fill|stroke)$/.test(prop)) return 'bg';
  return 'bg';
}

const report = [];
let changed = 0;

for (const rel of FILES) {
  const path = resolve(ROOT, rel);
  const original = readFileSync(path, 'utf8');
  let text = original;

  for (const [from, to] of EXACT) {
    if (text.includes(from)) {
      text = text.split(from).join(to);
      report.push({ file: rel, kind: 'exact', from: from.slice(0, 78), to: to.slice(0, 78) });
    }
  }
  for (const [re, to] of TEXT_TOKEN) {
    text = text.replace(re, (m) => {
      report.push({ file: rel, kind: 'text-token', from: m, to });
      return to;
    });
  }

  const guard = PROTECTED[rel];
  const lineOf = (idx) => text.slice(0, idx).split('\n').length;

  // rgb()/rgba() occurrences, matched by family so every alpha of a family is covered at once.
  text = text.replace(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)/g,
    (match, r, g, b, alpha, idx) => {
      if (guard && guard(lineOf(idx))) return match;
      const family = FAMILY.get(`${r},${g},${b}`);
      if (!family) return match;
      const role = roleAt(text, idx);
      const out = mapAlpha(family, role, alpha ?? '1');
      if (!out) return match;
      report.push({ file: rel, kind: `${family}/${role}`, from: match, to: out });
      return out;
    });

  text = text.replace(/#[0-9a-fA-F]{3,8}\b/g, (match, idx) => {
    if (guard && guard(lineOf(idx))) return match;
    const kind = HEX.get(match) || HEX.get(match.toLowerCase());
    if (!kind) return match;
    const out = HEX_MAP[kind]();
    report.push({ file: rel, kind: `hex/${kind}`, from: match, to: out });
    return out;
  });

  if (text !== original) {
    changed++;
    if (WRITE) writeFileSync(path, text);
  }
}

const byKind = report.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {});
console.log(`${WRITE ? 'APPLIED' : 'DRY RUN'} — ${report.length} replacements across ${changed} files\n`);
console.log('by mapping rule:');
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}
console.log('\ndistinct rewrites:');
const seen = new Set();
for (const r of report) {
  const key = `${r.kind}|${r.from}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  [${r.kind}] ${r.from}  ->  ${r.to}`);
}
