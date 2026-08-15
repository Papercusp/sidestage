import { describe, expect, it, vi } from 'vitest';
import { InventoryController } from './inventory.controller';

describe('InventoryController save', () => {
  it('overwrites authoritative quantity and price and invalidates both shared reads', async () => {
    const snapshot = { productId: 'mug', qty: 8, reservedQty: 2, availableQty: 6, priceCents: 1_500 };
    const inventory = { saveOwned: vi.fn().mockResolvedValue(snapshot) };
    const invalidations = { invalidate: vi.fn() };
    const ownership = { sellerId: vi.fn().mockReturnValue('seller-avi') };
    const controller = new InventoryController(inventory as never, invalidations as never, ownership as never);

    await expect(controller.save('mug', { quantity: 8, priceCents: 1_500 }, 'demo-avi')).resolves.toEqual({
      saved: true,
      quantity: 8,
      priceCents: 1_500,
      snapshot,
    });
    expect(ownership.sellerId).toHaveBeenCalledWith('demo-avi');
    expect(inventory.saveOwned).toHaveBeenCalledWith('mug', 8, 1_500, 'seller-avi');
    expect(invalidations.invalidate.mock.calls).toEqual([
      ['catalog.page'],
      ['inventory.page', undefined, { principal: 'demo-avi' }],
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
});
