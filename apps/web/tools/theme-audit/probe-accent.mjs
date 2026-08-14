import { chromium } from 'playwright';
// Subject is overridable so this probe can be pointed at a DEPLOYED site
// (e.g. SIDESTAGE_AUDIT_BASE=https://sidestage.buyrestart.com) instead of only
// the local dev server. Defaults to local dev, so existing usage is unchanged.
const BASE = (process.env.SIDESTAGE_AUDIT_BASE || 'http://localhost:5173').replace(/\/$/, '');
const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
for (const tab of ['buyer', 'seller', 'config', 'test']) {
  await p.goto(`${BASE}/?tab=${tab}`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(800);
  const r = await p.evaluate(() => {
    const boxes = [...document.querySelectorAll('input[type=checkbox],input[type=radio]')]
      .filter((e) => e.getBoundingClientRect().width > 2);
    const rows = boxes.map((e) => ({
      accent: getComputedStyle(e).accentColor,
      inToggleRow: !!e.closest('.toggle-row'),
      parent: (e.parentElement?.className || '').toString().split(/\s+/)[0] || e.parentElement?.tagName,
      checked: e.checked,
    }));
    const unthemed = rows.filter((r) => r.accent === 'auto');
    return { total: boxes.length, unthemed: unthemed.length, sample: unthemed.slice(0, 5) };
  });
  console.log(tab, JSON.stringify(r));
}
await b.close();
