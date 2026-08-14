import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBuyerOrders,
  formatOrderMoney,
  OrderHistory,
  orderStatusLabel,
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
  }],
};

afterEach(() => vi.unstubAllGlobals());

describe('OrdersTab', () => {
  it('renders order status, totals, line items, and the per-purchase video moment', () => {
    const html = renderToStaticMarkup(<OrderHistory orders={[order]} buyerId="buyer-1" />);

    expect(html).toContain('Auction win');
    expect(html).toContain('Ceramics after dark');
    expect(html).toContain('Kiln &amp; Coast');
    expect(html).toContain('Paid');
    expect(html).toContain('$30.00');
    expect(html).toContain('2 × $12.50');
    expect(html).toContain('Your product moments');
    expect(html).toContain('1:23');
    expect(html).toContain('See the hand-painted detail up close.');
  });

  it('names the active identity when its history is empty', () => {
    const html = renderToStaticMarkup(<OrderHistory orders={[]} buyerId="demo-alice" />);
    expect(html).toContain('No orders for demo-alice');
  });

  it('requests only the selected buyer identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ orders: [order] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBuyerOrders('alice & bob', 'https://api.example.test/')).resolves.toEqual([order]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/checkout/orders?buyerId=alice+%26+bob',
      { signal: undefined },
    );
  });

  it('formats status and money labels for buyer-facing copy', () => {
    expect(formatOrderMoney(1250)).toBe('$12.50');
    expect(orderStatusLabel('accepted')).toBe('Offer accepted');
    expect(orderStatusLabel('failed')).toBe('Payment failed');
  });
});
