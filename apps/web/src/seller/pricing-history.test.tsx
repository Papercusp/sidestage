import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext, useRestSyncQuery } from '@papercusp/sync';
import { describe, expect, it, vi } from 'vitest';

// `event.pricingHistory` is an UNSYNCED query name — the Zero registry
// deliberately has no leaf for it — so this panel reads it through
// `useRestSyncQuery`, the REST/batch path on EVERY transport (WI-39772). That
// hook resolves its own client and never consults the SyncContext's
// `useDataImpl`, so stub the hook itself. Spread the real module so
// `SyncContext` stays real and a new export never silently vanishes from a
// hand-listed factory.
vi.mock('@papercusp/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sync')>()),
  useRestSyncQuery: vi.fn(),
}));

import { PricingHistoryContent, PricingHistoryPanel, type PricingHistory } from './PricingHistoryPanel';

describe('seller pricing history', () => {
  it('binds the active event and product to the named live query without a direct fetch', () => {
    const history: PricingHistory = { productId: 'mug', prices: [], offers: [], auctions: [] };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const restQuery = vi.mocked(useRestSyncQuery);
    restQuery.mockReturnValue({
      data: [history],
      loading: false,
      fetching: false,
      transport: 'POLLING',
      invalidate: vi.fn(),
      error: null,
    } as never);

    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', prefetch: vi.fn() } as never}>
        <PricingHistoryPanel eventId="Sunday drop" productId="mug/red" />
      </SyncContext.Provider>,
    );

    expect(restQuery).toHaveBeenCalledWith({
      queryName: 'event.pricingHistory',
      args: { eventId: 'Sunday drop', productId: 'mug/red' },
      pollIntervalMs: 15_000,
    });
    expect(markup).toContain('No sales, offers, or auctions for this product yet.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps retry scoped to a real query error', () => {
    vi.mocked(useRestSyncQuery).mockReturnValue({
      data: [],
      loading: false,
      fetching: false,
      transport: 'POLLING',
      invalidate: vi.fn(),
      error: new Error('sync unavailable'),
    } as never);

    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', prefetch: vi.fn() } as never}>
        <PricingHistoryPanel eventId="event-1" productId="mug" />
      </SyncContext.Provider>,
    );
    expect(markup).toContain('Pricing history could not be loaded.');
    expect(markup).toContain('Try again');
  });

  it('renders price, per-buyer offer, and auction outcomes', () => {
    const history: PricingHistory = {
      productId: 'mug',
      prices: [{ priceCents: 2400, soldQty: 5, rejectedQty: 2 }],
      offers: [{ id: 'offer-1', buyerId: 'buyer-a', priceCents: 2200, quantity: 2, outcome: 'accepted' }],
      auctions: [{ id: 'auction-1', priceCents: 2600, quantity: 3, bidderId: 'buyer-b', outcome: 'sold' }],
    };
    const markup = renderToStaticMarkup(<PricingHistoryContent history={history} />);
    expect(markup).toContain('$24.00');
    expect(markup).toContain('5 sold');
    expect(markup).toContain('2 rejected');
    expect(markup).toContain('buyer-a');
    expect(markup).toContain('history-accepted');
    expect(markup).toContain('3 × $26.00');
    expect(markup).toContain('buyer-b');
  });

  it('states honestly when the product has no history', () => {
    const markup = renderToStaticMarkup(<PricingHistoryContent history={{ productId: 'mug', prices: [], offers: [], auctions: [] }} />);
    expect(markup).toContain('No sales, offers, or auctions for this product yet.');
  });
});
