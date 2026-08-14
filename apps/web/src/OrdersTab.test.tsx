import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext } from '@papercusp/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filterAndSortOrders,
  formatOrderMoney,
  OrderHistory,
  OrdersTab,
  OrdersWorkspace,
  orderStatusLabel,
  summarizeOrders,
  type BuyerOrder,
} from './OrdersTab';

const order: BuyerOrder = {
  id: 'order-1',
  source: 'auction',
  buyerId: 'buyer-1',
  eventId: 'event-1',
  eventTitle: 'Ceramics after dark',
  sellerName: 'Kiln & Coast',
  status: 'paid',
  createdAt: '2026-08-14T01:00:00.000Z',
  subtotalCents: 2500,
  shippingCents: 500,
  totalCents: 3000,
  currency: 'USD',
  items: [{ productId: 'cup', title: 'Aurora cup', quantity: 2, unitPriceCents: 1250 }],
  videoSnapshots: [{
    id: 'snapshot-1',
    eventId: 'event-1',
    eventTitle: 'Ceramics after dark',
    sellerName: 'Kiln & Coast',
    productId: 'cup',
    productTitle: 'Aurora cup',
    thumbnailUrl: '/event.png',
    startMs: 83_000,
    previewText: 'See the hand-painted detail up close.',
    evidenceKind: 'condition',
    evidenceLabel: 'Condition or flaw',
  }],
};

const failedOrder: BuyerOrder = {
  ...order,
  id: 'order-failed',
  source: 'checkout',
  eventId: 'event-2',
  eventTitle: 'Studio launch',
  sellerName: 'SideStage Supply',
  status: 'failed',
  createdAt: '2026-08-14T02:00:00.000Z',
  subtotalCents: 9900,
  shippingCents: 0,
  totalCents: 9900,
  items: [{ productId: 'weekender', title: 'Hand-finished weekender', quantity: 1, unitPriceCents: 9900 }],
  videoSnapshots: [],
};

const pendingOrder: BuyerOrder = {
  ...order,
  id: 'offer-pending',
  source: 'offer',
  eventId: 'event-3',
  eventTitle: 'Field notes live',
  status: 'pending',
  createdAt: '2026-08-14T03:00:00.000Z',
  subtotalCents: 4500,
  shippingCents: 0,
  totalCents: 4500,
  items: [{ productId: 'bag', title: 'Olive field bag', quantity: 1, unitPriceCents: 4500 }],
  videoSnapshots: [],
};

afterEach(() => vi.unstubAllGlobals());

describe('OrdersTab', () => {
  it('renders a scannable order summary, its real state, and an expandable purchase moment', () => {
    const html = renderToStaticMarkup(<OrderHistory orders={[order]} buyerId="buyer-1" />);

    expect(html).toContain('Auction win');
    expect(html).toContain('Aurora cup');
    expect(html).toContain('Ceramics after dark');
    expect(html).toContain('Kiln &amp; Coast');
    expect(html).toContain('Paid');
    expect(html).toContain('$30.00');
    expect(html).toContain('2 × $12.50');
    expect(html).toContain('Watch purchase moment');
    expect(html).toContain('Condition or flaw');
    expect(html).toContain('1:23');
    expect(html).toContain('href="/?tab=buyer&amp;event=event-1"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('order-snapshot-media');
  });

  it('shows live summary metrics and compact order controls', () => {
    const html = renderToStaticMarkup(
      <OrdersWorkspace orders={[order, failedOrder, pendingOrder]} buyerId="buyer-1" />,
    );

    expect(html).toContain('Order summary');
    expect(html).toContain('Paid total');
    expect(html).toContain('$30.00');
    expect(html).toContain('Completed payments only');
    expect(html).toContain('Search item, event, or order ID');
    expect(html).toContain('Needs action');
    expect(html).toContain('In progress');
    expect(html).toContain('Highest total');
  });

  it('filters on real purchase states and sorts without mutating the source list', () => {
    const source = [order, failedOrder, pendingOrder];

    expect(filterAndSortOrders(source, '', 'needs-action', 'newest').map((item) => item.id))
      .toEqual(['order-failed']);
    expect(filterAndSortOrders(source, 'ceramics', 'all', 'newest').map((item) => item.id))
      .toEqual(['order-1']);
    expect(filterAndSortOrders(source, '', 'all', 'highest-total').map((item) => item.id))
      .toEqual(['order-failed', 'offer-pending', 'order-1']);
    expect(source.map((item) => item.id)).toEqual(['order-1', 'order-failed', 'offer-pending']);
  });

  it('counts only completed payments as paid spend', () => {
    expect(summarizeOrders([order, failedOrder, pendingOrder])).toEqual({
      orderCount: 3,
      paidTotalCents: 3000,
      needsActionCount: 1,
      inProgressCount: 1,
      eventCount: 3,
    });
  });

  it('gives a zero-order buyer both a live-event route and buying guidance', () => {
    const html = renderToStaticMarkup(<OrderHistory orders={[]} buyerId="demo-alice" />);
    expect(html).toContain('No orders yet');
    expect(html).toContain('demo-alice');
    expect(html).toContain('Browse live events');
    expect(html).toContain('How buying works');
  });

  it('binds the selected buyer identity to the live orders query without a direct fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const useDataImpl = vi.fn().mockReturnValue({
      data: [order],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: null,
    });

    const html = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <OrdersTab />
      </SyncContext.Provider>,
    );

    expect(useDataImpl).toHaveBeenCalledWith({
      queryName: 'orders.byBuyer',
      args: { buyerId: 'demo-server-render' },
      staleTime: 0,
    });
    expect(html).toContain('Aurora cup');
    expect(html).toContain('Continue shopping');
    expect(html).not.toContain('Refresh orders');
    expect(html).not.toContain('Try again');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves explicit loading, empty, and query-error recovery states', () => {
    const renderState = (state: Record<string, unknown>) => renderToStaticMarkup(
      <SyncContext.Provider
        value={{
          transport: 'SSE',
          prefetch: vi.fn(),
          useDataImpl: vi.fn().mockReturnValue({
            data: [],
            loading: false,
            fetching: false,
            transport: 'SSE',
            invalidate: vi.fn(),
            error: null,
            ...state,
          }),
        } as never}
      >
        <OrdersTab />
      </SyncContext.Provider>,
    );

    expect(renderState({ loading: true })).toContain('Loading orders for demo-server-render…');
    expect(renderState({})).toContain('No orders yet');
    const errorHtml = renderState({ error: new Error('sync unavailable') });
    expect(errorHtml).toContain('Orders could not be loaded.');
    expect(errorHtml).toContain('sync unavailable');
    expect(errorHtml).toContain('Try again');
    expect(errorHtml).not.toContain('Refresh orders');
  });

  it('formats status and money labels for buyer-facing copy', () => {
    expect(formatOrderMoney(1250)).toBe('$12.50');
    expect(orderStatusLabel('accepted')).toBe('Offer accepted');
    expect(orderStatusLabel('failed')).toBe('Payment failed');
  });
});
