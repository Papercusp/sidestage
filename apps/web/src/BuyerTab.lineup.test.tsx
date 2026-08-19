/** @vitest-environment jsdom */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BuyerTab,
  buyerProductsFromLineupRows,
  type BuyerLineupItem,
} from './BuyerTab';

const queryState = vi.hoisted(() => ({
  rows: [] as unknown[],
  loading: false,
  fetching: false,
  error: null as Error | null,
  invalidate: vi.fn(),
  useSyncQuery: vi.fn(),
}));

const checkoutState = vi.hoisted(() => ({
  heldProductIds: [] as string[],
  holdProduct: vi.fn(async () => ({ id: 'cart-1' })),
  openHeldItems: vi.fn(),
}));

vi.mock('@papercusp/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/sync')>();
  queryState.useSyncQuery.mockImplementation((options: { queryName: string }) => ({
    data: options.queryName === 'event.lineup.items' ? queryState.rows : [],
    loading: options.queryName === 'event.lineup.items' && queryState.loading,
    fetching: options.queryName === 'event.lineup.items' && queryState.fetching,
    error: options.queryName === 'event.lineup.items' ? queryState.error : null,
    transport: 'WEBSOCKETS',
    invalidate: queryState.invalidate,
  }));
  return {
    ...actual,
    useSyncPrincipal: () => 'lineup-test-buyer',
    useSyncQuery: queryState.useSyncQuery,
    useRestSyncQuery: vi.fn(() => ({
      data: [],
      loading: false,
      fetching: false,
      error: null,
      transport: 'POLLING',
      invalidate: vi.fn(),
    })),
    useSyncMutate: (_name: string, fallback: (input: unknown) => Promise<unknown>) => fallback,
  };
});

vi.mock('./BuyerCheckout', () => ({
  useBuyerCheckout: () => ({
    heldProductIds: checkoutState.heldProductIds,
    heldItemCount: checkoutState.heldProductIds.length,
    holdProduct: checkoutState.holdProduct,
    openHeldItems: checkoutState.openHeldItems,
    openOrder: vi.fn(),
    adoptCartId: vi.fn(),
  }),
}));

vi.mock('./AuctionPanel', () => ({
  AuctionPanel: ({ idleContent }: { idleContent?: ReactNode }) => idleContent ?? null,
}));

vi.mock('./streaming', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./streaming')>();
  return {
    ...actual,
    connectViewer: vi.fn(async () => { throw new Error('no stream in this test'); }),
  };
});

function item(
  eventId: string,
  productId: string,
  position: number,
  stageState: BuyerLineupItem['stageState'] = 'queued',
  currentQuantity = 3,
): BuyerLineupItem {
  return {
    eventId,
    eventItemId: `${eventId}-${productId}`,
    productId,
    title: `${productId} title`,
    description: `${productId} description`,
    referencePriceCents: 2_500 + position * 100,
    currentPriceCents: 2_000 + position * 100,
    listedQuantity: 5,
    currentQuantity,
    position,
    stageState,
    attributes: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function renderBuyer(root: Root, eventId: string): void {
  root.render(
    <BuyerTab
      eventId={eventId}
      eventTitle={`${eventId} event`}
      stats={{ viewers: 0, itemsSold: 0, totalRaisedCents: 0 }}
      guideEvents={[]}
    />,
  );
}

describe('BuyerTab event lineup', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    queryState.rows = [];
    queryState.loading = false;
    queryState.fetching = false;
    queryState.error = null;
    queryState.invalidate.mockClear();
    queryState.useSyncQuery.mockClear();
    checkoutState.heldProductIds = [];
    checkoutState.holdProduct.mockReset();
    checkoutState.holdProduct.mockImplementation(async (product: { id: string }) => {
      checkoutState.heldProductIds = [product.id];
      return { id: 'cart-1' };
    });
    checkoutState.openHeldItems.mockClear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('adapts only the selected event rows in seller-authored order with event hold context', () => {
    const rows = [
      item('other-event', 'stale', 1),
      item('live-event', 'second', 2),
      item('live-event', 'first', 1, 'on-stage'),
    ];

    expect(buyerProductsFromLineupRows(rows, 'live-event')).toEqual([
      expect.objectContaining({
        id: 'first',
        eventId: 'live-event',
        eventItemId: 'live-event-first',
        title: 'first title',
        subtitle: 'first description',
        priceCents: 2_100,
        compareAtPriceCents: 2_600,
        availableQty: 3,
        badge: 'Live now',
      }),
      expect.objectContaining({ id: 'second', eventId: 'live-event', eventItemId: 'live-event-second' }),
    ]);
  });

  it('reads event.lineup.items and follows the seller on-stage switch', async () => {
    queryState.rows = [item('live-event', 'first', 1), item('live-event', 'second', 2, 'on-stage')];
    await act(async () => renderBuyer(root!, 'live-event'));

    expect(queryState.useSyncQuery).toHaveBeenCalledWith({
      queryName: 'event.lineup.items',
      args: { eventId: 'live-event' },
      enabled: true,
      pollIntervalMs: 10_000,
      staleTime: 0,
    });
    expect(container.querySelector('.buyer-mobile-action')?.textContent).toContain('second title');
    expect(container.querySelector('.buyer-mobile-action')?.textContent).not.toContain('first title');

    queryState.rows = [item('live-event', 'first', 1, 'on-stage'), item('live-event', 'second', 2, 'completed')];
    await act(async () => renderBuyer(root!, 'live-event'));

    expect(container.querySelector('.buyer-mobile-action')?.textContent).toContain('first title');
    expect(container.querySelector('.buyer-mobile-action')?.textContent).not.toContain('second title');
  });

  it('suppresses previous-event placeholder rows while the next lineup loads', async () => {
    queryState.rows = [item('old-event', 'old-product', 1, 'on-stage')];
    queryState.fetching = true;
    await act(async () => renderBuyer(root!, 'new-event'));

    expect(container.textContent).toContain('Loading this event’s lineup…');
    expect(container.textContent).not.toContain('old-product title');
    expect(container.querySelector('.buyer-mobile-action')).toBeNull();
  });

  it('distinguishes unpublished, transport-error, and published-empty states', async () => {
    queryState.error = new Error('Unknown event: draft-event');
    await act(async () => renderBuyer(root!, 'draft-event'));
    expect(container.textContent).toContain('This event is not published or is no longer available.');

    queryState.error = new Error('connection reset');
    await act(async () => renderBuyer(root!, 'draft-event'));
    expect(container.textContent).toContain('The event lineup could not be loaded.');
    expect(container.textContent).not.toContain('This event is not published or is no longer available.');

    queryState.error = null;
    queryState.rows = [];
    await act(async () => renderBuyer(root!, 'draft-event'));
    expect(container.textContent).toContain('This published event does not have any lineup items yet.');
    expect(container.textContent).not.toContain('The event lineup could not be loaded.');
  });

  it('holds the event item and synchronously clears product-local state when the event changes', async () => {
    queryState.rows = Array.from({ length: 5 }, (_, index) => (
      item('event-a', `product-${index + 1}`, index + 1, index === 0 ? 'on-stage' : 'queued')
    ));
    await act(async () => renderBuyer(root!, 'event-a'));

    const holdButton = container.querySelector<HTMLButtonElement>('.buyer-current-offer-action');
    expect(holdButton).not.toBeNull();
    await act(async () => holdButton?.click());
    expect(checkoutState.holdProduct).toHaveBeenCalledWith(expect.objectContaining({
      id: 'product-1',
      eventId: 'event-a',
      eventItemId: 'event-a-product-1',
      priceCents: 2_100,
    }));
    expect(container.textContent).toContain('product-1 title is held for you.');

    const toggle = container.querySelector<HTMLButtonElement>('.buyer-products-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    checkoutState.heldProductIds = [];
    queryState.rows = [item('event-b', 'fresh-product', 1, 'on-stage', 4)];
    await act(async () => renderBuyer(root!, 'event-b'));

    expect(container.textContent).not.toContain('product-1 title is held for you.');
    expect(container.textContent).not.toContain('product-1 title');
    expect(container.querySelector('.buyer-mobile-action')?.textContent).toContain('fresh-product title');
    expect(container.querySelector('.buyer-mobile-action')?.textContent).toContain('4 left');
    expect(container.querySelector('.buyer-products-toggle')).toBeNull();
  });
});
