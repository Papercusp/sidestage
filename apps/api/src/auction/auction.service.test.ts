import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncInvalidationService, type SyncInvalidation } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { AuctionSyncQueries } from './auction.module';
import { AuctionService, InMemoryAuctionInventory } from './auction.service';
import { InMemoryOrderStore } from '../checkout/checkout.service';
import { FixtureCatalogSource } from '../catalog/catalog.sources';

describe('AuctionService', () => {
  afterEach(() => vi.useRealTimers());

  it('registers the active auction read with the shared sync query registry', async () => {
    const auctions = { getCurrentAuction: vi.fn().mockResolvedValue({ id: 'auction-1', eventId: 'event-1' }) };
    const queries = new SyncQueryRegistry();
    new AuctionSyncQueries(auctions as never, queries).onModuleInit();

    await expect(queries.resolve('event.auction.active', { eventId: 'event-1' })).resolves.toEqual([
      { id: 'auction-1', eventId: 'event-1' },
    ]);
    expect(auctions.getCurrentAuction).toHaveBeenCalledWith('event-1');
  });

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

  it('saves absolute total quantity while preserving active reservations', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-save', 5);
    await inventory.reserve('product-save', 2, { kind: 'cart', id: 'cart-save' });

    await expect(inventory.save('product-save', 8, 1_500)).resolves.toMatchObject({
      qty: 8,
      reservedQty: 2,
      availableQty: 6,
      priceCents: 1_500,
    });
    await expect(inventory.save('product-save', 1, 1_500)).rejects.toThrow(
      'Quantity cannot be lower than 2 reserved units',
    );
  });

  it('onboards an idempotent seller clone without changing the source fixture owner', async () => {
    const catalog = new FixtureCatalogSource([{
      id: 'source-mug', groupId: 'mugs', title: 'Source mug', brand: 'Kiln', productType: 'HOME', sku: 'MUG',
      condition: 'NEW', handlingDays: 1, priceCents: 1_200, qty: 5, reservedQty: 0, availableQty: 5,
    }]);
    const inventory = new InMemoryAuctionInventory(catalog);

    const first = await inventory.onboardOwned('source-mug', 3, 1_500, 'seller-alpha');
    const second = await inventory.onboardOwned('source-mug', 4, 1_600, 'seller-alpha');

    expect(first?.productId).toMatch(/^seller-listing-/);
    expect(second).toMatchObject({ productId: first?.productId, qty: 4, priceCents: 1_600 });
    await expect(catalog.searchOwned({ pageSize: 10 }, 'seller-alpha')).resolves.toMatchObject({
      total: 1,
      rows: [expect.objectContaining({ id: first?.productId, qty: 4, priceCents: 1_600 })],
    });
    await expect(catalog.searchOwned({ pageSize: 10 }, 'demo-seller')).resolves.toMatchObject({
      total: 1,
      rows: [expect.objectContaining({ id: 'source-mug', qty: 5, priceCents: 1_200 })],
    });
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
    ).rejects.toThrow(/Insufficient event allocation/);
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
    await expect(auctions.listWinnerOrdersForBuyer('buyer-b')).resolves.toEqual([
      expect.objectContaining({ id: closed.winnerOrder?.id, bidderId: 'buyer-b' }),
    ]);
    await expect(auctions.listWinnerOrdersForBuyer('buyer-a')).resolves.toEqual([]);
    await expect(inventory.get('product-1')).resolves.toMatchObject({ reservedQty: 2, availableQty: 8 });
    // The closed auction MUST remain readable: this is what the buyer panel
    // renders the SOLD/winner state from. It previously returned null here,
    // which is why a winning bidder saw "No auction is live yet" (WI-38736).
    await expect(auctions.getCurrentAuction('event-1')).resolves.toMatchObject({
      id: started.id,
      status: 'closed',
      winnerOrder: expect.objectContaining({ bidderId: 'buyer-b' }),
    });
  });

  it('materializes one canonical auction order at close and commits the exact winner hold idempotently', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-canonical', 3);
    const orders = new InMemoryOrderStore();
    const auctions = new AuctionService(inventory, undefined, undefined, orders);
    const started = await auctions.startAuction({
      eventId: 'event-canonical', eventItemId: 'item-canonical', productId: 'product-canonical',
      quantity: 2, startingPriceCents: 1_000,
    });
    await auctions.placeBid(started.id, { bidderId: 'buyer-winner', amountCents: 1_400 });
    const closed = await auctions.closeAuction(started.id);

    await expect(orders.findBySource('auction', started.id)).resolves.toMatchObject({
      id: closed.winnerOrder!.id,
      buyerId: 'buyer-winner',
      sourceKind: 'auction',
      sourceId: started.id,
      subtotalCents: 2_800,
    });
    await auctions.commitWinnerReservation(started.id, 'buyer-winner');
    await auctions.commitWinnerReservation(started.id, 'buyer-winner');
    await expect(inventory.get('product-canonical')).resolves.toMatchObject({ reservedQty: 2, availableQty: 1 });
    await expect(auctions.startAuction({
      eventId: 'event-canonical',
      eventItemId: 'item-canonical',
      productId: 'product-canonical',
      quantity: 2,
      startingPriceCents: 1_100,
    })).rejects.toThrow('Insufficient event allocation');
    await expect(auctions.commitWinnerReservation(started.id, 'buyer-other')).rejects.toThrow('not found for this buyer');
  });

  it('restores a winner allocation after payment failure so it can be auctioned again', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-retry', 2);
    const auctions = new AuctionService(inventory);
    const first = await auctions.startAuction({
      eventId: 'event-retry',
      eventItemId: 'item-retry',
      productId: 'product-retry',
      quantity: 2,
      startingPriceCents: 1_000,
    });
    await auctions.placeBid(first.id, { bidderId: 'buyer-retry', amountCents: 1_200 });
    await auctions.closeAuction(first.id);

    await auctions.releaseWinnerReservation(first.id, 'buyer-retry');
    await auctions.releaseWinnerReservation(first.id, 'buyer-retry');

    await expect(auctions.startAuction({
      eventId: 'event-retry',
      eventItemId: 'item-retry',
      productId: 'product-retry',
      quantity: 2,
      startingPriceCents: 1_100,
    })).resolves.toMatchObject({ status: 'active', allocationState: 'held' });
  });

  it('replays one guest idempotency key without duplicating the bid and rejects changed reuse', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 4);
    const auctions = new AuctionService(inventory);
    const started = await auctions.startAuction({
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 1_000,
    });
    const bid = {
      bidderId: 'guest_verified',
      displayName: 'Ava',
      amountCents: 1_200,
      idempotencyKey: 'bid:req-1234',
    };

    await auctions.placeBid(started.id, bid);
    await expect(auctions.placeBid(started.id, bid)).resolves.toMatchObject({
      currentPriceCents: 1_200,
      bids: [expect.objectContaining(bid)],
    });
    await expect(auctions.placeBid(started.id, { ...bid, amountCents: 1_300 })).rejects.toThrow(
      /Idempotency key was already used for a different bid/,
    );
    await expect(auctions.placeBid(started.id, {
      ...bid,
      bidderId: 'guest_other',
      amountCents: 1_300,
    })).resolves.toMatchObject({ currentPriceCents: 1_300, bids: expect.any(Array) });
    await expect(auctions.getAuction(started.id)).resolves.toMatchObject({ bids: [{ amountCents: 1_300 }, { amountCents: 1_200 }] });
  });

  it('serves the closed auction to the buyer panel query, so the winner sees the result', async () => {
    // The regression this locks down is END-TO-END through the query the panel
    // actually reads. The panel's SOLD branch had passing prop-driven tests the
    // whole time it was unreachable in the live wiring, so asserting on the
    // component proves nothing here — the input is what was broken.
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 3);
    const auctions = new AuctionService(inventory);
    const queries = new SyncQueryRegistry();
    new AuctionSyncQueries(auctions as never, queries).onModuleInit();

    const started = await auctions.startAuction({
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 1000,
    });
    await auctions.placeBid(started.id, { bidderId: 'buyer-a', amountCents: 1400, displayName: 'A' });
    await auctions.closeAuction(started.id);

    const rows = (await queries.resolve('event.auction.active', { eventId: 'event-1' })) as Array<{
      id: string;
      status: string;
      winnerOrder?: { bidderId: string };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: started.id, status: 'closed' });
    expect(rows[0]?.winnerOrder?.bidderId).toBe('buyer-a');

    // And the SSE snapshot a reconnecting client receives agrees with it —
    // otherwise a dropped stream would still wipe the result on recovery.
    const snapshot = JSON.parse((await auctions.snapshotEvent('event-1')).data) as {
      auction: { id: string; status: string } | null;
    };
    expect(snapshot.auction).toMatchObject({ id: started.id, status: 'closed' });
  });

  it('recovers the authoritative current auction through the durable store after restart', async () => {
    const recovered = {
      id: 'auction-recovered',
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 1_000,
      currentPriceCents: 1_400,
      status: 'active' as const,
      startedAt: '2026-08-14T18:00:00.000Z',
      endsAt: '2099-08-14T18:01:00.000Z',
      bids: [{
        id: 'bid-1',
        bidderId: 'buyer-a',
        amountCents: 1_400,
        createdAt: '2026-08-14T18:00:30.000Z',
      }],
    };
    const store = { getCurrentByEvent: vi.fn().mockResolvedValue(recovered) };
    const restarted = new AuctionService(new InMemoryAuctionInventory(), undefined, store as never);

    await expect(restarted.getCurrentAuction('event-1')).resolves.toEqual(recovered);
    expect(store.getCurrentByEvent).toHaveBeenCalledWith('event-1');
  });

  it('lets the next auction start on an event whose previous one closed', async () => {
    // The event's current-auction entry now survives a close, so the
    // "already has an active auction" guard must key on STATUS, not presence.
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 6);
    const auctions = new AuctionService(inventory);
    const first = await auctions.startAuction({
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 500,
    });
    await auctions.closeAuction(first.id);

    const second = await auctions.startAuction({
      eventId: 'event-1',
      eventItemId: 'item-2',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 700,
    });
    expect(second.id).not.toBe(first.id);
    // ...and the current auction is now the NEW one, not the closed one.
    await expect(auctions.getCurrentAuction('event-1')).resolves.toMatchObject({ id: second.id, status: 'active' });
    // Starting a third while the second is live is still refused.
    await expect(
      auctions.startAuction({
        eventId: 'event-1',
        eventItemId: 'item-3',
        productId: 'product-1',
        quantity: 1,
        startingPriceCents: 900,
      }),
    ).rejects.toThrow(/already has an active auction/);
  });

  it('releases the start-time hold when an auction closes without bids', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 4);
    const auctions = new AuctionService(inventory);
    const started = await auctions.startAuction({ eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1', quantity: 3, startingPriceCents: 500 });
    await auctions.closeAuction(started.id);
    await expect(inventory.get('product-1')).resolves.toMatchObject({ reservedQty: 0, availableQty: 4 });
    await expect(auctions.startAuction({
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 3,
      startingPriceCents: 600,
    })).resolves.toMatchObject({ status: 'active', allocationState: 'held' });
  });

  it('seller cancellation restores the exact event allocation idempotently', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-cancel', 2);
    const auctions = new AuctionService(inventory);
    const first = await auctions.startAuction({
      eventId: 'event-cancel',
      eventItemId: 'item-cancel',
      productId: 'product-cancel',
      quantity: 2,
      startingPriceCents: 500,
    });

    await expect(auctions.cancelAuction(first.id)).resolves.toMatchObject({
      status: 'closed',
      closeReason: 'seller-cancelled',
      allocationState: 'released',
    });
    await expect(auctions.cancelAuction(first.id)).resolves.toMatchObject({ allocationState: 'released' });
    await expect(auctions.startAuction({
      eventId: 'event-cancel',
      eventItemId: 'item-cancel',
      productId: 'product-cancel',
      quantity: 2,
      startingPriceCents: 600,
    })).resolves.toMatchObject({ status: 'active', allocationState: 'held' });
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

  it('publishes auction and inventory changes on the shared sync invalidation bus', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 2);
    const invalidations = new SyncInvalidationService();
    const published: SyncInvalidation[] = [];
    const subscription = invalidations.events().subscribe((event) => published.push(event));
    const auctions = new AuctionService(inventory, invalidations);

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

    expect(published.map(({ name }) => name)).toEqual([
      'event.auction.active',
      'event.pricingHistory',
      'event.lineup.items',
      'catalog.page',
      'inventory.snapshot',
      'event.auction.active',
      'event.pricingHistory',
      'event.auction.active',
      'event.pricingHistory',
      'orders.byBuyer',
    ]);
    expect(published.filter(({ name }) => name === 'event.auction.active').map(({ args }) => args)).toEqual([
      { eventId: 'event-1' },
      { eventId: 'event-1' },
      { eventId: 'event-1' },
    ]);
    expect(published.filter(({ name }) => name === 'orders.byBuyer').map(({ args }) => args)).toEqual([
      { buyerId: 'buyer-a' },
    ]);
    expect(published.filter(({ name }) => name === 'inventory.snapshot').map(({ args }) => args)).toEqual([
      { productId: 'product-1' },
    ]);
    expect(published.filter(({ name }) => name === 'event.lineup.items').map(({ args }) => args)).toEqual([
      { eventId: 'event-1' },
    ]);
    expect(published.filter(({ name }) => name === 'event.pricingHistory').map(({ args }) => args)).toEqual([
      { eventId: 'event-1', productId: 'product-1' },
      { eventId: 'event-1', productId: 'product-1' },
      { eventId: 'event-1', productId: 'product-1' },
    ]);
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

  it('expires timed cart holds but never expires committed inventory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-14T06:00:00Z');
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('product-1', 2);
    const expiring = { kind: 'cart' as const, id: 'cart-expiring' };
    const paid = { kind: 'cart' as const, id: 'cart-paid' };
    await inventory.reserve('product-1', 1, expiring, '2026-08-14T06:02:00Z');
    await inventory.reserve('product-1', 1, paid, '2026-08-14T06:02:00Z');
    await inventory.commit('product-1', paid);

    vi.advanceTimersByTime(120_001);
    await expect(inventory.get('product-1')).resolves.toMatchObject({ reservedQty: 1, availableQty: 1 });
  });
});
