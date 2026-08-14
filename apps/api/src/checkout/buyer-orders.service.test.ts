import { describe, expect, it, vi } from 'vitest';
import type { TargetedOffer } from '../actions/action.types';
import type { AuctionWinnerOrder } from '../auction/auction.service';
import type { ReplayChapter } from '../chat/chat.service';
import type { EventSummary } from '../events/event.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { BuyerOrdersService } from './buyer-orders.service';
import { BuyerOrdersSyncQueries } from './checkout.module';
import type { CheckoutOrder, OrderStore } from './checkout.service';

const paymentSession = {
  provider: 'square',
  mode: 'sandbox',
  status: 'ready',
  appId: 'app',
  locationId: 'location',
  orderId: 'checkout-1',
  amountCents: 2500,
  currency: 'USD',
} as const;

const checkoutOrder: CheckoutOrder = {
  id: 'checkout-1',
  cartId: 'cart-1',
  buyerId: 'buyer-1',
  eventId: 'event-1',
  subtotalCents: 2500,
  shippingCents: 0,
  totalCents: 2500,
  currency: 'USD',
  status: 'paid',
  createdAt: '2026-08-14T01:00:00.000Z',
  items: [{ productId: 'cup', title: 'Aurora cup', priceCents: 1250, quantity: 2, imageUrl: '/cup.png' }],
  paymentSession,
};

const auctionOrder: AuctionWinnerOrder = {
  id: 'auction-order-1',
  auctionId: 'auction-1',
  eventId: 'event-1',
  eventItemId: 'item-plate',
  productId: 'plate',
  bidderId: 'buyer-1',
  quantity: 1,
  unitPriceCents: 1900,
  totalCents: 1900,
  status: 'pending',
  createdAt: '2026-08-14T02:00:00.000Z',
};

const offer: TargetedOffer = {
  id: 'offer-1',
  eventId: 'event-1',
  eventItemId: 'item-bowl',
  productId: 'bowl',
  buyerId: 'buyer-1',
  priceCents: 900,
  quantity: 2,
  status: 'accepted',
  createdAt: '2026-08-14T03:00:00.000Z',
};

const event: EventSummary = {
  eventId: 'event-1',
  title: 'Ceramics after dark',
  sellerId: 'seller-1',
  sellerName: 'Kiln & Coast',
  status: 'ended',
  startsAt: '2026-08-13T23:00:00.000Z',
  endedAt: '2026-08-14T04:00:00.000Z',
  thumbnailUrl: '/event.png',
  viewers: 0,
};

const chapters: ReplayChapter[] = [
  { id: 'chapter-cup-general', productId: 'cup', productTitle: 'Aurora cup', startMs: 5_000, endMs: 10_000, previewText: 'Hand-painted glaze.' },
  { id: 'chapter-cup', productId: 'cup', productTitle: 'Aurora cup', startMs: 12_000, endMs: 25_000, previewText: 'Scratch disclosed on the base.', evidenceKind: 'condition', evidenceLabel: 'Condition or flaw' },
  { id: 'chapter-plate', productId: 'plate', productTitle: 'Aurora plate', startMs: 45_000, previewText: 'See the rim detail.' },
  { id: 'chapter-bowl', productId: 'bowl', productTitle: 'Aurora bowl', startMs: 70_000, previewText: 'The bowl in natural light.' },
];

describe('BuyerOrdersService', () => {
  it('registers the bounded buyer-order aggregation as orders.byBuyer', async () => {
    const buyerOrders = {
      listForBuyer: vi.fn().mockResolvedValue([
        { id: 'order-2', buyerId: 'buyer-1', createdAt: '2026-08-14T02:00:00.000Z' },
        { id: 'order-1', buyerId: 'buyer-1', createdAt: '2026-08-14T01:00:00.000Z' },
      ]),
    };
    const queries = new SyncQueryRegistry();
    new BuyerOrdersSyncQueries(buyerOrders as never, queries).onModuleInit();

    await expect(queries.resolve('orders.byBuyer', { buyerId: 'buyer-1' })).resolves.toEqual([
      expect.objectContaining({ id: 'order-2', buyerId: 'buyer-1' }),
      expect.objectContaining({ id: 'order-1', buyerId: 'buyer-1' }),
    ]);
    expect(buyerOrders.listForBuyer).toHaveBeenCalledWith('buyer-1');
  });

  it('routes a missing buyer identity through the service validation boundary', async () => {
    const buyerOrders = {
      listForBuyer: vi.fn().mockRejectedValue(new Error('buyerId is required')),
    };
    const queries = new SyncQueryRegistry();
    new BuyerOrdersSyncQueries(buyerOrders as never, queries).onModuleInit();

    await expect(queries.resolve('orders.byBuyer', {})).rejects.toThrow('buyerId is required');
    expect(buyerOrders.listForBuyer).toHaveBeenCalledWith('');
  });

  it('aggregates checkout, auction, and offer records newest-first with replay snapshots', async () => {
    const orders = {
      listByBuyer: vi.fn().mockResolvedValue([checkoutOrder]),
    } as unknown as OrderStore;
    const auctions = { listWinnerOrdersForBuyer: vi.fn().mockResolvedValue([auctionOrder]) };
    const actions = { listOffersForBuyer: vi.fn().mockReturnValue([offer]) };
    const chat = { getReplayChapters: vi.fn().mockReturnValue(chapters) };
    const events = { listForGuide: vi.fn().mockResolvedValue([event]) };
    const service = new BuyerOrdersService(
      orders,
      auctions as never,
      actions as never,
      chat as never,
      events as never,
    );

    const result = await service.listForBuyer(' buyer-1 ');

    expect(orders.listByBuyer).toHaveBeenCalledWith('buyer-1');
    expect(auctions.listWinnerOrdersForBuyer).toHaveBeenCalledWith('buyer-1');
    expect(actions.listOffersForBuyer).toHaveBeenCalledWith('buyer-1');
    expect(result.map((order) => order.source)).toEqual(['offer', 'auction', 'checkout']);
    expect(result[0]).toMatchObject({
      id: 'offer-1',
      buyerId: 'buyer-1',
      eventTitle: 'Ceramics after dark',
      sellerName: 'Kiln & Coast',
      totalCents: 1800,
      items: [{ productId: 'bowl', title: 'Aurora bowl', quantity: 2 }],
      videoSnapshots: [{
        productId: 'bowl',
        thumbnailUrl: '/event.png',
        startMs: 70_000,
        previewText: 'The bowl in natural light.',
      }],
    });
    expect(result[2]?.videoSnapshots).toHaveLength(2);
    expect(result[2]?.videoSnapshots[1]).toMatchObject({
      productId: 'cup',
      productTitle: 'Aurora cup',
      startMs: 12_000,
      evidenceKind: 'condition',
      evidenceLabel: 'Condition or flaw',
    });
  });

  it('rejects an empty buyer identity before reading any order source', async () => {
    const orders = { listByBuyer: vi.fn() };
    const service = new BuyerOrdersService(
      orders as never,
      { listWinnerOrdersForBuyer: vi.fn() } as never,
      { listOffersForBuyer: vi.fn() } as never,
      { getReplayChapters: vi.fn() } as never,
      { listForGuide: vi.fn() } as never,
    );

    await expect(service.listForBuyer('   ')).rejects.toThrow('buyerId is required');
    expect(orders.listByBuyer).not.toHaveBeenCalled();
  });
});
