import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuctionService, InMemoryAuctionInventory } from './auction.service';

describe('AuctionService', () => {
  afterEach(() => vi.useRealTimers());

  it('starts on an event item and atomically holds quantity in reservedQty', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 5);
    const auctions = new AuctionService(inventory);

    const auction = await auctions.startAuction({
      eventId: 'event-1',
      eventItemId: 'event-item-1',
      productId: 'product-1',
      quantity: 2,
      startingPriceCents: 1000,
      durationSec: 60,
    });

    expect(auction.status).toBe('active');
    expect(auction.currentPriceCents).toBe(1000);
    await expect(inventory.get('product-1')).resolves.toMatchObject({ qty: 5, reservedQty: 2, availableQty: 3 });
  });

  it('allows only one active auction per event and rejects an oversize hold', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 3);
    const auctions = new AuctionService(inventory);
    const input = { eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 2, startingPriceCents: 100 };
    await auctions.startAuction(input);

    await expect(auctions.startAuction({ ...input, eventItemId: 'item-2' })).rejects.toThrow(/already has an active auction/);
    await expect(
      auctions.startAuction({ eventId: 'event-2', eventItemId: 'item-2', productId: 'product-1', quantity: 2, startingPriceCents: 100 }),
    ).rejects.toThrow(/Insufficient available quantity/);
  });

  it('orders bids, closes to a winner order, and keeps the winner hold reserved', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 10);
    const auctions = new AuctionService(inventory);
    const started = await auctions.startAuction({ eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 2, startingPriceCents: 1000 });

    await auctions.placeBid(started.id, { bidderId: 'buyer-a', amountCents: 1200 });
    const latest = await auctions.placeBid(started.id, { bidderId: 'buyer-b', amountCents: 1500, displayName: 'B' });
    expect(latest.bids.map((bid) => bid.amountCents)).toEqual([1500, 1200]);
    await expect(auctions.placeBid(started.id, { bidderId: 'buyer-c', amountCents: 1500 })).rejects.toThrow(/greater than/);

    const closed = await auctions.closeAuction(started.id);
    expect(closed.status).toBe('closed');
    expect(closed.winnerOrder).toMatchObject({ bidderId: 'buyer-b', quantity: 2, unitPriceCents: 1500, totalCents: 3000, status: 'pending' });
    await expect(inventory.get('product-1')).resolves.toMatchObject({ reservedQty: 2, availableQty: 8 });
    await expect(auctions.getActiveAuction('event-1')).resolves.toBeNull();
  });

  it('releases the start-time hold when an auction closes without bids', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 4);
    const auctions = new AuctionService(inventory);
    const started = await auctions.startAuction({ eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 3, startingPriceCents: 500 });
    await auctions.closeAuction(started.id);
    await expect(inventory.get('product-1')).resolves.toMatchObject({ reservedQty: 0, availableQty: 4 });
  });

  it('auto-closes at the countdown and creates a winner order', async () => {
    vi.useFakeTimers();
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 2);
    const auctions = new AuctionService(inventory);
    const started = await auctions.startAuction({ eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 1, startingPriceCents: 900, durationSec: 5 });
    await auctions.placeBid(started.id, { bidderId: 'buyer-a', amountCents: 1000 });

    vi.advanceTimersByTime(5_000);
    const expired = await auctions.getAuction(started.id);
    expect(expired?.status).toBe('closed');
    expect(expired?.winnerOrder?.bidderId).toBe('buyer-a');
  });

  it('publishes realtime snapshots for start, bid, and close transitions', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 2);
    const auctions = new AuctionService(inventory);
    const snapshots: Array<{ auction: { status: string; currentPriceCents: number } | null }> = [];
    const subscription = auctions.updates('event-1').subscribe((event) => {
      snapshots.push(JSON.parse(event.data) as { auction: { status: string; currentPriceCents: number } | null });
    });

    const started = await auctions.startAuction({
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 1_000,
    });
    await auctions.placeBid(started.id, { bidderId: 'buyer-a', amountCents: 1_200 });
    await auctions.closeAuction(started.id);
    subscription.unsubscribe();

    expect(snapshots.map((snapshot) => snapshot.auction?.currentPriceCents)).toEqual([1_000, 1_200, 1_200]);
    expect(snapshots.map((snapshot) => snapshot.auction?.status)).toEqual(['active', 'active', 'closed']);
  });

  it('lists active and completed outcomes only for the requested product', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 3);
    await inventory.seed('product-2', 1);
    const auctions = new AuctionService(inventory);
    const sold = await auctions.startAuction({ eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 1, startingPriceCents: 1_000 });
    await auctions.placeBid(sold.id, { bidderId: 'buyer-a', amountCents: 1_200 });
    await auctions.closeAuction(sold.id);
    const active = await auctions.startAuction({ eventId: 'event-2', eventItemId: 'item-2', productId: 'product-1', quantity: 1, startingPriceCents: 900 });
    await auctions.startAuction({ eventId: 'event-3', eventItemId: 'item-3', productId: 'product-2', quantity: 1, startingPriceCents: 500 });

    const history = await auctions.listByProduct('product-1');

    expect(history.map(({ id }) => id).sort()).toEqual([active.id, sold.id].sort());
    expect(history.find(({ id }) => id === sold.id)?.winnerOrder?.bidderId).toBe('buyer-a');
    expect(history.every(({ productId }) => productId === 'product-1')).toBe(true);
  });

  it('re-reserving under the same source replaces the hold instead of stacking it', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 5);
    const source = { kind: 'auction' as const, id: 'auction-x' };
    await expect(inventory.reserve('product-1', 3, source)).resolves.toBe(true);
    await expect(inventory.reserve('product-1', 4, source)).resolves.toBe(true);
    await expect(inventory.get('product-1')).resolves.toMatchObject({ reservedQty: 4, availableQty: 1 });
    await expect(inventory.release('product-1', 4, source)).resolves.toBe(true);
    await expect(inventory.get('product-1')).resolves.toMatchObject({ reservedQty: 0, availableQty: 5 });
  });
});
