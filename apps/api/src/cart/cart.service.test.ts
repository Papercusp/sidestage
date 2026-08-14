import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuctionInventory } from '../auction/auction.service';
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

  it('authors a two-minute hold and releases inventory when the cart is read after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-14T06:00:00Z');
    const inventory = new InMemoryAuctionInventory();
    await inventory.seed('p-1', 1);
    const carts = new CartService(new InMemoryCartStore(), inventory);

    const held = await carts.holdItem({ cartId: 'cart-held', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    expect(held.items[0].expiresAt).toBe('2026-08-14T06:02:00.000Z');
    await expect(inventory.get('p-1')).resolves.toMatchObject({ reservedQty: 1, availableQty: 0 });

    vi.advanceTimersByTime(BUYER_HOLD_DURATION_MS + 1);
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
    vi.advanceTimersByTime(BUYER_HOLD_DURATION_MS + 1);
    await expect(inventory.get('p-1')).resolves.toMatchObject({ reservedQty: 1, availableQty: 0 });
  });
});
