import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext } from '@papercusp/sync';
import { describe, expect, it, vi } from 'vitest';
import { EventManager } from './EventManager';
import type { SellerEventItem } from './api';

const ITEMS: SellerEventItem[] = [{
  eventId: 'sunday-drop',
  eventItemId: 'sunday-drop:espresso',
  productId: 'espresso',
  title: 'Barista Pro Espresso Machine',
  priceCents: 47_500,
  availableQty: 12,
  quantity: 3,
  onStage: true,
  attributes: { brand: 'BrewHaus', sku: 'BH-ESP-200-NEW', basePriceCents: 49_999 },
}];

describe('EventManager', () => {
  it('reads config and lineup through named sync queries without a component-owned fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const useDataImpl = vi.fn((options: { queryName: string }) => ({
      data: options.queryName === 'event.config'
        ? [{
            eventId: 'sunday-drop',
            name: 'Live renamed drop',
            replyTone: 'warm',
            guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
            updatedAt: '2026-08-14T15:00:00.000Z',
          }]
        : options.queryName === 'event.actions.items' ? ITEMS : [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: null,
    }));

    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <EventManager actorId="seller-27" eventId="sunday-drop" eventName="Stale title" />
      </SyncContext.Provider>,
    );

    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.config',
      args: { eventId: 'sunday-drop' },
    }));
    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.actions.items',
      args: { eventId: 'sunday-drop' },
    }));
    expect(markup).toContain('Live renamed drop');
    expect(markup).toContain('Barista Pro Espresso Machine');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('renders the real guarded lineup through RichGrid', () => {
    const markup = renderToStaticMarkup(
      <EventManager actorId="seller-27" eventId="sunday-drop" eventName="Sunday drop" initialItems={ITEMS} />,
    );

    expect(markup).toContain('Sunday drop');
    expect(markup).toContain('data-rg-screen-grid="true"');
    expect(markup).toContain('Push');
    expect(markup).toContain('Swap');
    expect(markup).toContain('Markdown');
    expect(markup).toContain('Stock');
    expect(markup).toContain('Auction quantity for Barista Pro Espresso Machine');
    expect(markup).toContain('start auctions');
    expect(markup).toContain('Start auction');
    expect(markup).toContain('Offer quantity for Barista Pro Espresso Machine');
    expect(markup).toContain('Barista Pro Espresso Machine');
    expect(markup).toContain('Event queue');
    expect(markup).toContain('Manage lineup');
    expect(markup).toContain('Event settings &amp; readiness');
    expect(markup).toContain('Loading event settings…');
  });

  it('renders the reservation-backed setup picker for an empty event', () => {
    const markup = renderToStaticMarkup(
      <EventManager actorId="seller-27" eventId="new-event" eventName="New event" initialItems={[]} />,
    );

    expect(markup).toContain('Build the live lineup.');
    expect(markup).toContain('Create event');
    expect(markup).toContain('reservation-backed quantity for every item');
    expect(markup).not.toContain('Event settings &amp; readiness');
  });
});
