/** @vitest-environment jsdom */

/**
 * P-007: a demo-identity change is an ATOMIC BROWSER BOUNDARY.
 *
 * The mechanism is the `key={userId}` on the per-user <Suspense> in App.tsx,
 * plus the effect beside it for the two things a remount cannot reach
 * (`selectedProductId`, and the module-level + HttpOnly-cookie guest session).
 *
 * The remount assertions below go through DOM NODE IDENTITY, because that is
 * exactly what separates a remount from a re-render: React discards the nodes
 * below a changed key and reuses the ones above it. They are not tautologies
 * about React — each is about which SIDE of our boundary a surface sits on,
 * which is a decision in our tree and the thing that regresses. Delete
 * `key={userId}` and `drops the per-user subtree` fails.
 *
 * WHICH IDENTITY PAIR THESE TESTS SWITCH BETWEEN IS LOAD-BEARING — do not
 * "simplify" it to two arbitrary buyer ids, or the suite silently stops testing
 * P-007 at all. `BuyerCheckoutProvider` wraps the whole shell in App.tsx and is
 * itself `key={buyerId}` (BuyerCheckout.tsx), a separate deliberate reset
 * covered by BuyerCheckout.identity.test.tsx. Between two ordinary buyer
 * personas BOTH keys change, so the subtree remounts even with App's key
 * deleted — verified by mutation, the naive version of this suite passed 3/3
 * against a build with `key={userId}` removed.
 *
 * `buyer-avi` -> `seller-avi` is the pair that isolates App's key:
 * `normalizeRoleDemoIdentity` re-prefixes the persona, so the buyer id stays
 * `buyer-avi` (checkout provider does NOT remount) while App's unroled `userId`
 * goes `buyer-avi` -> `seller-avi` (App's key DOES). That is why these tests can
 * assert the per-user subtree is dropped AND the public shell is preserved in
 * the same breath — the second half is only true because the checkout provider
 * held still, which is exactly clause 6's guarantee about public surfaces.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { writeDemoIdentity } from './buyer-identity';

let container: HTMLDivElement;
let root: Root | null;

/**
 * The buyer surface fetches on mount. This suite is about tree structure, not
 * data, so every request resolves to an empty-but-valid JSON body: the surfaces
 * render their empty states instead of leaving rejected promises in the run.
 */
function stubNetwork(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
}

/**
 * This runner injects a PARTIAL localStorage (no getItem/clear), which the app's
 * storage helpers legitimately assume is a real Storage. Install a working
 * in-memory one so the test exercises our boundary rather than the runner's
 * environment quirk.
 */
function installMemoryStorage(): void {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, String(value)); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => { entries.clear(); },
  };
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  stubNetwork();
  installMemoryStorage();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function mountApp(): Promise<void> {
  await act(async () => {
    root?.render(<App />);
  });
}

/**
 * Switch identity through the app's own seam rather than by seeding storage:
 * this is what the demo user switcher calls, so the test drives the same path a
 * real identity change takes.
 */
async function switchDemoIdentity(next: string): Promise<void> {
  await act(async () => {
    writeDemoIdentity(next);
  });
}

/** The per-user subtree: BuyerTab's root, rendered BELOW the keyed boundary. */
function perUserNode(): Element | null {
  return container.querySelector('#buyer');
}

/** The public shell: the <main> hosting the boundary, rendered ABOVE it. */
function publicShellNode(): Element | null {
  return container.querySelector('#main-content');
}

function navLink(label: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll<HTMLAnchorElement>('a.nav-link')]
    .find((link) => link.textContent?.trim() === label);
}

describe('demo identity is an atomic browser boundary', () => {
  it('drops the per-user subtree while the public shell stays mounted', async () => {
    await mountApp();
    await switchDemoIdentity('buyer-avi');

    const perUserBefore = perUserNode();
    const publicBefore = publicShellNode();
    expect(perUserBefore).not.toBeNull();
    expect(publicBefore).not.toBeNull();

    await switchDemoIdentity('seller-avi');

    const perUserAfter = perUserNode();
    expect(perUserAfter).not.toBeNull();

    // REPLACED, not re-rendered: every piece of per-user state the old subtree
    // held went with its nodes. Delete `key={userId}` and this is the SAME node.
    expect(perUserAfter).not.toBe(perUserBefore);

    // ...while the shell above the boundary was REUSED. The boundary is scoped
    // to per-user surfaces rather than reloading the page under the user.
    expect(publicShellNode()).toBe(publicBefore);
  });

  it('drops the per-user subtree between two ordinary demo personas', async () => {
    await mountApp();
    await switchDemoIdentity('buyer-avi');
    const perUserBefore = perUserNode();
    expect(perUserBefore).not.toBeNull();

    await switchDemoIdentity('buyer-sam');

    // The common path. Both the App key and the checkout provider's key change
    // here, so this does not isolate App's key — it guards the everyday switch
    // the demo actually performs.
    expect(perUserNode()).not.toBe(perUserBefore);
  });

  it('does not remount the per-user subtree when the identity is rewritten unchanged', async () => {
    await mountApp();
    await switchDemoIdentity('buyer-avi');
    const perUserBefore = perUserNode();
    expect(perUserBefore).not.toBeNull();

    await switchDemoIdentity('buyer-avi');

    // Same identity => same key => no teardown. Without this control, any
    // incidental re-render would look like a boundary crossing and the tests
    // above would pass for the wrong reason.
    expect(perUserNode()).toBe(perUserBefore);
  });

  it('preserves public browsing state across an identity change', async () => {
    await mountApp();
    await switchDemoIdentity('buyer-avi');

    const orders = navLink('Orders');
    expect(orders).toBeDefined();
    await act(async () => { orders?.click(); });
    expect(navLink('Orders')?.getAttribute('aria-current')).toBe('page');

    await switchDemoIdentity('seller-avi');

    // `tab` lives in App, ABOVE the boundary, so the new identity lands on the
    // same page rather than being bounced back to the default surface. Move
    // this state below the key and this assertion fails.
    expect(navLink('Orders')?.getAttribute('aria-current')).toBe('page');
  });
});
