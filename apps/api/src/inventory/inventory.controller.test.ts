import { describe, expect, it, vi } from 'vitest';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { InventoryController } from './inventory.controller';

describe('InventoryController seller boundary', () => {
  it('onboards a public variant into a derived seller listing without accepting a client owner', async () => {
    const snapshot = { productId: 'seller-listing-abc', qty: 4, reservedQty: 0, availableQty: 4, priceCents: 2_500 };
    const inventory = { onboardOwned: vi.fn().mockResolvedValue(snapshot) };
    const invalidations = { invalidate: vi.fn() };
    const ownership = { sellerId: vi.fn().mockReturnValue('seller-alpha') };
    const controller = new InventoryController(inventory as never, invalidations as never, ownership as never);

    await expect(controller.onboard(
      'foreign-source',
      { quantity: 4, priceCents: 2_500 },
      'alpha-principal',
    )).resolves.toEqual({
      onboarded: true,
      sourceProductId: 'foreign-source',
      productId: snapshot.productId,
      quantity: 4,
      priceCents: 2_500,
      snapshot,
    });
    expect(ownership.sellerId).toHaveBeenCalledWith('alpha-principal');
    expect(inventory.onboardOwned).toHaveBeenCalledWith('foreign-source', 4, 2_500, 'seller-alpha');
    expect(invalidations.invalidate.mock.calls).toEqual([
      ['catalog.page'],
      ['inventory.page'],
      ['inventory.snapshot', { productId: snapshot.productId }, { principal: 'alpha-principal' }],
    ]);
  });

  it('rejects invalid or missing onboarding sources without publishing inventory', async () => {
    const inventory = { onboardOwned: vi.fn().mockResolvedValue(undefined) };
    const invalidations = { invalidate: vi.fn() };
    const controller = new InventoryController(
      inventory as never,
      invalidations as never,
      new EventOwnershipGuard({} as never),
    );

    await expect(controller.onboard('source', { quantity: -1, priceCents: 100 }, 'seller-alpha')).rejects.toThrow(
      'quantity must be a non-negative integer',
    );
    await expect(controller.onboard('source', { quantity: 1, priceCents: -1 }, 'seller-alpha')).rejects.toThrow(
      'priceCents must be a non-negative integer',
    );
    await expect(controller.onboard('missing', { quantity: 1, priceCents: 100 }, 'seller-alpha')).rejects.toThrow(
      'Catalog variant missing was not found',
    );
    await expect(controller.onboard('source', { quantity: 1, priceCents: 100 }, undefined)).rejects.toThrow(
      'x-demo-principal is required for seller-owned resources.',
    );
    expect(invalidations.invalidate).not.toHaveBeenCalled();
  });

  it('overwrites authoritative quantity and price and invalidates both shared reads', async () => {
    const snapshot = { productId: 'mug', qty: 8, reservedQty: 2, availableQty: 6, priceCents: 1_500 };
    const inventory = { saveOwned: vi.fn().mockResolvedValue(snapshot) };
    const invalidations = { invalidate: vi.fn() };
    const ownership = { sellerId: vi.fn().mockReturnValue('seller-demo-avi') };
    const controller = new InventoryController(inventory as never, invalidations as never, ownership as never);

    await expect(controller.save('mug', { quantity: 8, priceCents: 1_500 }, 'demo-avi')).resolves.toEqual({
      saved: true,
      quantity: 8,
      priceCents: 1_500,
      snapshot,
    });
    expect(ownership.sellerId).toHaveBeenCalledWith('demo-avi');
    expect(inventory.saveOwned).toHaveBeenCalledWith('mug', 8, 1_500, 'seller-demo-avi');
    expect(invalidations.invalidate.mock.calls).toEqual([
      ['catalog.page'],
      ['inventory.page'],
      ['inventory.snapshot', { productId: 'mug' }, { principal: 'demo-avi' }],
    ]);
  });

  it('rejects invalid saves and reports a missing catalog item', async () => {
    const inventory = { saveOwned: vi.fn().mockResolvedValue(undefined) };
    const controller = new InventoryController(
      inventory as never,
      { invalidate: vi.fn() } as never,
      { sellerId: vi.fn().mockReturnValue('seller-avi') } as never,
    );

    await expect(controller.save('mug', { quantity: -1, priceCents: 1_500 }, 'demo-avi')).rejects.toThrow('quantity must be a non-negative integer');
    await expect(controller.save('mug', { quantity: 2, priceCents: -1 }, 'demo-avi')).rejects.toThrow('priceCents must be a non-negative integer');
    await expect(controller.save('missing', { quantity: 2, priceCents: 1_500 }, 'demo-avi')).rejects.toThrow('Inventory item missing was not found');
  });

  it('uses the derived seller for seller-private reads and writes', async () => {
    const snapshot = { productId: 'mug', qty: 8, reservedQty: 2, availableQty: 6, priceCents: 1_500 };
    const inventory = {
      getOwned: vi.fn().mockResolvedValue(snapshot),
      saveOwned: vi.fn().mockResolvedValue(snapshot),
    };
    const controller = new InventoryController(
      inventory as never,
      { invalidate: vi.fn() } as never,
      new EventOwnershipGuard({} as never),
    );

    await expect(controller.snapshot('mug', 'seller-alpha')).resolves.toEqual(snapshot);
    await expect(controller.save(
      'mug',
      { quantity: 8, priceCents: 1_500 },
      'seller-alpha',
    )).resolves.toMatchObject({ saved: true, snapshot });

    expect(inventory.getOwned).toHaveBeenCalledWith('mug', 'seller-alpha');
    expect(inventory.saveOwned).toHaveBeenCalledWith('mug', 8, 1_500, 'seller-alpha');

    await controller.snapshot('mug', 'seller-beta');
    expect(inventory.getOwned).toHaveBeenLastCalledWith('mug', 'seller-beta');
  });

  it('cannot mutate another seller\'s inventory by direct product id', async () => {
    const snapshot = { productId: 'beta-only', qty: 8, reservedQty: 0, availableQty: 8, priceCents: 1_500 };
    const inventory = {
      saveOwned: vi.fn().mockImplementation(async (
        productId: string,
        _quantity: number,
        _priceCents: number,
        sellerId: string,
      ) => productId === 'beta-only' && sellerId === 'seller-beta' ? snapshot : undefined),
    };
    const controller = new InventoryController(
      inventory as never,
      { invalidate: vi.fn() } as never,
      new EventOwnershipGuard({} as never),
    );

    await expect(controller.save(
      'beta-only',
      { quantity: 8, priceCents: 1_500 },
      'seller-alpha',
    )).rejects.toThrow('Inventory item beta-only was not found');
    expect(inventory.saveOwned).toHaveBeenLastCalledWith('beta-only', 8, 1_500, 'seller-alpha');

    await expect(controller.save(
      'beta-only',
      { quantity: 8, priceCents: 1_500 },
      'seller-beta',
    )).resolves.toMatchObject({ saved: true, snapshot });
    expect(inventory.saveOwned).toHaveBeenLastCalledWith('beta-only', 8, 1_500, 'seller-beta');
  });

  it('rejects seller-private reads and writes without a principal', async () => {
    const inventory = { getOwned: vi.fn(), saveOwned: vi.fn() };
    const controller = new InventoryController(
      inventory as never,
      { invalidate: vi.fn() } as never,
      new EventOwnershipGuard({} as never),
    );

    await expect(controller.snapshot('mug', undefined)).rejects.toThrow(
      'x-demo-principal is required for seller-owned resources.',
    );
    await expect(controller.save(
      'mug',
      { quantity: 8, priceCents: 1_500 },
      undefined,
    )).rejects.toThrow('x-demo-principal is required for seller-owned resources.');
    expect(inventory.getOwned).not.toHaveBeenCalled();
    expect(inventory.saveOwned).not.toHaveBeenCalled();
  });

  it('does not hold a product outside the selected event seller\'s inventory', async () => {
    const inventory = {
      resolveOwnedProductId: vi.fn().mockResolvedValue(undefined),
      getOwned: vi.fn().mockResolvedValue(undefined),
      reserveOwned: vi.fn(),
    };
    const ownership = {
      requireOwned: vi.fn().mockResolvedValue({ sellerId: 'seller-avi' }),
    };
    const controller = new InventoryController(
      inventory as never,
      { invalidate: vi.fn() } as never,
      ownership as never,
    );

    await expect(controller.hold(
      'other-seller-product',
      { quantity: 1, sourceKind: 'event', sourceId: 'event-avi' },
      'demo-avi',
    )).rejects.toThrow('Inventory item other-seller-product was not found');

    expect(ownership.requireOwned).toHaveBeenCalledWith('event-avi', 'demo-avi');
    expect(inventory.resolveOwnedProductId).toHaveBeenCalledWith('other-seller-product', 'seller-avi');
    expect(inventory.reserveOwned).not.toHaveBeenCalled();
  });

  // EI-20490482242092934: the event item names the public catalog variant, but a
  // seller who onboarded it holds stock under a derived listing id. Every seller
  // surface must reach the derived row, and none of them may quote it back.
  it('holds and releases an onboarded event item under its derived listing id, not the catalog id', async () => {
    const derived = 'seller-listing-9f2-abc';
    const snapshot = { productId: derived, qty: 3, reservedQty: 1, availableQty: 2 };
    const inventory = {
      resolveOwnedProductId: vi.fn(async (productId: string) => (
        productId === 'event-demo-01-v2' ? derived : undefined
      )),
      getOwned: vi.fn(async (productId: string) => (productId === derived ? snapshot : undefined)),
      reserveOwned: vi.fn().mockResolvedValue(true),
      releaseOwned: vi.fn().mockResolvedValue(true),
    };
    const invalidations = { invalidate: vi.fn() };
    const controller = new InventoryController(
      inventory as never,
      invalidations as never,
      { requireOwned: vi.fn().mockResolvedValue({ sellerId: 'seller-JHGLDS' }) } as never,
    );
    const body = { sourceKind: 'event', sourceId: 'avi-real-test' } as const;

    await expect(controller.hold('event-demo-01-v2', { ...body, quantity: 1 }, 'demo-avi'))
      .resolves.toMatchObject({ held: true, snapshot });
    await expect(controller.release('event-demo-01-v2', { ...body, quantity: 1 }, 'demo-avi'))
      .resolves.toMatchObject({ released: true, snapshot });

    expect(inventory.reserveOwned).toHaveBeenCalledWith(
      derived, 1, { kind: 'event', id: 'avi-real-test' }, 'seller-JHGLDS', undefined,
    );
    expect(inventory.releaseOwned).toHaveBeenCalledWith(
      derived, 1, { kind: 'event', id: 'avi-real-test' }, 'seller-JHGLDS',
    );
    // The private listing id is what carries the stock, so it is what must be
    // invalidated — invalidating the catalog id leaves the panel showing stale qty.
    expect(invalidations.invalidate).toHaveBeenCalledWith(
      'inventory.snapshot', { productId: derived }, { principal: 'demo-avi' },
    );
  });
});
