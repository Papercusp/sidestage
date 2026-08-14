/**
 * P-007 / WI-38799 — responsive integrity across phone / tablet / desktop widths.
 *
 * WHY THIS EXISTS ALONGSIDE qa-sweep.mjs: qa-sweep audits paint at a FIXED
 * 1440x900. Every `@media (max-width: ...)` rule in the app is therefore dead
 * code to it — the narrow layouts it never renders are exactly where a
 * responsive defect lives. This probe re-renders the same four surfaces at the
 * widths those media queries actually switch on.
 *
 * Widths are derived from the app's OWN declared breakpoints (520/560/620/640/
 * 680/760/800/820/900/960) rather than invented device names, so each width
 * lands on a distinct side of a real switch:
 *   phone   390  — below every breakpoint (single-column, stacked topbar)
 *   tablet  820  — between 800 and 900 (mid-collapse)
 *   laptop  1280 — inside the two-row topbar range; guards the Demo User
 *                  Switch against navigation overlap at 1280x720 (EI-204585)
 *   desktop 1440 — above all of them (matches qa-sweep, cross-checks it)
 *
 * Runs its OWN isolated Chromium, for the same reason every probe here does:
 * the shared `verdict` daemon is a singleton another agent's navigation
 * silently retargets mid-run (EI-20403007799747278).
 *
 * PRESERVES THE TWO PROPERTIES THE README REQUIRES:
 *   1. Falsifiable control — asserts --brand-red resolves AND a deliberately
 *      undefined token resolves to "". A blank/half-loaded page FAILS here
 *      rather than passing vacuously with zero overflow.
 *   2. Render proven before "0 failures" is believed — an empty page has no
 *      horizontal overflow either. Body text and element count are asserted
 *      per width, so green means "clean", never "absent".
 *
 *   node apps/web/tools/theme-audit/probe-responsive.mjs   # exit 0 = pass
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { audit, PALETTE } from './audit-lib.mjs';

const BASE = process.env.QA_BASE ?? 'http://localhost:5173';
const OUT = process.env.QA_OUT ?? '/tmp/sidestage-logs/qa-responsive';
mkdirSync(OUT, { recursive: true });

const WIDTHS = [
  { id: 'phone', width: 390, height: 844 },
  { id: 'tablet', width: 820, height: 1180 },
  { id: 'laptop', width: 1280, height: 720 },
  { id: 'desktop', width: 1440, height: 900 },
];
const TABS = ['buyer', 'seller', 'config', 'test'];

/**
 * Page-level horizontal overflow, plus the elements responsible.
 *
 * An element wider than the viewport is only a DEFECT when nothing can scroll
 * it. `.tab-nav` sets `overflow-x:auto` at <=900px on purpose, so its wide
 * children are correct by design. We therefore ignore any element that has a
 * scrollable-x ancestor, and report only genuine escapes.
 */
const overflowAudit = () => {
  const vw = document.documentElement.clientWidth;
  const scrollable = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ov = getComputedStyle(p).overflowX;
      if (ov === 'auto' || ov === 'scroll') return true;
    }
    return false;
  };
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    // position:fixed overlays are viewport-relative by design.
    if (cs.position === 'fixed') continue;
    if (r.right > vw + 1 && !scrollable(el)) {
      offenders.push({
        el: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
        right: Math.round(r.right),
        width: Math.round(r.width),
        vw,
      });
    }
  }
  // Deduplicate by selector — one broken grid yields dozens of identical rows.
  const seen = new Map();
  for (const o of offenders) if (!seen.has(o.el)) seen.set(o.el, o);
  return {
    docScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: vw,
    pageOverflows: document.documentElement.scrollWidth > vw + 1,
    offenders: [...seen.values()].slice(0, 10),
    offenderCount: offenders.length,
  };
};

/** Render proof + falsifiable token control, in one evaluate. */
const renderProbe = () => {
  const cs = getComputedStyle(document.documentElement);
  return {
    bodyChars: (document.body.innerText || '').trim().length,
    elements: document.querySelectorAll('body *').length,
    brandRed: cs.getPropertyValue('--brand-red').trim(),
    undefinedControl: cs.getPropertyValue('--definitely-not-a-token').trim(),
  };
};

/**
 * Tap targets below the 44x44 CSS-px floor (WCAG 2.5.5 / iOS HIG), phone only.
 * Reported as ADVISORY, not a failure: inline text links are legitimately
 * smaller and flagging them would drown the real signal.
 */
const tapTargets = () => {
  const small = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, [role="button"]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (getComputedStyle(el).display === 'inline') continue;
    if (r.width < 44 || r.height < 44) {
      small.push({
        el: el.tagName.toLowerCase(),
        w: Math.round(r.width),
        h: Math.round(r.height),
        text: (el.textContent || '').trim().slice(0, 30),
      });
    }
  }
  return small.slice(0, 12);
};

/**
 * EI-204585 recurrence guard: prove the Switch button owns its center point,
 * then drive that exact coordinate with a real pointer and verify the app's
 * two identity keys changed. A DOM-only click would miss the original defect,
 * where the visually exposed button was covered by the Orders navigation link.
 */
const identitySwitchProbe = async (page) => {
  const nextIdentity = 'qa-switch-1280';
  let hitTarget = null;

  try {
    const input = page.locator('#global-demo-user-id');
    const button = page.getByRole('button', { name: 'Switch', exact: true });
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await button.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill(nextIdentity);

    hitTarget = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const owner = document.elementFromPoint(centerX, centerY);
      return {
        centerX,
        centerY,
        ownsCenter: owner === element || element.contains(owner),
        owner: owner
          ? `${owner.tagName.toLowerCase()}${typeof owner.className === 'string' && owner.className.trim() ? `.${owner.className.trim().split(/\s+/).join('.')}` : ''}`
          : null,
      };
    });

    await page.mouse.click(hitTarget.centerX, hitTarget.centerY);
    await page.waitForFunction(
      (expected) => localStorage.getItem('sidestage-demo-user-id') === expected
        && localStorage.getItem('sidestage-buyer-id') === expected,
      nextIdentity,
      { timeout: 3000 },
    );

    const stored = await page.evaluate(() => ({
      demo: localStorage.getItem('sidestage-demo-user-id'),
      buyer: localStorage.getItem('sidestage-buyer-id'),
    }));
    return {
      tested: true,
      hitTarget,
      clickOk: stored.demo === nextIdentity && stored.buyer === nextIdentity,
      stored,
      error: null,
    };
  } catch (error) {
    const stored = await page.evaluate(() => ({
      demo: localStorage.getItem('sidestage-demo-user-id'),
      buyer: localStorage.getItem('sidestage-buyer-id'),
    })).catch(() => ({ demo: null, buyer: null }));
    return {
      tested: true,
      hitTarget,
      clickOk: false,
      stored,
      error: String(error).slice(0, 500),
    };
  }
};

const results = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

for (const w of WIDTHS) {
  const ctx = await browser.newContext({
    viewport: { width: w.width, height: w.height },
    deviceScaleFactor: 1,
    isMobile: w.id === 'phone',
    hasTouch: w.id === 'phone',
  });
  const page = await ctx.newPage();

  for (const tab of TABS) {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));

    const url = `${BASE}/?tab=${tab}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
      .catch((e) => consoleErrors.push('goto: ' + e.message));
    await page.waitForTimeout(900);

    const render = await page.evaluate(renderProbe);
    const ov = await page.evaluate(overflowAudit);
    const a = await page.evaluate(audit, PALETTE);
    const taps = w.id === 'phone' ? await page.evaluate(tapTargets) : [];
    const identitySwitch = w.id === 'laptop' && tab === 'buyer'
      ? await identitySwitchProbe(page)
      : null;

    await page.screenshot({ path: `${OUT}/${w.id}-${tab}.png`, fullPage: true });

    // The control: a page that did not really load cannot pass these.
    const controlOk = render.brandRed !== '' && render.undefinedControl === '';
    const renderOk = render.bodyChars > 200 && render.elements > 40;

    results.push({
      width: w.id, px: w.width, tab,
      controlOk, renderOk,
      bodyChars: render.bodyChars, elements: render.elements,
      pageOverflows: ov.pageOverflows,
      docScrollWidth: ov.docScrollWidth, viewportWidth: ov.viewportWidth,
      offenders: ov.offenders, offenderCount: ov.offenderCount,
      contrast: a.counts.contrast, drift: a.counts.drift, collisions: a.counts.collisions,
      contrastDetail: a.contrast.slice(0, 5),
      consoleErrors: consoleErrors.slice(0, 6),
      smallTapTargets: taps,
      identitySwitch,
    });
    page.removeAllListeners('console');
    page.removeAllListeners('pageerror');
  }
  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/responsive-report.json`, JSON.stringify(results, null, 2));

let failures = 0;
for (const r of results) {
  const bad = [];
  if (!r.controlOk) bad.push('CONTROL-FAILED(page did not load)');
  if (!r.renderOk) bad.push(`NOT-RENDERED(chars=${r.bodyChars},els=${r.elements})`);
  if (r.pageOverflows) bad.push(`H-OVERFLOW(${r.docScrollWidth}>${r.viewportWidth})`);
  if (r.offenderCount > 0) bad.push(`ESCAPES(${r.offenderCount})`);
  if (r.contrast > 0) bad.push(`CONTRAST(${r.contrast})`);
  if (r.collisions > 0) bad.push(`D003(${r.collisions})`);
  if (r.consoleErrors.length > 0) bad.push(`CONSOLE(${r.consoleErrors.length})`);
  if (r.identitySwitch && !r.identitySwitch.hitTarget?.ownsCenter) {
    bad.push(`SWITCH-HIT(${r.identitySwitch.hitTarget?.owner ?? 'none'})`);
  }
  if (r.identitySwitch && !r.identitySwitch.clickOk) bad.push('SWITCH-CLICK');
  if (bad.length) failures++;
  console.log(`${bad.length ? '✗' : '✓'} ${r.width}(${r.px}) ${r.tab} — ${bad.length ? bad.join(' ') : 'clean'} [drift=${r.drift} chars=${r.bodyChars}]`);
  for (const o of r.offenders) console.log(`     ↳ escapes: ${o.el} right=${o.right} > vw=${o.vw} (w=${o.width})`);
  for (const c of r.contrastDetail) console.log(`     ↳ contrast ${c.ratio} (<${c.floor}) ${c.el} "${c.text}"`);
  for (const e of r.consoleErrors) console.log(`     ↳ console: ${e}`);
  if (r.identitySwitch) {
    console.log(`     ${r.identitySwitch.hitTarget?.ownsCenter && r.identitySwitch.clickOk ? '✓' : '✗'} Switch pointer: center=${r.identitySwitch.hitTarget?.owner ?? 'none'} storage=${JSON.stringify(r.identitySwitch.stored)}`);
    if (r.identitySwitch.error) console.log(`     ↳ Switch error: ${r.identitySwitch.error}`);
  }
  if (r.smallTapTargets.length) console.log(`     ~ advisory: ${r.smallTapTargets.length} tap target(s) <44px, e.g. ${r.smallTapTargets.slice(0, 3).map((t) => `${t.el}(${t.w}x${t.h})"${t.text}"`).join(', ')}`);
}
console.log(`\nreport: ${OUT}/responsive-report.json`);
console.log(failures === 0 ? '\nRESPONSIVE: PASS' : `\nRESPONSIVE: FAIL (${failures}/${results.length} surface-widths)`);
process.exit(failures === 0 ? 0 : 1);
