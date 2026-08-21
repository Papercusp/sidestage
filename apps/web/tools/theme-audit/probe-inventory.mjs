/**
 * Surface INVENTORY: prove each named P-004 surface actually rendered content
 * before any "0 failures" reading about it is meaningful. An empty panel and a
 * clean panel are indistinguishable to a contrast audit.
 */
import { chromium } from 'playwright';
import { audit, PALETTE } from './audit-lib.mjs';
import { mkdirSync } from 'node:fs';
const OUT = '/home/marsh-office/.papercusp/scratch/su-3b39b/qa';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const net = [];
p.on('response', (r) => { if (r.status() >= 400) net.push(`${r.status()} ${r.url().replace('http://localhost:3110', 'API')}`); });

await p.goto('http://localhost:5173/?tab=buyer', { waitUntil: 'networkidle' }).catch(() => {});
await p.waitForTimeout(1800);

const inv = await p.evaluate(() => {
  const q = (s) => document.querySelectorAll(s).length;
  const vis = (s) => [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().height > 2).length;
  return {
    playerCard: vis('.buyer-player-card'),
    auctionRoot: vis('[class*=auction]'),
    auctionText: (document.querySelector('[class*=auction]')?.textContent || '').trim().slice(0, 120),
    railRoot: vis('[class*=product-rail], [class*=buyer-rail]'),
    railItems: vis('[class*=rail] li, [class*=rail] [class*=card], [class*=rail] button'),
    chat: vis('[class*=chat]'),
    guideTrigger: vis('button'),
    bodyChars: document.body.innerText.length,
    emptyStates: [...document.querySelectorAll('*')]
      .filter((e) => /no products|nothing|empty|unavailable|error|failed/i.test(e.textContent || '') && e.children.length === 0)
      .map((e) => e.textContent.trim().slice(0, 70)).slice(0, 6),
  };
});
console.log('BUYER INVENTORY', JSON.stringify(inv, null, 1));
console.log('NET >=400:', [...new Set(net)].slice(0, 8));

// open the channel guide ("What's on") — exercises the --scrim token
const opened = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /what.s on/i.test(b.textContent || ''));
  if (!btn) return false; btn.click(); return true;
});
await p.waitForTimeout(1000);
if (opened) {
  const guide = await p.evaluate(() => {
    const scrim = document.querySelector('[class*=scrim], [class*=overlay], [class*=backdrop]');
    const panel = document.querySelector('[class*=channel-guide]');
    return {
      scrimFound: !!scrim,
      scrimBg: scrim ? getComputedStyle(scrim).backgroundColor : null,
      panelVisible: panel ? panel.getBoundingClientRect().height > 2 : false,
      rows: document.querySelectorAll('[class*=guide] [class*=row], [class*=guide] li').length,
    };
  });
  console.log('CHANNEL GUIDE', JSON.stringify(guide));
  await p.screenshot({ path: `${OUT}/buyer-channel-guide.png`, fullPage: true });
  const a = await p.evaluate(audit, PALETTE);
  console.log(`GUIDE AUDIT contrast=${a.counts.contrast} drift=${a.counts.drift} d003=${a.counts.collisions}`);
  for (const c of a.contrast.slice(0, 6)) console.log(`   ✗ ${c.ratio} ${c.el} fg=${c.fg} bg=${c.bg} "${c.text}"`);
  for (const d of a.drift.slice(0, 8)) console.log(`   ~ ${d.hex} a=${d.alpha} ${d.prop} <- ${d.sample}`);
} else console.log('CHANNEL GUIDE: trigger not found');

await b.close();
