import { describe, expect, it, vi } from 'vitest';
import { InventoryController } from './inventory.controller';

describe('InventoryController save', () => {
  it('overwrites authoritative quantity and price and invalidates both shared reads', async () => {
    const snapshot = { productId: 'mug', qty: 8, reservedQty: 2, availableQty: 6, priceCents: 1_500 };
    const inventory = { save: vi.fn().mockResolvedValue(snapshot) };
    const invalidations = { invalidate: vi.fn() };
    const controller = new InventoryController(inventory as never, invalidations as never);

    await expect(controller.save('mug', { quantity: 8, priceCents: 1_500 })).resolves.toEqual({
      saved: true,
      quantity: 8,
      priceCents: 1_500,
      snapshot,
    });
    expect(inventory.save).toHaveBeenCalledWith('mug', 8, 1_500);
    expect(invalidations.invalidate.mock.calls).toEqual([
      ['catalog.page'],
      ['inventory.snapshot', { productId: 'mug' }],
    ]);
  });

  it('rejects invalid saves and reports a missing catalog item', async () => {
    const inventory = { save: vi.fn().mockResolvedValue(undefined) };
    const controller = new InventoryController(inventory as never, { invalidate: vi.fn() } as never);

    await expect(controller.save('mug', { quantity: -1, priceCents: 1_500 })).rejects.toThrow('quantity must be a non-negative integer');
    await expect(controller.save('mug', { quantity: 2, priceCents: -1 })).rejects.toThrow('priceCents must be a non-negative integer');
    await expect(controller.save('missing', { quantity: 2, priceCents: 1_500 })).rejects.toThrow('Inventory item missing was not found');
  });
});
