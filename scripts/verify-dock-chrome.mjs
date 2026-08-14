/**
 * Live verification for the Seller dock chrome (P-011).
 *
 * WHY THIS EXISTS ALONGSIDE apps/web/src/seller-dock-chrome.test.ts:
 * the unit test pins what the STYLESHEET says (every --dv-* we set is one
 * dockview really reads; the base-theme class is present). It cannot see the
 * live CASCADE — whether those variables actually resolve on the mounted dock,
 * whether the tab strip really lands on the token, whether a keyboard focus
 * ring is really painted. Those are only answerable in a browser, and every one
 * of them was a real defect at some point in this pass.
 *
 * Requires the dev server running (npm run dev -w apps/web) on :5173.
 * Drives its OWN chromium: the shared `verdict` daemon is a singleton that
 * concurrent agents navigate out from under each other mid-chain, which
 * silently measures the wrong page.
 *
 *   node scripts/verify-dock-chrome.mjs        # exit 0 = all checks pass
 *   DOCK_URL=... node scripts/verify-dock-chrome.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright-core');

/** The bundled playwright-core pins a browser build this box may not have. */
function findChromium() {
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium')).sort().reverse()) {
    for (const rel of [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome'], ['chrome-linux', 'headless_shell']]) {
      const p = join(root, dir, ...rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const URL_ = process.env.DOCK_URL || 'http://localhost:5173/?tab=seller';
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(URL_, { waitUntil: 'domcontentloaded' });

// Layout persistence would make every geometry claim below a claim about a
// SAVED layout rather than the default one.
await page.evaluate(() => localStorage.removeItem('sidestage.dock:seller'));
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.seller-dock-theme .dv-tab', { timeout: 15000 });

// CALIBRATION FIRST: assert the subject is present before asserting anything
// about it, so an absent dock reads as a failure rather than a clean pass.
const cal = await page.evaluate(() => ({
  url: location.search,
  root: !!document.querySelector('.seller-dock-theme'),
  tabs: document.querySelectorAll('.dv-tab').length,
  sashes: document.querySelectorAll('.dv-sash').length,
}));
check('calibration: seller dock rendered with tabs + sashes',
  cal.root && cal.tabs > 0 && cal.sashes > 0, JSON.stringify(cal));

// :focus-visible must be earned by real keyboard modality — a programmatic
// .focus() is one the browser may decline to style, which would pass a ring
// check that a keyboard user never sees.
let reached = false;
for (let i = 0; i < 60 && !reached; i++) {
  await page.keyboard.press('Tab');
  reached = await page.evaluate(() => !!document.activeElement?.closest?.('.dv-tab'));
}

const m = await page.evaluate(() => {
  const root = document.querySelector('.seller-dock-theme');
  const rs = getComputedStyle(document.documentElement);
  const g = (el, v) => getComputedStyle(el).getPropertyValue(v).trim();
  const mk = (c) => { const d = document.createElement('div'); d.className = c; document.body.appendChild(d); return d; };
  const stock = mk('dockview-theme-light');   // dockview's own theme, untouched
  const bare = mk('seller-dock-theme');       // our file alone == the pre-fix defect

  // Variables consumed by GENERIC rules (skip rules scoped to another theme).
  const used = new Set();
  const walk = (rules) => { for (const r of rules) {
    if (r.cssRules) walk(r.cssRules);
    if (/\.dockview-theme-(?!light\b)[a-z-]+/i.test(r.selectorText || '')) continue;
    for (const x of (r.cssText || '').match(/var\(\s*--dv-[a-z0-9-]+/gi) || []) used.add(x.replace(/var\(\s*/i, '').toLowerCase());
  } };
  for (const ss of document.styleSheets) { let r2; try { r2 = ss.cssRules; } catch { continue; } if (r2) walk(r2); }
  const unresolved = (el) => [...used].filter((v) => g(el, v) === '');

  // Resolve --ss-* at the DOCK's scope, not :root. SideStage's density system
  // (.density-console etc.) redefines them below :root, so a :root reading is a
  // DIFFERENT value — that mistake produced a wrong "expected" in this pass.
  const rootPx = parseFloat(rs.fontSize);
  const remAt = (el, v) => parseFloat(g(el, v)) * rootPx;
  const strip = document.querySelector('.dv-tabs-and-actions-container');
  const tab = document.querySelector('.dv-tab');
  const sash = document.querySelector('.dv-sash');
  const active = document.activeElement?.closest('.dv-tab');
  const acs = active ? getComputedStyle(active) : null;
  const host = document.querySelector('.seller-dock-host').getBoundingClientRect();

  const out = {
    liveUnresolved: unresolved(root), bareUnresolved: unresolved(bare), stockUnresolved: unresolved(stock),
    density: (root.closest('[class*="density-"]')?.className || '').match(/density-\w+/)?.[0] ?? '(none)',
    stripPx: strip.getBoundingClientRect().height, expectStripPx: remAt(root, '--ss-control-h'),
    tabFontPx: parseFloat(getComputedStyle(tab).fontSize), expectFontPx: remAt(root, '--ss-font'),
    borderTok: rs.getPropertyValue('--border').trim(), sashVar: g(root, '--dv-sash-color'),
    sashBg: sash ? getComputedStyle(sash).backgroundColor : null,
    accent: rs.getPropertyValue('--accent').trim(),
    focusVisible: active ? active.matches(':focus-visible') : false,
    outlineW: acs?.outlineWidth, outlineStyle: acs?.outlineStyle, outlineColor: acs?.outlineColor, outlineOffset: acs?.outlineOffset,
    floatingBorder: g(root, '--dv-floating-border'), scrollbar: g(root, '--dv-scrollbar-background-color'),
    ctxMenuBg: g(root, '--dv-context-menu-background-color'), transition: g(root, '--dv-transition-duration'),
    dockSized: host.width > 0 && host.height > 0, dockRect: `${Math.round(host.width)}x${Math.round(host.height)}`,
    rootClass: root.className,
  };
  stock.remove(); bare.remove();
  return out;
});

const hex2rgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };

check('dock root carries base theme + our theme (base FIRST)',
  /^dockview-theme-light\s+seller-dock-theme\b/.test(m.rootClass), m.rootClass);
check('fix resolves vars the bare theme leaves undefined',
  m.bareUnresolved.length > m.liveUnresolved.length,
  `bare=${m.bareUnresolved.length} -> live=${m.liveUnresolved.length}`);
check('no worse than STOCK dockview-light (remaining are dockview baseline)',
  m.liveUnresolved.length <= m.stockUnresolved.length,
  `live=[${m.liveUnresolved}] stock=[${m.stockUnresolved}]`);
check('tab strip height EQUALS --ss-control-h at the dock scope',
  m.stripPx === m.expectStripPx, `${m.stripPx}px vs ${m.expectStripPx}px (${m.density})`);
check('tab font-size EQUALS --ss-font at the dock scope',
  m.tabFontPx === m.expectFontPx, `${m.tabFontPx}px vs ${m.expectFontPx}px (${m.density})`);
check('idle sash is a visible hairline in --border (D-001 affordance)',
  m.sashVar.toLowerCase() === m.borderTok.toLowerCase() && m.sashBg === hex2rgb(m.borderTok),
  `var=${m.sashVar} computed=${m.sashBg} token=${m.borderTok}`);
check('keyboard focus ring on .dv-tab (:focus-visible, inset)',
  m.focusVisible && m.outlineStyle === 'solid' && parseFloat(m.outlineW) >= 2 &&
  m.outlineColor === hex2rgb(m.accent) && parseFloat(m.outlineOffset) < 0,
  `visible=${m.focusVisible} ${m.outlineW} ${m.outlineStyle} ${m.outlineColor} offset=${m.outlineOffset}`);
check('no grey/dark leak: floating border + scrollbar + menu bound to tokens',
  m.floatingBorder.includes(m.borderTok) && m.scrollbar !== '' && m.ctxMenuBg !== '' && m.transition === '0.15s',
  `border=${m.floatingBorder} scrollbar=${m.scrollbar} menu=${m.ctxMenuBg} t=${m.transition}`);
check('dock is SIZED on screen (not merely present in the DOM)',
  m.dockSized, m.dockRect);

// A matching number can be coincidence. Change the density scope and the chrome
// must MOVE with it — that is what proves the token binding is real.
const density = await page.evaluate(() => {
  const root = document.querySelector('.seller-dock-theme');
  const scope = root.closest('[class*="density-"]');
  const strip = document.querySelector('.dv-tabs-and-actions-container');
  const before = strip.getBoundingClientRect().height;
  if (!scope) return { skipped: true };
  const prev = scope.className;
  scope.className = prev.replace(/density-\w+/, 'density-compact');
  const after = strip.getBoundingClientRect().height;
  const expectAfter = parseFloat(getComputedStyle(root).getPropertyValue('--ss-control-h'))
    * parseFloat(getComputedStyle(document.documentElement).fontSize);
  scope.className = prev;
  return { before, after, expectAfter, restored: strip.getBoundingClientRect().height };
});
check('chrome TRACKS a density change (binding is real, not a coincidence)',
  !density.skipped && density.after !== density.before && density.after === density.expectAfter
  && density.restored === density.before,
  JSON.stringify(density));

if (process.env.DOCK_SHOT) await page.screenshot({ path: process.env.DOCK_SHOT });
await browser.close();

let failed = 0;
for (const c of checks) { if (!c.pass) failed++; console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}`); }
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
