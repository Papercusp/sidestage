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

  /**
   * EI-20899380417535875 — reserve_inventory() computed availableQty and
   * raised for insufficient stock BEFORE reaching its ON CONFLICT upsert, so
   * an exact retry of a source's own hold was compared against the FULL
   * requested quantity rather than the incremental amount beyond what that
   * source already held. Reproduced 2026-08-19: a variant with
   * availableQty=76, first reserve_inventory(...76) succeeds and drives
   * availableQty to 0, and the identical second call then raised
   * "insufficient inventory ... requested 76, available 0" even though the
   * upsert underneath would have been a no-op. The operation was safe
   * (UNIQUE(source_kind, source_id, variant_id) still prevented a duplicate
   * row / oversell) but not retry-idempotent, which breaks any caller that
   * retries a timed-out or ambiguous reserve() call.
   */
  it('reserve_inventory is retry-idempotent even when the first hold consumes all stock', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 1 });
    const client = await pool.connect();
    const suffix = randomUUID();
    const variantId = `reserve-retry-${suffix}`;
    const source = { kind: 'cart', id: `cart-${suffix}` };

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO storefront_product (id, slug, region, sku, price_cents, active, qty, reserved_qty, seller_id)
         VALUES ($1, $1, 'US', $2, 1000, true, 76, 0, 'demo-seller')`,
        [variantId, `RESERVE-RETRY-${suffix}`],
      );

      const inventory = new PgAuctionInventory(client as never);

      await expect(inventory.reserve(variantId, 76, source)).resolves.toBe(true);
      const afterFirst = await client.query<{ availableQty: number }>(
        'SELECT "availableQty" FROM storefront_product WHERE id = $1',
        [variantId],
      );
      expect(afterFirst.rows[0]?.availableQty).toBe(0);

      // The exact retry: same source, same quantity, no stock left. Must
      // succeed as a no-op, not be rejected as insufficient inventory.
      await expect(inventory.reserve(variantId, 76, source)).resolves.toBe(true);

      const afterRetry = await client.query<{ availableQty: number; reservedQty: number }>(
        'SELECT "availableQty", reserved_qty AS "reservedQty" FROM storefront_product WHERE id = $1',
        [variantId],
      );
      expect(afterRetry.rows[0]).toEqual({ availableQty: 0, reservedQty: 76 });

      const reservationRows = await client.query<{ quantity: number; state: string }>(
        'SELECT quantity, state FROM inventory_reservation WHERE variant_id = $1 AND source_kind = $2 AND source_id = $3',
        [variantId, source.kind, source.id],
      );
      expect(reservationRows.rows).toEqual([{ quantity: 76, state: 'held' }]);

      // Control: a DIFFERENT source is still correctly rejected -- the fix
      // must not weaken the real oversell protection. A rejected
      // reserve_inventory() call RAISEs, which poisons the rest of this
      // Postgres transaction (25P02) unless rolled back to a savepoint --
      // reserve()'s catch only swallows the "insufficient inventory" error
      // itself, not that follow-on abort.
      await client.query('SAVEPOINT before_other_source');
      await expect(
        inventory.reserve(variantId, 1, { kind: 'cart', id: `cart-other-${suffix}` }),
      ).resolves.toBe(false);
      await client.query('ROLLBACK TO SAVEPOINT before_other_source');

      // Control: growing the SAME source's hold beyond what is actually
      // available is still correctly rejected -- only an exact-or-shrinking
      // retry is a no-op, not an unbounded resize.
      await client.query('SAVEPOINT before_grow');
      await expect(inventory.reserve(variantId, 77, source)).resolves.toBe(false);
      await client.query('ROLLBACK TO SAVEPOINT before_grow');

      // Control: shrinking the SAME source's hold frees the difference.
      await expect(inventory.reserve(variantId, 30, source)).resolves.toBe(true);
      const afterShrink = await client.query<{ availableQty: number; reservedQty: number }>(
        'SELECT "availableQty", reserved_qty AS "reservedQty" FROM storefront_product WHERE id = $1',
        [variantId],
      );
      expect(afterShrink.rows[0]).toEqual({ availableQty: 46, reservedQty: 30 });
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }, 45_000);
});

/**
 * EI-20739798038041966 — `POST /inventory/:sourceProductId/onboard` answered
 * **500 Internal server error** on production (2026-08-19, measured against
 * sidestage.papercusp.com).
 *
 * The upsert guards only `ON CONFLICT (id)`, and the derived listing id is a
 * function of exactly (seller, group, region, signature) — the same tuple
 * `storefront_product_seller_group_signature_unique` covers. So a re-onboard
 * collides on the PRIMARY KEY and is absorbed... unless a row already holds that
 * natural key under a DIFFERENT id, which is true of every hand-seeded listing
 * (prod: `sidestage-onboarding-harbor-kettle-v1`). Then the driver raised a bare
 * 23505 and Nest rendered "the server is broken" for "you already stock this".
 */
describe('onboardOwned is idempotent against a listing the seller already holds', () => {
  const identity = { id: 'source-9', groupId: 'group-9', region: 'US', optionSignature: 'base' };
  const row = { productId: 'seeded-legacy-id', qty: 25, reservedQty: 0, availableQty: 25, priceCents: 7_400 };

  it('targets the EXISTING row id rather than minting a colliding one', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [identity] })
      // The seller already stocks this product identity under a seeded id.
      .mockResolvedValueOnce({ rows: [{ id: 'seeded-legacy-id' }] })
      .mockResolvedValueOnce({ rows: [row] });
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.onboardOwned('source-9', 25, 7_400, 'demo-seller')).resolves.toEqual(row);

    const [lookupSql, lookupParams] = query.mock.calls[1] as [string, unknown[]];
    expect(lookupSql).toContain('option_signature');
    expect(lookupParams).toEqual(['demo-seller', 'group-9', 'US', 'base']);

    const [, upsertParams] = query.mock.calls[2] as [string, unknown[]];
    // $2 is the target id. It must be the row that already exists, NOT a fresh
    // derived id — using the derived id is precisely what raised 23505.
    expect(upsertParams[1]).toBe('seeded-legacy-id');
  });

  it('control: with NO existing row it still derives the deterministic listing id', async () => {
    // Without this the fix could "work" by always reusing something, and the
    // deterministic-id property the hold path depends on would be untested.
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [identity] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    const inventory = new PgAuctionInventory({ query } as never);

    await inventory.onboardOwned('source-9', 25, 7_400, 'demo-seller');

    const [, upsertParams] = query.mock.calls[2] as [string, unknown[]];
    expect(String(upsertParams[1])).toMatch(/^seller-listing-[a-f0-9]{12}-[a-f0-9]{24}$/);
  });

  it('reports a residual unique violation as 409, never letting a 23505 become a 500', async () => {
    const violation = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [identity] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(violation);
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.onboardOwned('source-9', 25, 7_400, 'demo-seller'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('control: a NON-unique database failure still propagates unchanged', async () => {
    // A 409 for everything would hide real outages behind a client-error code.
    const outage = Object.assign(new Error('connection terminated'), { code: '08006' });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [identity] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(outage);
    const inventory = new PgAuctionInventory({ query } as never);

    await expect(inventory.onboardOwned('source-9', 25, 7_400, 'demo-seller'))
      .rejects.toThrow('connection terminated');
  });
});
