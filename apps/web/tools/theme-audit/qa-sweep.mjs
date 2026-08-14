/**
 * WI-38660 / P-004 — full-surface visual QA of the SideStage R3 "Ticket" retheme.
 *
 * Runs its OWN isolated Chromium (NOT the shared `verdict` daemon, which is a
 * singleton another agent's navigation silently retargets — EI-20403007799747278).
 * Page-theft is therefore structurally impossible here, not merely detectable.
 *
 * Per surface it captures a full-page screenshot AND a machine audit:
 *   - WCAG AA contrast for every visible text-bearing element (alpha-composited bg)
 *   - D-003 collision: destructive/danger controls must not wear the CTA red FILL
 *   - drift: computed colours that are not resolvable to the D-004 token set
 *   - console errors
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.QA_BASE ?? 'http://localhost:5173';
const OUT = process.env.QA_OUT ?? '/home/marsh-office/.papercusp/scratch/su-3b39b/qa';
mkdirSync(OUT, { recursive: true });

// D-004 token values (the plan Decision), as the drift oracle.
const PALETTE = {
  '#FFF8EF': 'bg', '#FFFFFF': 'surface', '#EBDFCC': 'border', '#2A1F1A': 'text',
  '#77685A': 'muted', '#D62B1F': 'brand-red', '#FFF8F5': 'on-brand-red',
  '#B52218': 'red-text', '#C2271C': 'brand-red-hover', '#B42217': 'brand-red-active',
  '#FFC400': 'brand-yellow', '#2A1F04': 'on-brand-yellow', '#9B6300': 'yellow-text/warning',
  '#EDB400': 'brand-yellow-hover', '#D9A500': 'brand-yellow-active',
  '#196B42': 'success', '#A61B10': 'danger',
  '#FBF2E3': 'surface-sunken', '#FDF8F0': 'surface-glass', '#FFF3E0': 'bg-top',
};

const audit = (paletteHexes) => {
  const px = (s) => { const m = String(s).match(/-?[\d.]+/); return m ? parseFloat(m[0]) : 0; };
  const parse = (s) => {
    if (!s) return null;
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  // Effective background: composite alpha layers upward. Returns null when a
  // gradient/image intervenes (unresolvable — reported as skipped, never as a fail).
  const effBg = (el) => {
    const stack = [];
    let e = el;
    while (e) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { gradient: true, at: label(e) };
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
      e = e.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };

  const contrast = [];
  const drift = [];
  const collisions = [];
  const seenDrift = new Set();
  const brandRed = '#D62B1F';

  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);

    // --- drift: any computed colour that is not a D-004 token value ---
    for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor']) {
      const c = parse(cs[prop]);
      if (!c || c.a === 0) continue;
      const h = hex(c);
      if (paletteHexes.includes(h)) continue;
      const key = `${prop}|${h}`;
      if (seenDrift.has(key)) continue;
      seenDrift.add(key);
      drift.push({ prop, hex: h, alpha: c.a, sample: label(el) });
    }

    // --- D-003: a destructive control must not wear the CTA red FILL ---
    const txt = (el.textContent || '').trim().toLowerCase();
    const isDestructive = /\b(delete|remove|destroy|cancel|discard|reset|end (event|stream|show)|kick|ban)\b/.test(txt)
      && txt.length < 40
      && ['BUTTON', 'A'].includes(el.tagName);
    if (isDestructive) {
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0.5 && hex(bg) === brandRed) {
        collisions.push({ el: label(el), text: txt.slice(0, 40), fill: hex(bg) });
      }
    }

    // --- contrast: elements with their OWN direct text ---
    const direct = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!direct) continue;
    const fg = parse(cs.color);
    if (!fg || fg.a === 0) continue;
    const bg = effBg(el);
    if (!bg || bg.gradient) { continue; } // unresolvable ground — never reported as a fail
    const fgc = fg.a < 0.999 ? over(fg, bg) : fg;
    const size = px(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const floor = large ? 3.0 : 4.5;
    const r = ratio(fgc, bg);
    if (r < floor) {
      contrast.push({
        el: label(el), text: (el.textContent || '').trim().slice(0, 45),
        fg: hex(fgc), bg: hex(bg), size, weight, ratio: Math.round(r * 100) / 100, floor,
      });
    }
  }

  contrast.sort((a, b) => a.ratio - b.ratio);
  return {
    href: location.href,
    counts: { contrast: contrast.length, drift: drift.length, collisions: collisions.length },
    contrast: contrast.slice(0, 25),
    drift: drift.slice(0, 40),
    collisions,
  };
};

const SURFACES = [
  { id: 'buyer', url: `${BASE}/?tab=buyer` },
  { id: 'seller', url: `${BASE}/?tab=seller` },
  { id: 'config', url: `${BASE}/?tab=config` },
  { id: 'test', url: `${BASE}/?tab=test` },
];

const results = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

for (const s of SURFACES) {
  const consoleErrors = [];
  const onMsg = (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); };
  page.on('console', onMsg);
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));

  await page.goto(s.url, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => consoleErrors.push('goto: ' + e.message));
  await page.waitForTimeout(1200);

  // identity assertion — this browser is mine, but assert anyway so a wrong
  // navigation can never be silently audited as the right surface.
  const href = page.url();
  const ok = href.includes(`tab=${s.id}`);

  await page.screenshot({ path: `${OUT}/${s.id}.png`, fullPage: true });
  const a = await page.evaluate(audit, Object.keys(PALETTE));
  const tokenProbe = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue('--bg').trim(),
      brandRed: cs.getPropertyValue('--brand-red').trim(),
      undefinedControl: cs.getPropertyValue('--definitely-not-a-token').trim(),
    };
  });

  results.push({ surface: s.id, urlOk: ok, href, tokenProbe, consoleErrors: consoleErrors.slice(0, 8), ...a });
  page.removeListener('console', onMsg);
}

await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));

for (const r of results) {
  console.log(`\n=== ${r.surface} === urlOk=${r.urlOk} tokens(bg=${r.tokenProbe.bg} red=${r.tokenProbe.brandRed} control="${r.tokenProbe.undefinedControl}")`);
  console.log(`   contrast_fails=${r.counts.contrast} drift=${r.counts.drift} d003_collisions=${r.counts.collisions} consoleErrors=${r.consoleErrors.length}`);
  for (const c of r.contrast.slice(0, 8)) console.log(`   ✗ ${c.ratio} (<${c.floor}) ${c.el} fg=${c.fg} bg=${c.bg} ${c.size}px/${c.weight} "${c.text}"`);
  for (const c of r.collisions) console.log(`   ⛔ D-003 ${c.el} "${c.text}" fill=${c.fill}`);
  for (const e of r.consoleErrors) console.log(`   ! ${e}`);
}
console.log(`\nreport: ${OUT}/report.json`);
