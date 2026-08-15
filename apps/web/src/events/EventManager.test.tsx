/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext } from '@papercusp/sync';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventManager, type SellerOwnedEvent } from './EventManager';
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

const EVENTS: SellerOwnedEvent[] = [{
  eventId: 'sunday-drop',
  title: 'Sunday drop',
  sellerId: 'demo-seller',
  sellerName: 'SideStage Seller',
  status: 'live',
  startsAt: '2026-08-14T15:00:00.000Z',
  endedAt: null,
}];

describe('EventManager', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=events');
  });

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
        : options.queryName === 'event.actions.items' ? ITEMS
          : options.queryName === 'events.mine' ? EVENTS : [],
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
    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'events.mine',
      args: { sellerId: 'seller-27' },
    }));
    expect(markup).toContain('Live renamed drop');
    expect(markup).toContain('My events');
    expect(markup).toContain('Barista Pro Espresso Machine');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('renders the real guarded lineup through RichGrid', () => {
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="sunday-drop"
        eventName="Sunday drop"
        initialItems={ITEMS}
        initialEvents={EVENTS}
      />,
    );

    expect(markup).toContain('Sunday drop');
    expect(markup).toContain('data-rg-screen-grid="true"');
    expect(markup).toContain('Push');
    expect(markup).toContain('Swap');
    expect(markup).toContain('Markdown');
    expect(markup).toContain('Stock');
    expect(markup).toContain('Auction quantity for Barista Pro Espresso Machine');
    expect(markup).not.toContain('Unlock auction writes');
    expect(markup).not.toContain('Seller credential');
    expect(markup).toContain('Start auction');
    expect(markup).toContain('Offer quantity for Barista Pro Espresso Machine');
    expect(markup).toContain('Barista Pro Espresso Machine');
    expect(markup).toContain('Event lineup');
    expect(markup).toContain('Add inventory');
    expect(markup).toContain('Lineup');
    expect(markup).toContain('Settings');
    expect(markup).toContain('Rehearse');
    expect(markup.indexOf('>Lineup</a>')).toBeLessThan(markup.indexOf('>Settings</a>'));
    expect(markup.indexOf('>Settings</a>')).toBeLessThan(markup.indexOf('>Rehearse</a>'));
    expect(markup).not.toContain('Event settings &amp; readiness');
  });

  it('renders an empty selected event with an inventory call to action', () => {
    const newEvent: SellerOwnedEvent = {
      ...EVENTS[0],
      eventId: 'new-event',
      title: 'New event',
      status: 'draft',
    };
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="new-event"
        eventName="New event"
        initialItems={[]}
        initialEvents={[newEvent]}
      />,
    );

    expect(markup).toContain('This event has no reserved inventory yet.');
    expect(markup).toContain('Add inventory');
    expect(markup).toContain('Create event');
    expect(markup).not.toContain('Event settings &amp; readiness');
  });

  it('does not query or render a phantom fallback event when the seller owns no events', () => {
    const useDataImpl = vi.fn((options: { queryName: string }) => ({
      data: options.queryName === 'events.mine' ? [] : undefined,
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: null,
    }));

    const markup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <EventManager actorId="seller-27" eventId="sunday-drop" eventName="Sunday vintage drop" />
      </SyncContext.Provider>,
    );

    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.config',
      enabled: false,
    }));
    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.actions.items',
      enabled: false,
    }));
    expect(useDataImpl).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'event.auction.active',
      enabled: false,
    }));
    expect(markup).toContain('No seller events yet.');
    expect(markup).toContain('Create your first seller event.');
    expect(markup).not.toContain('Event ID sunday-drop');
    expect(markup).not.toContain('Event not found for this seller.');
  });

  it('does not combine a missing routed id with another owned event\'s metadata', () => {
    window.history.replaceState(
      {},
      '',
      '/?tab=seller&studio=event-manager&manager=events&event=missing-event',
    );

    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="sunday-drop"
        eventName="Sunday drop"
        initialItems={[]}
        initialEvents={EVENTS}
      />,
    );

    expect(markup).toContain('This event is not available for this seller.');
    expect(markup).toContain('Choose another event from My events, or create a new event.');
    expect(markup).not.toContain('Event ID missing-event');
    expect(markup).not.toContain('This event has no reserved inventory yet.');
  });

  it('nests settings under the selected event instead of the manager workspace switch', () => {
    window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=events&event=sunday-drop&section=settings');
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="sunday-drop"
        eventName="Sunday drop"
        initialItems={ITEMS}
        initialEvents={EVENTS}
      />,
    );

    expect(markup).toContain('Event settings &amp; readiness');
    expect(markup).toContain('Loading event settings…');
    expect(markup).not.toContain('data-rg-screen-grid="true"');
  });

  it('embeds the existing Run-of-show planner in the selected event Rehearse tab', () => {
    window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=events&event=sunday-drop&section=rehearse');
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="sunday-drop"
        eventName="Sunday drop"
        initialItems={ITEMS}
        initialEvents={EVENTS}
      />,
    );

    expect(markup).toContain('Plan the show');
    expect(markup).toContain('Order the lineup, budget minutes per product');
    expect(markup).toContain('Save show plan');
    expect(markup).not.toContain('data-rg-screen-grid="true"');
    expect(markup).not.toContain('Event settings &amp; readiness');
  });

  it('renders the existing reservation-backed creation flow in Create event', () => {
    window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=create');
    const markup = renderToStaticMarkup(
      <EventManager
        actorId="seller-27"
        eventId="new-event"
        eventName="New event"
        initialItems={[]}
        initialEvents={[]}
      />,
    );

    expect(markup).toContain('Build the live lineup');
    expect(markup).toContain('reserve real catalog inventory');
    expect(markup).toContain('Create event');
  });
});
