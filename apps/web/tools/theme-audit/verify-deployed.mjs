// verify-deployed.mjs — live-verify a DEPLOYED SideStage carries the R3 theme.
//
// Written for WI-38661 (plan sidestage-red-yellow-retheme-2026-08-13 P-005): a
// deploy is not verified by reading the CSS file over curl. Text in a bundle is
// not the same claim as a value the browser actually RESOLVED on a rendered
// page — a token can be present in the file and still be overridden, shadowed,
// or never applied. This probe asserts the computed values in a live page.
//
// Two load-bearing properties, both deliberate (carried from the P-004 audit):
//
//   1. FALSIFIABLE CONTROL. Every run also reads a token that is defined
//      NOWHERE. It must come back "". If the control ever returns a value, the
//      probe itself is broken (bad selector, wrong document, cross-page
//      buffer) and EVERY positive reading in that run is void. A probe that
//      can only say "pass" is not evidence.
//   2. RENDER PROOF. An EMPTY page passes a token check exactly like a healthy
//      one — :root resolves fine on a blank body. So each tab must also prove
//      it rendered real content before its readings count.
//
// Uses its OWN chromium instance. Never the shared `verdict` daemon: that is a
// singleton another agent's navigation silently retargets mid-run, which
// manufactures both false failures AND false passes (EI-20403007799747278).
//
//   SIDESTAGE_AUDIT_BASE=https://sidestage.buyrestart.com node verify-deployed.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = (process.env.SIDESTAGE_AUDIT_BASE || 'http://localhost:5173').replace(/\/$/, '');
const SHOTS = process.env.SIDESTAGE_AUDIT_SHOTS || '/tmp/ss-prod-verify';
const TABS = ['buyer', 'seller', 'config', 'test'];

// The R3 palette, as the browser must resolve it — not as it appears in source.
const EXPECT = {
  '--brand-red': 'rgb(214, 43, 31)',
  '--brand-yellow': 'rgb(255, 196, 0)',
  '--success': 'rgb(25, 107, 66)',
  '--warning': 'rgb(155, 99, 0)',
  '--danger': 'rgb(166, 27, 16)',
};

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const failures = [];
const results = [];

for (const tab of TABS) {
  const url = `${BASE}/?tab=${tab}`;
  let navError = null;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 }).catch((e) => {
    navError = e.message;
  });
  await page.waitForTimeout(1000);

  if (navError) {
    failures.push(`${tab}: navigation failed — ${navError}`);
    results.push({ tab, navError });
    continue;
  }

  const r = await page.evaluate((expectKeys) => {
    const cs = getComputedStyle(document.documentElement);

    // Resolve each token THROUGH a real CSS property. getPropertyValue() on a
    // custom property returns the raw declared TEXT ("#D62B1F"), never a
    // computed rgb() — only real properties compute. Reading the raw text would
    // compare a hex string against an rgb string and report a false regression
    // on a perfectly correct site. Assigning `color: var(--tok)` and reading
    // back the computed color is also the STRONGER claim: it proves the token
    // actually RESOLVES to a usable color rather than merely being present.
    const probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const resolve = (decl) => {
      probe.style.color = '';
      probe.style.color = `var(${decl})`;
      return getComputedStyle(probe).color;
    };

    const tokens = {};
    const tokensRaw = {};
    for (const k of expectKeys) {
      tokens[k] = resolve(k);
      tokensRaw[k] = cs.getPropertyValue(k).trim();
    }

    // The control: defined nowhere. Resolving it must fall back (never a real
    // color), and its raw text must be "".
    const controlResolved = resolve('--brand-nonexistent-control-token');
    const control = cs.getPropertyValue('--brand-nonexistent-control-token').trim();
    probe.remove();

    // Render proof: real, visible content — not a blank shell.
    const text = (document.body.innerText || '').trim();
    const visible = [...document.querySelectorAll('button,a,input,select,[role=tab]')].filter(
      (e) => e.getBoundingClientRect().width > 2 && e.getBoundingClientRect().height > 2,
    ).length;

    // Native widget paint: a contrast audit CANNOT see this (accent-color
    // contributes to no fg/bg ratio), which is exactly how 51 default-blue
    // checkboxes survived two theme passes and a full contrast sweep.
    const boxes = [...document.querySelectorAll('input[type=checkbox],input[type=radio]')].filter(
      (e) => e.getBoundingClientRect().width > 2,
    );
    const unthemed = boxes.filter((e) => getComputedStyle(e).accentColor === 'auto').length;
    const rootAccent = cs.accentColor;

    return {
      tokens,
      tokensRaw,
      control,
      controlResolved,
      textLen: text.length,
      visible,
      boxes: boxes.length,
      unthemed,
      rootAccent,
    };
  }, Object.keys(EXPECT));

  // 1. Control must be empty, or the whole run is void. Two ways it can fail:
  //    the undefined token has raw text (impossible unless we misread the
  //    document), or resolving it yields a brand colour (which would mean the
  //    resolve() helper reports palette values for ANY input, making every
  //    positive reading below worthless).
  if (r.control !== '') {
    failures.push(
      `${tab}: CONTROL RAW RETURNED "${r.control}" — probe is broken, all readings in this run are void`,
    );
  }
  if (Object.values(EXPECT).includes(r.controlResolved)) {
    failures.push(
      `${tab}: CONTROL RESOLVED to palette value "${r.controlResolved}" — resolve() returns brand colours for undefined tokens, all readings in this run are void`,
    );
  }

  // 2. Render proof before any reading counts.
  const rendered = r.textLen > 200 && r.visible >= 3;
  if (!rendered) {
    failures.push(
      `${tab}: RENDER PROOF FAILED (textLen=${r.textLen}, visibleControls=${r.visible}) — token readings from a blank page are meaningless`,
    );
  }

  // 3. Tokens, only meaningful once 1 and 2 hold.
  for (const [tok, want] of Object.entries(EXPECT)) {
    if (r.tokens[tok] !== want) {
      failures.push(`${tab}: ${tok} = "${r.tokens[tok]}" (expected "${want}")`);
    }
  }

  // 4. accent-color — the c0f16f3 fix.
  if (r.rootAccent !== EXPECT['--brand-red']) {
    failures.push(`${tab}: :root accent-color = "${r.rootAccent}" (expected "${EXPECT['--brand-red']}")`);
  }
  if (r.unthemed > 0) {
    failures.push(`${tab}: ${r.unthemed}/${r.boxes} native controls still render the UA default`);
  }

  await page.screenshot({ path: `${SHOTS}/${tab}.png`, fullPage: true });
  results.push({ tab, rendered, ...r });
  console.log(
    `${tab.padEnd(7)} render=${rendered ? 'OK' : 'FAIL'} textLen=${String(r.textLen).padStart(5)} ` +
      `controls=${String(r.visible).padStart(3)} boxes=${r.boxes} unthemed=${r.unthemed} ` +
      `accent=${r.rootAccent} control="${r.control}"`,
  );
}

await browser.close();

console.log(`\nbase: ${BASE}`);
console.log(`screenshots: ${SHOTS}`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nVERIFY_RESULT=FAIL');
  process.exit(1);
}
console.log('\nAll tabs: rendered real content, control empty, R3 tokens + accent-color correct.');
console.log('VERIFY_RESULT=PASS');
