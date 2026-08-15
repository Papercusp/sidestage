import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryActionItemStore } from '../actions/action-item.store';
import { InMemoryAuctionInventory } from '../auction/auction.service';
import { InMemoryEventStore, type EventRecord } from '../events/event.service';
import { BUYER_HOLD_DURATION_MS } from '../inventory/hold-policy';
import { SyncInvalidationService, type SyncInvalidation } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { CartSyncQueries } from './cart.module';
import { CartService, InMemoryCartStore } from './cart.service';

describe('CartService', () => {
  afterEach(() => vi.useRealTimers());

  it('registers cart.byId as a bounded cart query', async () => {
    const carts = new CartService(new InMemoryCartStore());
    await carts.addItem({ cartId: 'cart-live', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const queries = new SyncQueryRegistry();
    new CartSyncQueries(carts, queries).onModuleInit();

    await expect(queries.resolve('cart.byId', { cartId: ' cart-live ' })).resolves.toEqual([
      expect.objectContaining({ id: 'cart-live', subtotalCents: 1250 }),
    ]);
    await expect(queries.resolve('cart.byId', { cartId: 'missing' })).resolves.toEqual([]);
    await expect(queries.resolve('cart.byId', {})).resolves.toEqual([]);
  });

  it('invalidates the scoped cart and inventory views after authoritative writes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-14T06:00:00Z');
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('p-1', 3);
    const invalidations = new SyncInvalidationService();
    const published: SyncInvalidation[] = [];
    const subscription = invalidations.events().subscribe((event) => published.push(event));
    const carts = new CartService(new InMemoryCartStore(), inventory, invalidations);

    const held = await carts.holdItem({ cartId: 'cart-live', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    await carts.setQuantity(held.id, 'p-1', 2);
    await carts.removeItem(held.id, 'p-1');
    await carts.holdItem({ cartId: held.id, productId: 'p-1', title: 'Mug', priceCents: 1250 });
    await carts.commit(held.id);
    subscription.unsubscribe();

    expect(published.filter(({ name }) => name === 'cart.byId').map(({ args }) => args)).toEqual(
      expect.arrayContaining([
        { cartId: 'cart-live' },
        { cartId: 'cart-live' },
        { cartId: 'cart-live' },
        { cartId: 'cart-live' },
      ]),
    );
    expect(published.filter(({ name }) => name === 'inventory.snapshot').map(({ args }) => args)).toEqual([
      { productId: 'p-1' },
      { productId: 'p-1' },
      { productId: 'p-1' },
      { productId: 'p-1' },
      { productId: 'p-1' },
    ]);
    expect(published.filter(({ name }) => name === 'catalog.page').map(({ args }) => args)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('holds a published event item at server-authoritative price and replays idempotently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-14T06:00:00Z');
    const eventItems = new InMemoryActionItemStore();
    await eventItems.register('event-live', [{
      eventId: 'event-live', eventItemId: 'event-live:mug', productId: 'mug',
      title: 'Authoritative mug', referencePriceCents: 2_000, priceCents: 1_500,
      quantity: 2, availableQty: 2, position: 0, stageState: 'on-stage', onStage: true,
      attributes: {},
    }]);
    const events = new InMemoryEventStore([eventRecord('event-live', 'live')]);
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('mug', 2);
    const invalidations = new SyncInvalidationService();
    const published: SyncInvalidation[] = [];
    const subscription = invalidations.events().subscribe((event) => published.push(event));
    const carts = new CartService(
      new InMemoryCartStore(eventItems, events, inventory),
      inventory,
      invalidations,
    );
    const input = {
      cartId: 'cart-event', eventId: 'event-live', eventItemId: 'event-live:mug',
      productId: 'mug', title: 'Client title', priceCents: 1, quantity: 1,
      idempotencyKey: 'hold-1',
    };

    const held = await carts.holdItem(input);
    const replay = await carts.holdItem(input);

    expect(held).toMatchObject({
      subtotalCents: 1_500,
      items: [{
        eventId: 'event-live', eventItemId: 'event-live:mug', productId: 'mug',
        title: 'Authoritative mug', priceCents: 1_500, quantity: 1,
      }],
      eventHoldKeys: ['hold-1'],
    });
    expect(replay).toEqual(held);
    await expect(eventItems.list('event-live')).resolves.toMatchObject([{ availableQty: 1 }]);
    await expect(inventory.get('mug')).resolves.toMatchObject({ reservedQty: 1, availableQty: 1 });
    expect(published.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'cart.byId', 'event.lineup.items', 'event.actions.items', 'inventory.snapshot', 'catalog.page',
    ]));
    subscription.unsubscribe();
  });

  it('hides draft, missing, and foreign event-lineup combinations behind one not-found boundary', async () => {
    const eventItems = new InMemoryActionItemStore();
    await eventItems.register('event-draft', [{
      eventId: 'event-draft', eventItemId: 'event-draft:mug', productId: 'mug',
      title: 'Draft mug', referencePriceCents: 2_000, priceCents: 1_500,
      quantity: 2, availableQty: 2, position: 0, stageState: 'queued', onStage: false,
      attributes: {},
    }]);
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('mug', 2);
    const carts = new CartService(
      new InMemoryCartStore(
        eventItems,
        new InMemoryEventStore([eventRecord('event-draft', 'draft')]),
        inventory,
      ),
      inventory,
    );
    const base = {
      cartId: 'cart-hidden', eventId: 'event-draft', eventItemId: 'event-draft:mug',
      productId: 'mug', title: 'Draft mug', priceCents: 1_500, idempotencyKey: 'hold-hidden',
    };

    await expect(carts.holdItem(base)).rejects.toThrow('Event item is not available');
    await expect(carts.holdItem({ ...base, eventId: 'missing' })).rejects.toThrow('Event item is not available');
    await expect(carts.holdItem({ ...base, eventItemId: 'foreign:item' })).rejects.toThrow('Event item is not available');
    await expect(eventItems.list('event-draft')).resolves.toMatchObject([{ availableQty: 2 }]);
    await expect(inventory.get('mug')).resolves.toMatchObject({ reservedQty: 0, availableQty: 2 });
  });
  it('merges repeated products and calculates a cents subtotal', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const first = await carts.addItem({ cartId: 'cart-1', productId: 'p-1', title: 'Mug', priceCents: 1250, quantity: 2 });
    const second = await carts.addItem({ cartId: first.id, productId: 'p-1', title: 'Mug', priceCents: 1250, quantity: 1 });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].quantity).toBe(3);
    expect(second.subtotalCents).toBe(3750);
  });

  it('rejects invalid quantities instead of creating unbounded carts', async () => {
    const carts = new CartService(new InMemoryCartStore());
    await expect(carts.addItem({ productId: 'p-1', title: 'Mug', priceCents: 1250, quantity: 0 })).rejects.toThrow('Quantity');
  });

  it('keeps inventory reserved past the old two-minute timeout and releases it after the checkout window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-14T06:00:00Z');
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('p-1', 1);
    const carts = new CartService(new InMemoryCartStore(), inventory);

    const held = await carts.holdItem({ cartId: 'cart-held', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    expect(held.items[0].expiresAt).toBe('2026-08-14T06:15:00.000Z');
    await expect(inventory.get('p-1')).resolves.toMatchObject({ reservedQty: 1, availableQty: 0 });

    vi.advanceTimersByTime(2 * 60_000 + 1);
    await expect(carts.findCart(held.id)).resolves.toMatchObject({
      items: [expect.objectContaining({ productId: 'p-1' })],
      subtotalCents: 1250,
    });
    await expect(inventory.get('p-1')).resolves.toMatchObject({ reservedQty: 1, availableQty: 0 });

    vi.advanceTimersByTime(BUYER_HOLD_DURATION_MS - 2 * 60_000);
    await expect(carts.findCart(held.id)).resolves.toMatchObject({ items: [], subtotalCents: 0 });
    await expect(inventory.get('p-1')).resolves.toMatchObject({ reservedQty: 0, availableQty: 1 });
  });

  it('commits paid inventory and clears the reusable cart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-14T06:00:00Z');
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('p-1', 1);
    const carts = new CartService(new InMemoryCartStore(), inventory);
    const held = await carts.holdItem({ cartId: 'cart-paid', productId: 'p-1', title: 'Mug', priceCents: 1250 });

    await expect(carts.commit(held.id)).resolves.toMatchObject({ items: [], subtotalCents: 0 });
    await expect(carts.commit(held.id)).resolves.toMatchObject({ items: [], subtotalCents: 0 });
    vi.advanceTimersByTime(BUYER_HOLD_DURATION_MS + 1);
    await expect(inventory.get('p-1')).resolves.toMatchObject({ reservedQty: 1, availableQty: 0 });
  });

  it('releases a cancelled cart hold exactly once and clears the reusable cart', async () => {
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('p-cancel', 1);
    const carts = new CartService(new InMemoryCartStore(), inventory);
    const held = await carts.holdItem({ cartId: 'cart-cancel', productId: 'p-cancel', title: 'Mug', priceCents: 1_250 });

    await expect(carts.release(held.id)).resolves.toMatchObject({ items: [], subtotalCents: 0 });
    await expect(carts.release(held.id)).resolves.toMatchObject({ items: [], subtotalCents: 0 });
    await expect(inventory.get('p-cancel')).resolves.toMatchObject({ reservedQty: 0, availableQty: 1 });
  });
});

function eventRecord(eventId: string, status: EventRecord['status']): EventRecord {
  return {
    eventId,
    title: eventId,
    sellerId: 'seller-1',
    sellerName: 'Seller One',
    status,
    startsAt: '2026-08-14T05:00:00Z',
    endedAt: null,
  };
}
