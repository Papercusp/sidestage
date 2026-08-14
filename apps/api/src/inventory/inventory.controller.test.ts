import { describe, expect, it, vi } from 'vitest';
import { InventoryController } from './inventory.controller';

describe('InventoryController restock', () => {
  it('restocks through the inventory authority and invalidates both shared reads', async () => {
    const snapshot = { productId: 'mug', qty: 8, reservedQty: 2, availableQty: 6, priceCents: 1_500 };
    const inventory = { restock: vi.fn().mockResolvedValue(snapshot) };
    const invalidations = { invalidate: vi.fn() };
    const controller = new InventoryController(inventory as never, invalidations as never);

    await expect(controller.restock('mug', { quantity: 3, priceCents: 1_500 })).resolves.toEqual({
      restocked: true,
      quantity: 3,
      snapshot,
    });
    expect(inventory.restock).toHaveBeenCalledWith('mug', 3, 1_500);
    expect(invalidations.invalidate.mock.calls).toEqual([
      ['catalog.page'],
      ['inventory.snapshot', { productId: 'mug' }],
    ]);
  });

  it('rejects invalid intake and reports a missing catalog item', async () => {
    const inventory = { restock: vi.fn().mockResolvedValue(undefined) };
    const controller = new InventoryController(inventory as never, { invalidate: vi.fn() } as never);

    await expect(controller.restock('mug', { quantity: 0 })).rejects.toThrow('quantity must be a positive integer');
    await expect(controller.restock('mug', { quantity: 2, priceCents: -1 })).rejects.toThrow('priceCents must be a non-negative integer');
    await expect(controller.restock('missing', { quantity: 2 })).rejects.toThrow('Inventory item missing was not found');
  });
});
