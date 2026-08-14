/**
 * D-003 verification: with a RED/YELLOW brand, semantic states must stay legible —
 * error must not read as the CTA red, warning must not read as brand yellow.
 * The rehearsal/preflight runner on the test tab is where pass/fail/warn chips
 * actually render, so drive it and read the semantic inks that come back.
 */
import { chromium } from 'playwright';
import { audit, PALETTE } from './audit-lib.mjs';
const OUT = '/home/marsh-office/.papercusp/scratch/su-3b39b/qa';

const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });

const semantics = async (tag) => {
  const a = await p.evaluate(audit, PALETTE);
  const chips = await p.evaluate(() => {
    const hex = (s) => {
      const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return s;
      const [r, g, bl] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return '#' + [r, g, bl].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    };
    const out = [];
    for (const el of document.querySelectorAll('[class*=status], [class*=chip], [class*=badge], [class*=pill], [class*=verdict], [class*=result]')) {
      const r = el.getBoundingClientRect(); if (r.height < 2) continue;
      const cs = getComputedStyle(el);
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
      if (!t) continue;
      out.push({ t, cls: (el.className || '').toString().split(/\s+/).filter((c) => /status|chip|badge|pill|verdict|result/.test(c))[0], fg: hex(cs.color), bg: hex(cs.backgroundColor) });
    }
    const seen = new Set();
    return out.filter((o) => { const k = o.cls + o.fg + o.bg; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14);
  });
  console.log(`\n--- ${tag} --- contrast=${a.counts.contrast} drift=${a.counts.drift} d003=${a.counts.collisions}`);
  for (const c of a.contrast.slice(0, 5)) console.log(`   ✗ ${c.ratio}(<${c.floor}) ${c.el} fg=${c.fg} bg=${c.bg} "${c.text}"`);
  for (const c of chips) console.log(`   chip ${String(c.cls).padEnd(22)} fg=${c.fg} bg=${c.bg}  "${c.t}"`);
  for (const c of a.collisions) console.log(`   ⛔ D-003 COLLISION ${c.el} "${c.text}"`);
  await p.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
};

await p.goto('http://localhost:5173/?tab=test', { waitUntil: 'networkidle' }).catch(() => {});
await p.waitForTimeout(1200);
await semantics('test-idle');

for (const label of ['Re-run preflight', 'Re-check setup']) {
  const btn = p.locator(`button:has-text("${label}")`).first();
  if (await btn.count()) { await btn.click().catch(() => {}); await p.waitForTimeout(2500); }
}
await semantics('test-preflight');

const dress = p.locator('button.primary').first();
if (await dress.count()) { await dress.click().catch(() => {}); await p.waitForTimeout(6000); }
await semantics('test-dress-rehearsal');

// buyer: the Hold-item flow (cart/checkout-adjacent state)
await p.goto('http://localhost:5173/?tab=buyer', { waitUntil: 'networkidle' }).catch(() => {});
await p.waitForTimeout(1200);
const hold = p.locator('button:has-text("Hold item")').first();
if (await hold.count()) { await hold.click().catch(() => {}); await p.waitForTimeout(2500); }
await semantics('buyer-hold-item');

await b.close();
