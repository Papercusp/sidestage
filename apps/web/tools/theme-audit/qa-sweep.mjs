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
import { audit, PALETTE } from './audit-lib.mjs';

const BASE = process.env.QA_BASE ?? 'http://localhost:5173';
const OUT = process.env.QA_OUT ?? '/home/marsh-office/.papercusp/scratch/su-3b39b/qa';
mkdirSync(OUT, { recursive: true });

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
  const a = await page.evaluate(audit, PALETTE);
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
