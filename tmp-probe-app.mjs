import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleMsgs = [];
const pageErrors = [];
const failed = [];
const badResponses = [];

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 400)}`);
  }
});
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e).slice(0, 1200)));
page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', async (r) => {
  if (r.status() >= 400) {
    let body = '';
    try { body = (await r.text()).slice(0, 300); } catch {}
    badResponses.push(`${r.status()} ${r.request().method()} ${r.url()} :: ${body}`);
  }
});

let navErr = null;
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
} catch (e) {
  navErr = String(e).slice(0, 500);
}
await page.waitForTimeout(3000);

const info = await page.evaluate(() => ({
  title: document.title,
  url: location.href,
  bodyTextHead: (document.body?.innerText ?? '').slice(0, 1500),
  rootHTMLHead: (document.querySelector('#root')?.innerHTML ?? '(no #root)').slice(0, 600),
}));

console.log(JSON.stringify({
  navErr,
  info,
  pageErrors,
  consoleMsgs: consoleMsgs.slice(0, 30),
  failed: failed.slice(0, 20),
  badResponses: badResponses.slice(0, 20),
}, null, 2));

await browser.close();
