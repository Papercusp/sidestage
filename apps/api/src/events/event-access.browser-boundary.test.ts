/**
 * P-008 BROWSER LAYER — the demo-identity boundary in a REAL browser.
 *
 * D-008 and D-009 C3 both rule that P-006's and P-007's evidence is jsdom-only
 * while the surfaces they govern are genuinely browser-side, and that closing
 * that gap belongs to P-008. This file is that layer. It boots the real Nest
 * application on a real port, serves the real web app through a real Vite dev
 * server proxied at `/api`, and drives a real Chromium against it — so the
 * things jsdom cannot model (an HttpOnly cookie jar, a real `sessionStorage`,
 * a real `localStorage`, a real module graph) are exercised as themselves.
 *
 * WHY THIS FILE LIVES UNDER apps/api RATHER THAN apps/web. It is end-to-end: it
 * needs `AppModule` AND node-land (`vite`, `playwright`). Only the
 * `sidestage-node` project can import both — `apps/web`'s tsconfig is
 * `moduleResolution: Bundler` with `types: ['vite/client']` and no node types,
 * so importing Nest from `apps/web/src` would drag the whole API into the web
 * typecheck. It sits beside `event-access.matrix.test.ts` (every route is
 * CLASSIFIED) and `event-access.cross-seller.test.ts` (the classification is
 * TRUE) as the third member of that family: the boundary holds IN A BROWSER.
 * The web app is reached by PATH (`configFile`), never by import, so apps/api's
 * typecheck stays inside apps/api.
 *
 * OPT-IN, following this repository's existing `SIDESTAGE_PG_INTEGRATION=1`
 * convention (see `apps/api/src/sync/parity/differential.integration.test.ts`,
 * which also keeps a `runIf(!ARMED)` counterpart so an unarmed run still says
 * so out loud rather than reporting silent absence). Arming costs a Vite boot
 * and a Chromium launch, and requires `npm run qa:browsers -w
 * @papercusp/sidestage-web` to have installed Chromium:
 *
 *   SIDESTAGE_BROWSER_INTEGRATION=1 npm run test:file -- \
 *     apps/api/src/events/event-access.browser.test.ts
 *
 * Unarmed, nothing here is imported: `vite` and `playwright` are loaded by
 * dynamic import inside `beforeAll`, so collection stays cheap for the gate.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { bootNestTestApp } from '@papercusp/test-config/nest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { AUCTION_GUEST_COOKIE } from '../auction/auction-access.service';

const ARMED = process.env.SIDESTAGE_BROWSER_INTEGRATION === '1';

/**
 * The web workspace, found by walking up from the runner's cwd to the directory
 * that owns `apps/web/vite.config.ts`.
 *
 * `import.meta.url` is the obvious way to do this and is NOT available here:
 * apps/api pins `module`/`moduleResolution` to node10 for Nest's CommonJS emit,
 * so tsc rejects it with TS1343 (the same node10 pin behind
 * EI-22383491035147414). cwd differs between `npm run test:file` at the repo
 * root and `npm run test -w @papercusp/sidestage-api` inside apps/api, so it is
 * searched for rather than assumed.
 */
function resolveWebRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'apps/web');
    if (existsSync(join(candidate, 'vite.config.ts'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate apps/web/vite.config.ts from ${process.cwd()}`);
}

/**
 * The role-crossing pair D-009 C1 requires. `normalizeRoleDemoIdentity` strips
 * and re-prefixes the persona, so the BUYER id holds still at `buyer-avi` while
 * App's unroled `userId` moves — which is the only configuration in which App's
 * own `key={userId}` is the mechanism under test rather than
 * `BuyerCheckoutProvider`'s `key={buyerId}` remounting the subtree anyway.
 */
const AVI_BUYER = 'buyer-avi';
const AVI_SELLER = 'seller-avi';
/** A second ordinary buyer, for the cases where a persona CHANGE is the point. */
const MIRA_BUYER = 'buyer-mira';

interface Harness {
  /** Base URL of the Vite dev server serving the real web app. */
  base: string;
  browser: import('playwright').Browser;
  /** A fresh, cookie-isolated page. Every cell gets its own. */
  newPage: () => Promise<import('playwright').Page>;
}

let harness: Harness;
let nestApp: INestApplication | null = null;
let viteServer: { close: () => Promise<void> } | null = null;
let browser: import('playwright').Browser | null = null;

beforeAll(async () => {
  if (!ARMED) return;

  // 1. The real application graph, on a real port. `bootNestTestApp` has
  //    already called init(); listen() is idempotent about that and is what
  //    opens the socket a browser can actually reach.
  const nest = await bootNestTestApp({ metadata: { imports: [AppModule] } });
  nestApp = nest.app;
  await nest.app.listen(0, '127.0.0.1');
  const apiAddress = (nest.app.getHttpServer() as { address: () => { port: number } }).address();
  const apiOrigin = `http://127.0.0.1:${apiAddress.port}`;

  // 2. The real web app, through its own Vite config. The `/api` proxy is
  //    overridden inline to reach the port we just opened; the rewrite matches
  //    `stripDevApiPrefix` in apps/web/vite.config.ts (production keeps Nest
  //    under /api, local Nest is bare).
  const webRoot = resolveWebRoot();
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: join(webRoot, 'vite.config.ts'),
    root: webRoot,
    logLevel: 'warn',
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      proxy: {
        '/api': {
          target: apiOrigin,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, '') || '/',
        },
      },
    },
  });
  await server.listen();
  viteServer = server;
  const webAddress = server.httpServer?.address();
  if (!webAddress || typeof webAddress === 'string') throw new Error('Vite dev server did not open a port');
  const base = `http://127.0.0.1:${webAddress.port}`;

  // 3. A real browser.
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  harness = {
    base,
    browser,
    newPage: async () => {
      // A fresh CONTEXT, not just a page: the HttpOnly guest cookie lives in the
      // context's jar, and cells must not inherit each other's principal.
      const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
      return context.newPage();
    },
  };
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await viteServer?.close();
  await nestApp?.close();
});

/**
 * The app's own modules, as the Vite dev server serves them.
 *
 * D-009 C2's rule ("seed demo identity via writeDemoIdentity, never by writing
 * storage directly") is a rule about not re-implementing the storage contract in
 * a test. In a real browser the honest way to honour it is to call the real
 * module, so every key asserted below is the one the app itself composes rather
 * than this file's guess at the format.
 */
const PAGE_MODULES = {
  identity: '/src/buyer-identity.ts',
  scoutDrawer: '/src/BuyerScoutDrawer.tsx',
  scoutTransport: '/src/scout-transport.ts',
  sellerDock: '/src/seller-dock-store.ts',
} as const;

type PageModuleName = keyof typeof PAGE_MODULES;

/**
 * Import app modules into the page and stash them on `window.__p008`.
 *
 * The import is issued as a STRING expression, and that is load-bearing: Vitest
 * SSR-transforms this file before running it, and that transform rewrites every
 * `import(...)` it can see — including one written inside a `page.evaluate`
 * callback, which is serialized and run in the BROWSER where Vitest's
 * `__vite_ssr_dynamic_import__` shim does not exist. Measured: every cell using
 * an inline `await import()` failed with `ReferenceError:
 * __vite_ssr_dynamic_import__ is not defined`. A string is opaque to the
 * transform, so the browser receives a real dynamic import; the evaluate
 * callbacks below then read `window.__p008` and contain no import at all.
 */
async function importIntoPage(
  page: import('playwright').Page,
  ...names: PageModuleName[]
): Promise<void> {
  for (const name of names) {
    await page.evaluate(
      `import(${JSON.stringify(PAGE_MODULES[name])}).then((module) => {
         window.__p008 = window.__p008 || {};
         window.__p008[${JSON.stringify(name)}] = module;
       })`,
    );
  }
}

/** Shorthand for the stash, typed loosely because these are the app's modules. */
type PageModules = Record<PageModuleName, Record<string, (...args: never[]) => never>>;
declare global {
  interface Window {
    __p008?: Partial<PageModules>;
  }
}

/** Load the app on a tab and seed the demo identity through the app's own writer. */
async function loadAs(page: import('playwright').Page, identity: string, tab = 'buyer'): Promise<void> {
  await page.goto(`${harness.base}/?tab=${tab}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await importIntoPage(page, 'identity');
  await page.evaluate((value) => {
    (window.__p008!.identity as unknown as {
      writeDemoIdentity: (id: string, options: Record<string, never>) => void;
    }).writeDemoIdentity(value, {});
  }, identity);
  await page.waitForTimeout(500);
}

describe.runIf(ARMED)('demo identity boundary — real browser (D-008, D-009 C3)', () => {
  /**
   * D-009 C3's named case: "an HttpOnly bidder cookie rotated SERVER-side via
   * ?rotate=1 on POST /auctions/access/guest, which jsdom cannot exercise
   * end-to-end". Every assertion below is about the browser's own cookie jar,
   * so none of them can be written at jsdom level at all.
   */
  describe('the HttpOnly guest bidder cookie', () => {
    it('is invisible to the page, restores on re-request, and re-keys only on ?rotate=1', async () => {
      const page = await harness.newPage();
      const guest = async (rotate: boolean) => page.evaluate(async (withRotate) => {
        const response = await fetch(`/api/auctions/access/guest${withRotate ? '?rotate=1' : ''}`, {
          method: 'POST',
          credentials: 'include',
        });
        return { status: response.status, body: await response.json() as { bidderId: string } };
      }, rotate);

      await page.goto(`${harness.base}/?tab=buyer`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Nest answers a POST 201 by default; the status is asserted only to
      // prove the request reached the real controller through the proxy.
      const first = await guest(false);
      expect(first.status).toBe(201);
      expect(first.body.bidderId).toMatch(/\S/);

      // THE HttpOnly PROOF. jsdom has no HttpOnly concept — a cookie set there is
      // readable from script, so this assertion is vacuous outside a real browser.
      // The cookie must be in the CONTEXT's jar and absent from `document.cookie`.
      const visibleToPage = await page.evaluate(() => document.cookie);
      expect(visibleToPage).not.toContain(AUCTION_GUEST_COOKIE);
      const jar = await page.context().cookies();
      const guestCookie = jar.find((cookie) => cookie.name === AUCTION_GUEST_COOKIE);
      expect(guestCookie, `${AUCTION_GUEST_COOKIE} must be in the browser cookie jar`).toBeDefined();
      expect(guestCookie?.httpOnly).toBe(true);

      // Without rotate the server RESTORES the cookie's principal — this is the
      // half that makes the identity boundary a real problem: a demo user who
      // switched identity would otherwise keep bidding as the previous buyer.
      const restored = await guest(false);
      expect(restored.body.bidderId).toBe(first.body.bidderId);

      // `?rotate=1` is the only way the page can get a new anonymous principal,
      // precisely because it cannot drop an HttpOnly cookie itself.
      const rotated = await guest(true);
      expect(rotated.body.bidderId).not.toBe(first.body.bidderId);

      // The rotated principal must STICK, or the boundary would silently revert.
      const afterRotate = await guest(false);
      expect(afterRotate.body.bidderId).toBe(rotated.body.bidderId);

      await page.context().close();
    }, 120_000);
  });

  /**
   * D-008's REQUIRED clause: "a BROWSER-level assertion that scout continuity
   * re-keys on demo-identity switch — that the HTTP transport, conversation
   * cache and the `sidestage-scout-session-id:<key>` sessionStorage entry all
   * follow the newly selected buyer, and that no prior buyer's scout thread
   * survives the switch."
   *
   * The page imports the app's own modules off the Vite dev server, so the keys
   * asserted here are the ones `BuyerScoutDrawer` actually composes rather than
   * this test's guess at the format.
   */
  describe('scout continuity (D-008)', () => {
    it('re-keys transport, conversation cache and sessionStorage with the selected buyer', async () => {
      const page = await harness.newPage();
      await loadAs(page, AVI_BUYER);

      await importIntoPage(page, 'scoutDrawer');

      const result = await page.evaluate(({ avi, mira }) => {
        const drawer = window.__p008!.scoutDrawer as unknown as {
          buyerScoutResources: (id: string) => {
            transport: unknown;
            conversation: unknown;
            sessionStorageKey: string;
          };
        };
        const identity = window.__p008!.identity as unknown as {
          writeDemoIdentity: (id: string, options: Record<string, never>) => void;
        };

        const before = drawer.buyerScoutResources(avi);
        // A live scout thread for the first buyer, written through the key the
        // drawer itself hands out.
        sessionStorage.setItem(before.sessionStorageKey, 'session-for-avi');

        identity.writeDemoIdentity(mira, {});
        const after = drawer.buyerScoutResources(mira);

        return {
          beforeKey: before.sessionStorageKey,
          afterKey: after.sessionStorageKey,
          // The conversation cache is memoized per buyer: a repeated call for
          // the SAME buyer must return the same object, and a different buyer a
          // different one, or a switch would inherit the previous thread.
          sameBuyerCacheIsStable: drawer.buyerScoutResources(avi).conversation === before.conversation,
          cacheChanged: after.conversation !== before.conversation,
          transportChanged: after.transport !== before.transport,
          // The new buyer must start with NO stored session, and the previous
          // buyer's entry must not be reachable under the new key.
          afterKeyValue: sessionStorage.getItem(after.sessionStorageKey),
          scoutCookie: document.cookie,
        };
      }, { avi: AVI_BUYER, mira: MIRA_BUYER });

      expect(result.beforeKey).toBe(`sidestage-scout-session-id:${AVI_BUYER}`);
      expect(result.afterKey).toBe(`sidestage-scout-session-id:${MIRA_BUYER}`);
      expect(result.afterKey).not.toBe(result.beforeKey);
      expect(result.sameBuyerCacheIsStable).toBe(true);
      expect(result.cacheChanged).toBe(true);
      expect(result.transportChanged).toBe(true);
      // "No prior buyer's scout thread survives the switch."
      expect(result.afterKeyValue).toBeNull();

      await page.context().close();
    }, 120_000);

    it('re-keys the continuity cookie in a real cookie jar', async () => {
      const page = await harness.newPage();
      await loadAs(page, AVI_BUYER);

      // `ensureScoutBuyerCookie` writes through `document.cookie`, whose
      // set-one-read-all semantics jsdom only approximates. The clearing branch
      // (Max-Age=0) in particular is a real-browser behaviour.
      await importIntoPage(page, 'scoutTransport');

      const cookies = await page.evaluate(({ avi, mira }) => {
        const transport = window.__p008!.scoutTransport as unknown as {
          ensureScoutBuyerCookie: (id: string | null) => string | null;
        };
        const readAll = () => document.cookie;
        transport.ensureScoutBuyerCookie(avi);
        const asAvi = readAll();
        transport.ensureScoutBuyerCookie(mira);
        const asMira = readAll();
        transport.ensureScoutBuyerCookie(null);
        return { asAvi, asMira, cleared: readAll() };
      }, { avi: AVI_BUYER, mira: MIRA_BUYER });

      expect(cookies.asAvi).toContain(AVI_BUYER);
      expect(cookies.asMira).toContain(MIRA_BUYER);
      // The previous buyer must not linger beside the new one.
      expect(cookies.asMira).not.toContain(AVI_BUYER);
      // The explicit anonymous fallback clears rather than inheriting.
      expect(cookies.cleared).not.toContain(MIRA_BUYER);

      await page.context().close();
    }, 120_000);
  });

  /**
   * D-009 C1 at browser level. This is the real-browser counterpart of
   * `apps/web/src/App.identity-boundary.test.tsx`, and it uses the same
   * ROLE-CROSSING pair for the same reason: between two ordinary buyer personas
   * `BuyerCheckoutProvider`'s own `key={buyerId}` remounts the subtree anyway,
   * so the assertion would pass against a build with App's `key={userId}`
   * deleted. `buyer-avi` -> `seller-avi` holds the buyer id still and moves only
   * App's unroled userId.
   *
   * Node identity is compared inside a single `page.evaluate` because a DOM node
   * cannot cross the evaluate boundary — which is the same thing the jsdom suite
   * asserts, expressed in the one place real nodes exist.
   */
  describe('the per-user subtree (D-009 C1)', () => {
    it('remounts on a role-crossing switch while the public shell is preserved', async () => {
      const page = await harness.newPage();
      await loadAs(page, AVI_BUYER);
      await page.waitForSelector('#buyer', { timeout: 30_000 });

      const observed = await page.evaluate(async ({ seller }) => {
        const identity = window.__p008!.identity as unknown as {
          writeDemoIdentity: (id: string, options: Record<string, never>) => void;
        };
        const settle = () => new Promise((done) => setTimeout(done, 400));

        const perUserBefore = document.querySelector('#buyer');
        const shellBefore = document.querySelector('#main-content');

        identity.writeDemoIdentity(seller, {});
        await settle();

        const perUserAfter = document.querySelector('#buyer');
        const shellAfter = document.querySelector('#main-content');

        return {
          hadPerUser: perUserBefore !== null,
          hadShell: shellBefore !== null,
          stillHasPerUser: perUserAfter !== null,
          perUserRemounted: perUserAfter !== perUserBefore,
          shellPreserved: shellAfter === shellBefore,
        };
      }, { seller: AVI_SELLER });

      expect(observed.hadPerUser).toBe(true);
      expect(observed.hadShell).toBe(true);
      expect(observed.stillHasPerUser).toBe(true);
      expect(observed.perUserRemounted).toBe(true);
      expect(observed.shellPreserved).toBe(true);

      await page.context().close();
    }, 120_000);
  });

  /**
   * D-009 C3's "localStorage dock rows" case. The dock layout is the one piece
   * of Studio state that deliberately OUTLIVES the remount, so it is the surface
   * where a missing seller component silently leaks one seller's board to the
   * next — and localStorage persistence is exactly what jsdom's partial Storage
   * cannot model faithfully.
   */
  describe('seller dock layout rows (D-009 C3)', () => {
    it('keys each demo seller onto its own localStorage row', async () => {
      const page = await harness.newPage();
      await loadAs(page, AVI_SELLER, 'seller');

      await importIntoPage(page, 'sellerDock');

      const rows = await page.evaluate(({ sellerA, sellerB }) => {
        const store = window.__p008!.sellerDock as unknown as {
          sellerDockStorageKey: (layoutName?: string, prefix?: string) => string;
          sellerDockStoragePrefix: (sellerId: string | null | undefined, prefix?: string) => string;
        };
        const keyFor = (sellerId: string) =>
          store.sellerDockStorageKey(undefined, store.sellerDockStoragePrefix(sellerId));

        const keyA = keyFor(sellerA);
        const keyB = keyFor(sellerB);
        localStorage.setItem(keyA, JSON.stringify({ board: 'avi-layout' }));

        return {
          keyA,
          keyB,
          // Seller B must not be able to read seller A's saved board.
          bReadsOwnRow: localStorage.getItem(keyB),
          aRowIntact: localStorage.getItem(keyA),
          // The shared, pre-P-007 row must not be what either seller lands on.
          sharedRow: store.sellerDockStorageKey(),
        };
      }, { sellerA: AVI_SELLER, sellerB: 'seller-mira' });

      expect(rows.keyA).not.toBe(rows.keyB);
      expect(rows.keyA).not.toBe(rows.sharedRow);
      expect(rows.keyB).not.toBe(rows.sharedRow);
      expect(rows.bReadsOwnRow).toBeNull();
      expect(rows.aRowIntact).toBe(JSON.stringify({ board: 'avi-layout' }));

      await page.context().close();
    }, 120_000);
  });
});

describe.runIf(!ARMED)('demo identity boundary — real browser (not armed)', () => {
  it('is opt-in behind SIDESTAGE_BROWSER_INTEGRATION=1', () => {
    // Present so an unarmed run REPORTS the browser layer as skipped rather
    // than as absent — the same reason differential.integration.test.ts keeps
    // its own unarmed counterpart.
    expect(ARMED).toBe(false);
  });
});
