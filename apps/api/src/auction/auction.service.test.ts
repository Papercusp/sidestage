import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuctionService, InMemoryAuctionInventory } from './auction.service';

describe('AuctionService', () => {
  afterEach(() => vi.useRealTimers());

  it('starts on an event item and atomically holds quantity in reservedQty', () => {
    const inventory = new InMemoryAuctionInventory();
    inventory.seed('product-1', 5);
    const auctions = new AuctionService(inventory);

    const auction = auctions.startAuction({
      eventId: 'event-1',
      eventItemId: 'event-item-1',
      productId: 'product-1',
      quantity: 2,
      startingPriceCents: 1000,
      durationSec: 60,
    });

    expect(auction.status).toBe('active');
    expect(auction.currentPriceCents).toBe(1000);
    expect(inventory.get('product-1')).toMatchObject({ qty: 5, reservedQty: 2, availableQty: 3 });
  });

  it('allows only one active auction per event and rejects an oversize hold', () => {
    const inventory = new InMemoryAuctionInventory();
    inventory.seed('product-1', 3);
    const auctions = new AuctionService(inventory);
    const input = { eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 2, startingPriceCents: 100 };
    auctions.startAuction(input);

    expect(() => auctions.startAuction({ ...input, eventItemId: 'item-2' })).toThrow(/already has an active auction/);
    expect(() => auctions.startAuction({ eventId: 'event-2', eventItemId: 'item-2', productId: 'product-1', quantity: 2, startingPriceCents: 100 })).toThrow(/Insufficient available quantity/);
  });

  it('orders bids, closes to a winner order, and keeps the winner hold reserved', () => {
    const inventory = new InMemoryAuctionInventory();
    inventory.seed('product-1', 10);
    const auctions = new AuctionService(inventory);
    const started = auctions.startAuction({ eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 2, startingPriceCents: 1000 });

    auctions.placeBid(started.id, { bidderId: 'buyer-a', amountCents: 1200 });
    const latest = auctions.placeBid(started.id, { bidderId: 'buyer-b', amountCents: 1500, displayName: 'B' });
    expect(latest.bids.map((bid) => bid.amountCents)).toEqual([1500, 1200]);
    expect(() => auctions.placeBid(started.id, { bidderId: 'buyer-c', amountCents: 1500 })).toThrow(/greater than/);

    const closed = auctions.closeAuction(started.id);
    expect(closed.status).toBe('closed');
    expect(closed.winnerOrder).toMatchObject({ bidderId: 'buyer-b', quantity: 2, unitPriceCents: 1500, totalCents: 3000, status: 'pending' });
    expect(inventory.get('product-1')).toMatchObject({ reservedQty: 2, availableQty: 8 });
    expect(auctions.getActiveAuction('event-1')).toBeNull();
  });

  it('releases the start-time hold when an auction closes without bids', () => {
    const inventory = new InMemoryAuctionInventory();
    inventory.seed('product-1', 4);
    const auctions = new AuctionService(inventory);
    const started = auctions.startAuction({ eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 3, startingPriceCents: 500 });
    auctions.closeAuction(started.id);
    expect(inventory.get('product-1')).toMatchObject({ reservedQty: 0, availableQty: 4 });
  });

  it('auto-closes at the countdown and creates a winner order', () => {
    vi.useFakeTimers();
    const inventory = new InMemoryAuctionInventory();
    inventory.seed('product-1', 2);
    const auctions = new AuctionService(inventory);
    const started = auctions.startAuction({ eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 1, startingPriceCents: 900, durationSec: 5 });
    auctions.placeBid(started.id, { bidderId: 'buyer-a', amountCents: 1000 });

    vi.advanceTimersByTime(5_000);
    const expired = auctions.getAuction(started.id);
    expect(expired?.status).toBe('closed');
    expect(expired?.winnerOrder?.bidderId).toBe('buyer-a');
  });

  it('publishes realtime snapshots for start, bid, and close transitions', () => {
    const inventory = new InMemoryAuctionInventory();
    inventory.seed('product-1', 2);
    const auctions = new AuctionService(inventory);
    const snapshots: Array<{ auction: { status: string; currentPriceCents: number } | null }> = [];
    const subscription = auctions.updates('event-1').subscribe((event) => {
      snapshots.push(JSON.parse(event.data) as { auction: { status: string; currentPriceCents: number } | null });
    });

    const started = auctions.startAuction({
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 1_000,
    });
    auctions.placeBid(started.id, { bidderId: 'buyer-a', amountCents: 1_200 });
    auctions.closeAuction(started.id);
    subscription.unsubscribe();

    expect(snapshots.map((snapshot) => snapshot.auction?.currentPriceCents)).toEqual([1_000, 1_200, 1_200]);
    expect(snapshots.map((snapshot) => snapshot.auction?.status)).toEqual(['active', 'active', 'closed']);
  });
});
