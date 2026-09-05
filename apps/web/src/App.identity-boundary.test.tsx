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
 * WHAT THIS FILE DELIBERATELY DOES *NOT* ASSERT, and why it matters to the next
 * reader: the public shell's DOM nodes are NOT preserved across an identity
 * change, so do not add an assertion demanding they are — it will fail, and the
 * failure would be the test's fault rather than the app's. `BuyerCheckoutProvider`
 * wraps the whole shell in App.tsx and is itself `key={buyerId}`
 * (BuyerCheckout.tsx), a deliberate reset covered by BuyerCheckout.identity.test.tsx,
 * so an identity change tears the shell's nodes down too.
 *
 * That is not a clause-6 violation, because clause 6 is a guarantee about
 * public browsing STATE, not about DOM nodes, and that state lives in `App`
 * ABOVE the checkout provider (`tab`, `pinnedEventId`, `selectedProductId`) —
 * so it survives. `ChannelGuide` holds only a ticking clock, nothing a user
 * would notice losing. `preserves public browsing state` below asserts the
 * guarantee at that level, which is the level the plan item actually promises.
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

function navLink(label: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll<HTMLAnchorElement>('a.nav-link')]
    .find((link) => link.textContent?.trim() === label);
}

describe('demo identity is an atomic browser boundary', () => {
  it('drops the per-user subtree on an identity change', async () => {
    await mountApp();
    await switchDemoIdentity('demo-buyer-one');

    const perUserBefore = perUserNode();
    expect(perUserBefore).not.toBeNull();

    await switchDemoIdentity('demo-buyer-two');

    const perUserAfter = perUserNode();
    expect(perUserAfter).not.toBeNull();
    // REPLACED, not re-rendered: every piece of per-user state the old subtree
    // held went with its nodes. This is the clause the key implements.
    expect(perUserAfter).not.toBe(perUserBefore);
  });

  it('does not remount the per-user subtree when the identity is rewritten unchanged', async () => {
    await mountApp();
    await switchDemoIdentity('demo-buyer-one');
    const perUserBefore = perUserNode();
    expect(perUserBefore).not.toBeNull();

    await switchDemoIdentity('demo-buyer-one');

    // Same identity => same key => no teardown. Without this control, any
    // incidental re-render would look like a boundary crossing and the test
    // above would pass for the wrong reason.
    expect(perUserNode()).toBe(perUserBefore);
  });

  it('preserves public browsing state across an identity change', async () => {
    await mountApp();
    await switchDemoIdentity('demo-buyer-one');

    const orders = navLink('Orders');
    expect(orders).toBeDefined();
    await act(async () => { orders?.click(); });
    expect(navLink('Orders')?.getAttribute('aria-current')).toBe('page');

    await switchDemoIdentity('demo-buyer-two');

    // `tab` lives in App, ABOVE the identity boundary and above the checkout
    // provider, so a new demo user lands on the same page rather than being
    // bounced back to the default surface. Move this state below either key and
    // this assertion fails.
    expect(navLink('Orders')?.getAttribute('aria-current')).toBe('page');
  });
});
