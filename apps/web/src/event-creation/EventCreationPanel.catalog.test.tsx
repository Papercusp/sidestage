import { readFileSync } from 'node:fs';

import { SyncContext } from '@papercusp/sync';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventCreationPanel } from './EventCreationPanel';

/**
 * catalog.page / inventory.page are REST-pinned via useRestSyncQuery since
 * WI-39855 — the Zero registry deliberately has no leaf for them, so the page
 * read no longer flows through SyncContext.useDataImpl. That hook is the seam
 * these tests observe: mock it, record calls, keep every other export
 * (SyncContext included) original.
 */
const restSync = vi.hoisted(() => ({
  impl: undefined as ((opts: { queryName: string }) => Record<string, unknown>) | undefined,
  calls: [] as { queryName: string }[],
}));
vi.mock('@papercusp/sync', async (importOriginal) => {
  const original = await importOriginal<typeof import('@papercusp/sync')>();
  return {
    ...original,
    useRestSyncQuery: (opts: { queryName: string }) => {
      restSync.calls.push(opts);
      return {
        data: [],
        loading: false,
        fetching: false,
        transport: 'SSE',
        invalidate: vi.fn(),
        error: null,
        ...(restSync.impl?.(opts) ?? {}),
      };
    },
  };
});

const eventCreationCss = readFileSync(new URL('./event-creation.css', import.meta.url), 'utf8');

describe('EventCreationPanel catalog source loss', () => {
  beforeEach(() => {
    restSync.impl = undefined;
    restSync.calls.length = 0;
  });

  it('builds event lineups from seller-owned inventory instead of the public catalog', () => {
    const useDataImpl = vi.fn(() => ({
      data: [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: null,
    }));

    renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <EventCreationPanel allowDemoData={false} />
      </SyncContext.Provider>,
    );

    expect(restSync.calls).toContainEqual(expect.objectContaining({
      queryName: 'inventory.page',
    }));
    expect(restSync.calls).not.toContainEqual(expect.objectContaining({
      queryName: 'catalog.page',
    }));
    // The page read must NOT reach the transport-following path at all — that
    // is the WI-39855 regression this file guards against.
    expect(useDataImpl).not.toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'inventory.page',
    }));
  });

  it('uses the public catalog only when the inventory onboarding mode requests it', () => {
    const useDataImpl = vi.fn(() => ({
      data: [], loading: false, fetching: false, transport: 'SSE', invalidate: vi.fn(), error: null,
    }));

    renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <EventCreationPanel purpose="inventory" inventoryMode="onboard" catalogScope="public" allowDemoData={false} />
      </SyncContext.Provider>,
    );

    expect(restSync.calls).toContainEqual(expect.objectContaining({ queryName: 'catalog.page' }));
    expect(restSync.calls).not.toContainEqual(expect.objectContaining({ queryName: 'inventory.page' }));
  });

  it('renders an honest production alert and no demo inventory', () => {
    // The page read is REST-pinned, so the source-down error surfaces through
    // useRestSyncQuery; other (synced) reads keep erroring via useDataImpl.
    restSync.impl = () => ({ error: new Error('catalog unavailable') });
    const useDataImpl = vi.fn(() => ({
      data: [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: new Error('catalog unavailable'),
    }));

    const html = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <EventCreationPanel allowDemoData={false} />
      </SyncContext.Provider>,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Catalog unavailable. No inventory is shown');
    expect(html).toContain('0 of 0 catalog items');
    expect(html).toContain('class="event-creation-toolbar"');
    expect(html.indexOf('class="event-creation-toolbar"')).toBeLessThan(
      html.indexOf('class="event-catalog-grid'),
    );
    expect(html.match(/Create event/g)).toHaveLength(1);
    expect(html).not.toContain('demo-espresso-matte-black');
    expect(html).not.toContain('offline fixture');
  });

  it('contains the sticky toolbar inside a phone-width seller dock', () => {
    const mobileCss = eventCreationCss.match(/@media \(max-width: 560px\) \{([\s\S]*)\}\s*$/)?.[1] ?? '';

    expect(mobileCss).toMatch(
      /\.event-creation\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*min-width:\s*0;[^}]*width:\s*100%;/s,
    );
    expect(mobileCss).toMatch(
      /\.event-creation-toolbar\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-width:\s*0;[^}]*width:\s*100%;/s,
    );
    expect(mobileCss).toMatch(
      /\.event-creation-toolbar-action\s*\{[^}]*align-items:\s*stretch;[^}]*flex-direction:\s*column;/s,
    );
    expect(mobileCss).toMatch(
      /\.event-creation-toolbar \.button\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;/s,
    );
  });
});
