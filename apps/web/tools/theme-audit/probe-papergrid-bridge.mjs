/**
 * D-006 re-check — grade the papergrid-bridge criterion that shipped UNKNOWN.
 *
 * WHAT D-006 SAYS. The R3 acceptance scorecard graded 5 criteria HEALTHY and the
 * papergrid-bridge criterion UNKNOWN, on the grounds that "papergrid renders ZERO
 * canvases on production", making the criterion vacuous (0-of-0) rather than
 * passing. Follow-up EI-20411520596913364 was left open to grade it "against a
 * real canvas render once production exercises papergrid".
 *
 * WHY THAT FRAMING CANNOT EVER RESOLVE, AND WHAT THIS PROBE MEASURES INSTEAD.
 * papergrid ships TWO grids (libs/papergrid/grid-core/src/):
 *   - DataGridShell.tsx — glide-data-grid, paints to a 2D <canvas>
 *   - RichGrid.tsx      — plain DOM, emits <div role="row">
 * SideStage imports ONLY RichGrid (apps/web/src/event-creation/InventoryPickerGrid.tsx
 * and apps/web/src/events/EventLineupGrid.tsx). `DataGridShell` appears nowhere in
 * apps/web/src. So "zero canvases" is TRUE but measures a component the app never
 * mounts — waiting for a canvas render is waiting for something that cannot happen.
 *
 * The bridge is nonetheless genuinely exercised and genuinely gradeable: RichGrid
 * imports GRID_COLORS from grid-theme.ts, which is exactly what applyGridTheme()
 * mutates via configureGridColors(). So the criterion is answerable by reading the
 * colours RichGrid actually PAINTS.
 *
 * THE FALSIFIER. grid-theme.ts's NEUTRAL default is a dark palette
 * (headerBg #0e0e0e, text #e6e6e6, bg #141414). If the bridge did not run, or ran
 * before the tokens existed, the grid renders THOSE — the precise "black strip with
 * near-white titles on cream" defect the bridge was written to fix. This probe fails
 * if it sees them. That makes a pass mean "R3 reached the grid", not "nothing threw".
 *
 * Preserves both README properties: a token control (a real page fails if unloaded)
 * and a render proof (an absent grid is reported ABSENT, never as a clean pass).
 *
 *   node apps/web/tools/theme-audit/probe-papergrid-bridge.mjs
 *   SIDESTAGE_AUDIT_BASE=https://sidestage.buyrestart.com node ...   # production
 */
import { chromium } from 'playwright';

const BASE = (process.env.SIDESTAGE_AUDIT_BASE || process.env.QA_BASE || 'http://localhost:5173').replace(/\/$/, '');

/** The library defaults the bridge exists to override — seeing these is the failure. */
const NEUTRAL_DARK = {
  headerBg: '#0e0e0e', bg: '#141414', rowAlt: '#1a1a1a', text: '#e6e6e6',
};
const rgbToHex = (c) => {
  const m = String(c).match(/-?[\d.]+/g);
  if (!m || m.length < 3) return null;
  return '#' + m.slice(0, 3).map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('');
};

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 160)));

await page.goto(`${BASE}/?tab=seller`, { waitUntil: 'networkidle', timeout: 45000 });
// The grid lives in the event-manager dock panel; give the dock + data a beat to mount.
await page.waitForSelector('[role="row"]', { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(1500);

const probe = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const rows = [...document.querySelectorAll('[role="row"]')];
  const painted = rows.slice(0, 6).map((r) => {
    const s = getComputedStyle(r);
    return { bg: s.backgroundColor, color: s.color };
  });
  // Header cells sit above the rows inside the same grid container.
  const gridRoot = rows[0]?.closest('div')?.parentElement ?? null;
  const headerish = gridRoot
    ? [...gridRoot.querySelectorAll('div')].slice(0, 25).map((d) => getComputedStyle(d).backgroundColor)
    : [];
  return {
    canvases: document.querySelectorAll('canvas').length,
    rowCount: rows.length,
    painted,
    headerish: [...new Set(headerish)].slice(0, 10),
    bodyChars: (document.body.innerText || '').trim().length,
    // falsifiable control
    brandRed: cs.getPropertyValue('--brand-red').trim(),
    surfaceSunken: cs.getPropertyValue('--surface-sunken').trim(),
    undefinedControl: cs.getPropertyValue('--definitely-not-a-token').trim(),
  };
});

await browser.close();

const controlOk = probe.brandRed !== '' && probe.undefinedControl === '';
const observedHexes = new Set(
  [...probe.painted.flatMap((p) => [rgbToHex(p.bg), rgbToHex(p.color)]), ...probe.headerish.map(rgbToHex)]
    .filter(Boolean),
);
const darkHits = Object.entries(NEUTRAL_DARK).filter(([, hex]) => observedHexes.has(hex));

console.log(`base: ${BASE}`);
console.log(`control: brand-red="${probe.brandRed}" surface-sunken="${probe.surfaceSunken}" undefined="${probe.undefinedControl}" -> ${controlOk ? 'OK' : 'FAILED'}`);
console.log(`canvases rendered: ${probe.canvases}   (D-006 counted THIS; the app imports only the DOM RichGrid, never DataGridShell)`);
console.log(`RichGrid rows rendered: ${probe.rowCount}   bodyChars=${probe.bodyChars}`);
for (const p of probe.painted) console.log(`   row bg=${p.bg} (${rgbToHex(p.bg)}) color=${p.color} (${rgbToHex(p.color)})`);
console.log(`distinct container backgrounds: ${probe.headerish.join(', ') || '(none)'}`);
if (consoleErrors.length) for (const e of consoleErrors) console.log(`   ! ${e}`);

if (!controlOk) { console.log('\nVERDICT: INVALID — page did not load; no claim made.'); process.exit(2); }
if (probe.rowCount === 0) {
  console.log('\nVERDICT: GRID ABSENT — no RichGrid mounted on this surface. Criterion stays UNGRADED here (reported absent, NOT passed).');
  process.exit(3);
}
if (darkHits.length) {
  console.log(`\nVERDICT: FAIL — grid is wearing papergrid's NEUTRAL dark default (${darkHits.map(([k, v]) => `${k}=${v}`).join(', ')}). The bridge did not reach it.`);
  process.exit(1);
}
console.log(`\nVERDICT: PASS — ${probe.rowCount} RichGrid rows painted, and NONE of papergrid's neutral-dark defaults (${Object.values(NEUTRAL_DARK).join(', ')}) appear. The R3 bridge reached the grid.`);
process.exit(0);
