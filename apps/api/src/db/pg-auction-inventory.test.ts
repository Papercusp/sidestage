import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DATABASE_URL } from './database.module';
import { PgAuctionInventory } from './pg-auction-inventory';

describe('PgAuctionInventory hold lifecycle', () => {
  it('clones metadata and options into one deterministic seller-owned listing', async () => {
    const identity = { id: 'source-1', groupId: 'group-1', region: 'US', optionSignature: 'color=black' };
    const row = { productId: 'seller-listing-id', qty: 3, reservedQty: 0, availableQty: 3, priceCents: 2_500 };
    // Each onboardOwned is now THREE queries: resolve the source identity,
    // look for a listing this seller already holds for that identity
    // (EI-20739798038041966), then upsert. No existing listing here.
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [identity] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [identity] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [identity] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.onboardOwned('source-1', 3, 2_500, 'seller-alpha')).resolves.toEqual(row);
    await expect(inventory.onboardOwned('source-1', 3, 2_500, 'seller-alpha')).resolves.toEqual(row);
    await expect(inventory.onboardOwned('source-1', 3, 2_500, 'seller-beta')).resolves.toEqual(row);

    const [firstSql, firstParams] = query.mock.calls[2] as [string, unknown[]];
    const [, secondParams] = query.mock.calls[5] as [string, unknown[]];
    const [, otherSellerParams] = query.mock.calls[8] as [string, unknown[]];
    expect(firstSql).toContain('INSERT INTO storefront_product');
    expect(firstSql).toContain('source.variant_images');
    expect(firstSql).toContain('INSERT INTO storefront_product_option');
    expect(firstSql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(firstParams[0]).toBe('source-1');
    expect(firstParams[5]).toBe('seller-alpha');
    expect(firstParams[1]).toBe(secondParams[1]);
    expect(firstParams[1]).not.toBe(otherSellerParams[1]);
    expect(firstParams[2]).toBe(secondParams[2]);
    expect(firstParams[2]).not.toBe(otherSellerParams[2]);
    expect(String(firstParams[1])).toMatch(/^seller-listing-[a-f0-9]{12}-[a-f0-9]{24}$/);
    expect(String(firstParams[2])).toMatch(/^[a-f0-9]{12}-[a-f0-9]{24}$/);
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

describe.runIf(process.env.SIDESTAGE_PG_INTEGRATION === '1')('PgAuctionInventory against Postgres', () => {
  it('onboards idempotent seller-qualified clones while preserving source ownership and options', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 1 });
    const client = await pool.connect();
    const suffix = randomUUID();
    const groupId = `inventory-onboard-group-${suffix}`;
    const axisId = `inventory-onboard-axis-${suffix}`;
    const valueId = `inventory-onboard-value-${suffix}`;
    const sourceProductId = `inventory-onboard-source-${suffix}`;
    const sellerAlpha = `inventory-onboard-alpha-${suffix}`;
    const sellerBeta = `inventory-onboard-beta-${suffix}`;

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO product_catalog (group_id, region, product_type, title)
         VALUES ($1, 'US', 'KITCHEN', 'Postgres onboarding control')`,
        [groupId],
      );
      await client.query(
        `INSERT INTO product_option_axes (id, group_id, region, slug, label, position, required)
         VALUES ($1, $2, 'US', 'finish', 'Finish', 0, true)`,
        [axisId, groupId],
      );
      await client.query(
        `INSERT INTO product_option_values (id, axis_id, slug, label, position, metadata)
         VALUES ($1, $2, 'matte', 'Matte', 0, '{"swatch":"#202020"}')`,
        [valueId, axisId],
      );
      await client.query(
        `INSERT INTO storefront_product
           (id, slug, region, sku, price_cents, active, group_id, condition, handling,
            option_signature, variant_images, qty, reserved_qty, seller_id)
         VALUES ($1, $1, 'US', $2, 3100, true, $3, 'NEW', 2,
                 'finish=matte', '[{"url":"/control.png","isPrimary":true}]', 7, 0, 'demo-seller')`,
        [sourceProductId, `ONBOARD-CONTROL-${suffix}`, groupId],
      );
      await client.query(
        `INSERT INTO storefront_product_option (variant_id, axis_id, value_id)
         VALUES ($1, $2, $3)`,
        [sourceProductId, axisId, valueId],
      );

      const inventory = new PgAuctionInventory(client as never);
      const first = await inventory.onboardOwned(sourceProductId, 3, 2_500, sellerAlpha);
      const updated = await inventory.onboardOwned(sourceProductId, 5, 2_700, sellerAlpha);
      const otherSeller = await inventory.onboardOwned(sourceProductId, 2, 2_400, sellerBeta);

      // db-apply is deliberately rerunnable. Reapply the real schema after
      // seller-qualified duplicates exist so its legacy convergence block
      // cannot silently rewrite one seller's option signature on a later deploy.
      await client.query(readFileSync(join(__dirname, '../../../../db/schema.sql'), 'utf8'));

      expect(first?.productId).toMatch(/^seller-listing-[a-f0-9]{12}-[a-f0-9]{24}$/);
      expect(updated).toMatchObject({ productId: first?.productId, qty: 5, priceCents: 2_700 });
      expect(otherSeller?.productId).not.toBe(first?.productId);

      const listings = await client.query<{
        id: string;
        sellerId: string;
        qty: number;
        priceCents: number;
        optionSignature: string;
        variantImages: Array<{ url: string; isPrimary: boolean }>;
      }>(
        `SELECT id, seller_id AS "sellerId", qty, price_cents AS "priceCents",
                option_signature AS "optionSignature", variant_images AS "variantImages"
           FROM storefront_product
          WHERE group_id = $1 AND region = 'US'
          ORDER BY seller_id`,
        [groupId],
      );
      expect(listings.rows).toHaveLength(3);
      expect(listings.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: sourceProductId,
          sellerId: 'demo-seller',
          qty: 7,
          priceCents: 3_100,
          optionSignature: 'finish=matte',
        }),
        expect.objectContaining({
          id: first?.productId,
          sellerId: sellerAlpha,
          qty: 5,
          priceCents: 2_700,
          variantImages: [{ url: '/control.png', isPrimary: true }],
        }),
        expect.objectContaining({
          id: otherSeller?.productId,
          sellerId: sellerBeta,
          qty: 2,
          priceCents: 2_400,
          optionSignature: 'finish=matte',
        }),
      ]));

      const copiedOptions = await client.query<{ variantId: string; axisId: string; valueId: string }>(
        `SELECT variant_id AS "variantId", axis_id AS "axisId", value_id AS "valueId"
           FROM storefront_product_option
          WHERE variant_id = ANY($1::text[])
          ORDER BY variant_id`,
        [[first?.productId, otherSeller?.productId]],
      );
      expect(copiedOptions.rows).toEqual([
        { variantId: first?.productId, axisId, valueId },
        { variantId: otherSeller?.productId, axisId, valueId },
      ].sort((left, right) => String(left.variantId).localeCompare(String(right.variantId))));
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 45_000);
});
