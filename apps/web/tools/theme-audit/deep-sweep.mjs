/**
 * WI-38660 / P-004 — DEEP surface sweep: the states behind an interaction
 * (show page, auction/hold, event creation, dock panels), which a URL-only
 * pass never reaches. Own isolated Chromium; not the shared verdict daemon.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { audit, PALETTE } from './audit-lib.mjs';

const BASE = 'http://localhost:5173';
const OUT = '/home/marsh-office/.papercusp/scratch/su-3b39b/qa';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));

const results = [];
async function capture(name, note = '') {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const a = await page.evaluate(audit, PALETTE);
  // falsifiable control: a token that must NOT resolve, beside one that must.
  const probe = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { accent: cs.accentColor, brandRed: cs.getPropertyValue('--brand-red').trim(), control: cs.getPropertyValue('--nope').trim() };
  });
  results.push({ state: name, note, probe, ...a });
  console.log(`\n=== ${name} === ${note}`);
  console.log(`   ${a.href}`);
  console.log(`   contrast=${a.counts.contrast} drift=${a.counts.drift} d003=${a.counts.collisions} accentAuto=${a.counts.accentAuto}  accent=${probe.accent} control="${probe.control}"`);
  for (const c of a.contrast.slice(0, 6)) console.log(`   ✗ ${c.ratio}(<${c.floor}) ${c.el} fg=${c.fg} bg=${c.bg} "${c.text}"`);
  for (const d of a.drift.slice(0, 10)) console.log(`   ~ drift ${d.hex} a=${d.alpha} ${d.prop} <- ${d.sample}`);
  for (const c of a.collisions) console.log(`   ⛔ D-003 ${c.el} "${c.text}"`);
}

const click = async (sel, label) => {
  const el = page.locator(sel).first();
  if (await el.count() === 0 || !(await el.isVisible().catch(() => false))) { console.log(`   (skip: ${label} not present)`); return false; }
  await el.click({ timeout: 5000 }).catch((e) => console.log(`   (click failed ${label}: ${e.message.slice(0, 60)})`));
  return true;
};

// --- 1. buyer: the show page (event route) ---
await page.goto(`${BASE}/?tab=buyer`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(1200);
const eventHref = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a[href*="event="]')][0];
  return a ? a.getAttribute('href') : null;
});
if (eventHref) {
  await page.goto(new URL(eventHref, BASE).href, { waitUntil: 'networkidle' }).catch(() => {});
  await capture('buyer-show-page', 'show page: player + rail + auction + chat');
  if (await click('button:has-text("Hold item")', 'Hold item')) await capture('buyer-hold', 'after Hold item (auction/cart state)');
  if (await click('button:has-text("Connect to stream")', 'Connect')) await capture('buyer-connect', 'after Connect to stream');
} else console.log('   (no event link on buyer tab)');

// --- 2. seller console: event creation + dock ---
await page.goto(`${BASE}/?tab=seller`, { waitUntil: 'networkidle' }).catch(() => {});
await capture('seller-console', 'seller console default dock');
if (await click('button:has-text("Create event")', 'Create event')) await capture('seller-create-event', 'event creation form');
await page.goto(`${BASE}/?tab=seller`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForTimeout(800);
if (await click('button:has-text("Start event")', 'Start event')) await capture('seller-start-event', 'after Start event (LIVE chrome)');

// --- 3. narrow viewport (responsive chrome) ---
await ctx.pages()[0].setViewportSize({ width: 420, height: 900 });
await page.goto(`${BASE}/?tab=buyer`, { waitUntil: 'networkidle' }).catch(() => {});
await capture('buyer-mobile', '420px viewport');

await browser.close();
writeFileSync(`${OUT}/deep-report.json`, JSON.stringify({ results, errors }, null, 2));
console.log(`\npageerrors: ${errors.length}`);
for (const e of errors.slice(0, 6)) console.log('   !', e);
console.log(`report: ${OUT}/deep-report.json`);
