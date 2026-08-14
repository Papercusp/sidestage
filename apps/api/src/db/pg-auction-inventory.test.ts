import { describe, expect, it, vi } from 'vitest';
import { PgAuctionInventory } from './pg-auction-inventory';

describe('PgAuctionInventory hold lifecycle', () => {
  it('sweeps expired rows before reads/reserves and forwards the server deadline', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.reserve(
      'product-1',
      1,
      { kind: 'cart', id: 'cart-1' },
      '2026-08-14T06:02:00.000Z',
    )).resolves.toBe(true);

    expect(query.mock.calls[0]?.[0]).toBe('SELECT expire_inventory_reservations()');
    expect(query.mock.calls[1]).toEqual([
      'SELECT reserve_inventory($1, $2, $3, $4, $5)',
      ['product-1', 'cart', 'cart-1', 1, '2026-08-14T06:02:00.000Z'],
    ]);
  });

  it('commits the cart-scoped reservation through the database primitive', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ committed: true }] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.commit('product-1', { kind: 'cart', id: 'cart-1' })).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      'SELECT commit_inventory($1, $2, $3) AS committed',
      ['cart', 'cart-1', 'product-1'],
    );
  });
});
