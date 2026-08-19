/** @vitest-environment jsdom */

/**
 * The Studio must stand down when the URL names an event the seller's own
 * directory does not contain (WI-39864).
 *
 * The reported defect: a deep link
 * (`?tab=seller&studio=active-event&event=avi-real-test`) named an event the
 * owner really created — under a seller identity their browser no longer
 * resolves to. `EventOwnershipGuard` answers 404 for missing and foreign ids
 * alike (anti-enumeration), so every board fetched, every fetch 404ed, and the
 * seller's own screen filled with raw "Chat request failed (404)" toasts with
 * no hint that the topbar identity control was the fix.
 *
 * These tests mount the REAL SellerTab and assert the three halves of the fix:
 *
 *   - the boards do not mount and nothing fetches the stranded id (the
 *     stage-items poll is disabled, not merely ignored), and
 *   - one notice renders instead, naming the id and the identity recovery, and
 *   - its action drops the pin, so the Studio comes back up on the seller's
 *     own directory — proving the notice is a gate, not a dead end.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  queries: [] as Array<{ queryName: string; args: Record<string, unknown>; enabled: boolean }>,
  dockMounts: 0,
}));

// Spread the real module and override only what this file controls — a
// full-replacement factory strands on the next new export (WI-39855).
vi.mock('@papercusp/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sync')>()),
  DEMO_PRINCIPAL_HEADER: 'x-demo-principal',
  SyncProvider: ({ children }: { children?: unknown }) => children,
  useSyncPrincipal: () => 'demo-seller',
  // `enabled` is captured because the hook is CALLED either way (hooks always
  // run); what the fix changes is whether the call may fetch.
  useSyncQuery: (options: { queryName: string; args?: Record<string, unknown>; enabled?: boolean }) => {
    captured.queries.push({
      queryName: options.queryName,
      args: options.args ?? {},
      enabled: options.enabled !== false,
    });
    return { data: [], loading: false, error: null };
  },
  // The seller's directory is LOADED and does not contain the URL's event —
  // the stranded state under test. events.guide shares the hook and stays
  // empty, which is fine: the notice must not depend on the buyer guide.
  useRestSyncQuery: (options: { queryName: string; args?: Record<string, unknown>; enabled?: boolean }) => {
    captured.queries.push({
      queryName: options.queryName,
      args: options.args ?? {},
      enabled: options.enabled !== false,
    });
    return { data: [], loading: false, error: null };
  },
  useSyncMutate: (_name: string, fallback?: (input: unknown) => Promise<unknown>) => (
    (input: unknown) => (fallback ? fallback(input) : Promise.resolve(undefined))
  ),
}));

/** The chat transport is not under test, and loading it would open sockets. */
vi.mock('./EventChat', () => ({
  EventChat: () => null,
  resolveApiOrigin: (base?: string) => base ?? 'http://localhost:8787',
}));

/** Whether the dock mounted at all IS the assertion, so the stub only counts. */
vi.mock('./SellerDock', () => ({
  SellerDock: () => {
    captured.dockMounts += 1;
    return null;
  },
}));

import { SellerTab } from './SellerTab';

type ActEnv = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderStudio(): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const created = createRoot(host);
  act(() => {
    created.render(createElement(SellerTab, {
      selectedProduct: null,
      selectedProductId: null,
      sellerProducts: [],
      transcriptProducts: [],
      onActiveProductChange: () => undefined,
    }));
  });
  root = created;
  container = host;
  return host;
}

function strandedIdQueries() {
  return captured.queries.filter((query) => query.args.eventId === 'avi-real-test');
}

beforeEach(() => {
  (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT = true;
  captured.queries.length = 0;
  captured.dockMounts = 0;
  window.history.replaceState(null, '', '/?tab=seller&studio=active-event&event=avi-real-test');
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  delete (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT;
});

describe('Studio stranded deep-link (WI-39864)', () => {
  it('renders the identity notice instead of the boards, and lets nothing fetch the stranded id', () => {
    const host = renderStudio();

    const notice = host.querySelector('[role="alert"].studio-stranded-pin');
    expect(notice, 'the stranded-pin notice did not render').not.toBeNull();
    expect(notice?.textContent).toContain('avi-real-test');
    expect(notice?.textContent).toContain('identity control in the top bar');

    expect(captured.dockMounts, 'the dock mounted over the notice').toBe(0);

    // The SellerTab-level stage-items poll targets the stranded id but must be
    // DISABLED — enabled:true here is the 10s 404 loop the fix removes.
    const strandedFetches = strandedIdQueries().filter((query) => query.enabled);
    expect(strandedFetches, 'a board fetched the stranded id').toEqual([]);
  });

  it('recovers through the action: the pin drops and the Studio comes back up', () => {
    const host = renderStudio();
    const action = host.querySelector<HTMLButtonElement>('.studio-stranded-pin button');
    expect(action, 'the notice rendered no recovery action').not.toBeNull();

    captured.queries.length = 0;
    act(() => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(host.querySelector('.studio-stranded-pin'), 'the notice outlived its action').toBeNull();
    expect(captured.dockMounts, 'the dock did not mount after recovery').toBeGreaterThan(0);

    // The boards resolve from the directory again (empty here, so the seed),
    // never the stranded id — and their queries are enabled again.
    expect(strandedIdQueries()).toEqual([]);
    const stageItems = captured.queries.filter((query) => query.queryName === 'event.actions.items');
    expect(stageItems.length).toBeGreaterThan(0);
    expect(stageItems.every((query) => query.enabled)).toBe(true);
  });
});
