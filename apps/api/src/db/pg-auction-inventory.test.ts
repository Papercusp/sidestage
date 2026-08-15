import { describe, expect, it, vi } from 'vitest';
import { PgAuctionInventory } from './pg-auction-inventory';

describe('PgAuctionInventory hold lifecycle', () => {
  it('clones metadata and options into one deterministic seller-owned listing', async () => {
    const identity = { id: 'source-1', groupId: 'group-1', region: 'US', optionSignature: 'color=black' };
    const row = { productId: 'seller-listing-id', qty: 3, reservedQty: 0, availableQty: 3, priceCents: 2_500 };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [identity] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [identity] })
      .mockResolvedValueOnce({ rows: [row] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.onboardOwned('source-1', 3, 2_500, 'seller-alpha')).resolves.toEqual(row);
    await expect(inventory.onboardOwned('source-1', 3, 2_500, 'seller-alpha')).resolves.toEqual(row);

    const [firstSql, firstParams] = query.mock.calls[1] as [string, unknown[]];
    const [, secondParams] = query.mock.calls[3] as [string, unknown[]];
    expect(firstSql).toContain('INSERT INTO storefront_product');
    expect(firstSql).toContain('source.variant_images');
    expect(firstSql).toContain('INSERT INTO storefront_product_option');
    expect(firstSql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(firstParams[0]).toBe('source-1');
    expect(firstParams[5]).toBe('seller-alpha');
    expect(firstParams[1]).toBe(secondParams[1]);
    expect(String(firstParams[1])).toMatch(/^seller-listing-[a-f0-9]{12}-[a-f0-9]{24}$/);
    const conflictSet = firstSql.split('ON CONFLICT (id) DO UPDATE')[1]?.split('WHERE')[0] ?? '';
    expect(conflictSet).not.toMatch(/seller_id\s*=/);
  });

  it('returns no listing when the public source does not exist', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.onboardOwned('missing', 1, 100, 'seller-alpha')).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
  });

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

  it('overwrites total stock and price atomically without writing reserved_qty', async () => {
    const row = { productId: 'product-1', qty: 8, reservedQty: 2, availableQty: 6, priceCents: 1_500 };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.save('product-1', 8, 1_500)).resolves.toEqual(row);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('qty = $2');
    expect(sql).toContain('price_cents = $3');
    expect(sql).toContain('reserved_qty <= $2');
    expect(sql).not.toMatch(/SET[\s\S]*reserved_qty\s*=/);
    expect(params).toEqual(['product-1', 8, 1_500, null]);
  });

  it('scopes seller-owned saves to the selected seller', async () => {
    const row = { productId: 'product-1', qty: 8, reservedQty: 2, availableQty: 6, priceCents: 1_500 };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.saveOwned('product-1', 8, 1_500, 'seller-avi')).resolves.toEqual(row);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('seller_id = $4');
    expect(params).toEqual(['product-1', 8, 1_500, 'seller-avi']);
  });

  it('does not reserve another seller\'s product', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.reserveOwned(
      'product-1',
      1,
      { kind: 'event', id: 'event-avi' },
      'seller-avi',
    )).resolves.toBe(false);

    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      'SELECT 1 FROM storefront_product WHERE id = $1 AND seller_id = $2',
      ['product-1', 'seller-avi'],
    );
  });

  it('rejects a total quantity below the current reservation floor', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reservedQty: 2 }] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.save('product-1', 1, 1_500)).rejects.toThrow(
      'Quantity cannot be lower than 2 reserved units',
    );
  });
});
