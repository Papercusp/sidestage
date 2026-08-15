import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { emptyCart, type Cart, type EventCartHoldInput } from '../cart/cart.service';
import { DEFAULT_DATABASE_URL } from './database.module';
import { PgCartStore } from './pg-cart-store';

type QueryResult = { rows: unknown[] };
type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>;

function transactionalPool(handler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params));
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as never, connect, query, release };
}

function holdInput(overrides: Partial<EventCartHoldInput> = {}): EventCartHoldInput {
  return {
    cartId: 'cart-1',
    eventId: 'event-1',
    eventItemId: 'item-1',
    productId: 'product-1',
    quantity: 1,
    expiresAt: '2099-08-14T18:15:00.000Z',
    idempotencyKey: 'hold-1',
    imageUrl: '/client-image.webp',
    ...overrides,
  };
}

function lineupRow(currentQuantity = 3) {
  return {
    event_id: 'event-1',
    event_item_id: 'item-1',
    product_id: 'product-1',
    title: 'Authoritative title',
    current_price_cents: 1_500,
    current_quantity: currentQuantity,
  };
}

describe('PgCartStore event hold transaction', () => {
  it('writes lineup, inventory reservation, and server-priced cart in one transaction', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('SELECT payload FROM cart')) return { rows: [{ payload: emptyCart('cart-1') }] };
      if (sql.includes('FROM storefront_product')) return { rows: [{ available_qty: 3 }] };
      if (sql.includes('FROM inventory_reservation')) return { rows: [] };
      if (sql.includes('FROM event_lineup_item AS item')) return { rows: [lineupRow()] };
      return { rows: [] };
    });

    const held = await new PgCartStore(harness.pool).holdEventItem(holdInput());

    expect(held).toMatchObject({
      id: 'cart-1',
      subtotalCents: 1_500,
      eventHoldKeys: ['hold-1'],
      items: [{
        eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1',
        title: 'Authoritative title', priceCents: 1_500, quantity: 1,
      }],
    });
    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO cart'),
      'SELECT payload FROM cart WHERE id = $1 FOR UPDATE',
      expect.stringContaining('FROM event_lineup_item AS item'),
      expect.stringContaining('FROM storefront_product'),
      expect.stringContaining('FROM inventory_reservation'),
      expect.stringContaining('FROM event_lineup_item AS item'),
      expect.stringContaining('UPDATE event_lineup_item'),
      expect.stringContaining('INSERT INTO inventory_reservation'),
      'UPDATE cart SET payload = $2::jsonb, updated_at = now() WHERE id = $1',
      'COMMIT',
    ]);
    expect(harness.query.mock.calls[7]?.[1]).toEqual(['event-1', 'item-1', 'product-1', 1]);
    expect(harness.query.mock.calls[8]?.[1]).toEqual([
      'product-1', 'cart-1', 1, '2099-08-14T18:15:00.000Z',
    ]);
    const persisted = JSON.parse(String(harness.query.mock.calls[9]?.[1]?.[1])) as Cart;
    expect(persisted.items[0]).toMatchObject({ title: 'Authoritative title', priceCents: 1_500 });
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('returns the locked aggregate for a replay without applying another allocation delta', async () => {
    const existing: Cart = {
      ...emptyCart('cart-1'),
      eventHoldKeys: ['hold-1'],
      items: [{
        eventId: 'event-1', eventItemId: 'item-1', productId: 'product-1',
        title: 'Authoritative title', priceCents: 1_500, quantity: 1,
      }],
      subtotalCents: 1_500,
    };
    const harness = transactionalPool((sql) => (
      sql.includes('SELECT payload FROM cart') ? { rows: [{ payload: existing }] } : { rows: [] }
    ));

    await expect(new PgCartStore(harness.pool).holdEventItem(holdInput())).resolves.toEqual(existing);
    expect(harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim())).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO cart'),
      'SELECT payload FROM cart WHERE id = $1 FOR UPDATE',
      'COMMIT',
    ]);
  });

  it('rolls back before any event or cart write when physical stock cannot cover the delta', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('SELECT payload FROM cart')) return { rows: [{ payload: emptyCart('cart-1') }] };
      if (sql.includes('FROM event_lineup_item AS item')) return { rows: [lineupRow()] };
      if (sql.includes('FROM storefront_product')) return { rows: [{ available_qty: 0 }] };
      if (sql.includes('FROM inventory_reservation')) return { rows: [] };
      return { rows: [] };
    });

    await expect(new PgCartStore(harness.pool).holdEventItem(holdInput()))
      .rejects.toThrow('Insufficient available quantity for product-1');
    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((sql) => sql.startsWith('UPDATE event_lineup_item'))).toBe(false);
    expect(statements.some((sql) => sql.startsWith('UPDATE cart'))).toBe(false);
  });

  it('rolls back the physical/cart side when event allocation is exhausted', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('SELECT payload FROM cart')) return { rows: [{ payload: emptyCart('cart-1') }] };
      if (sql.includes('FROM storefront_product')) return { rows: [{ available_qty: 3 }] };
      if (sql.includes('FROM inventory_reservation')) return { rows: [] };
      if (sql.includes('FROM event_lineup_item AS item')) return { rows: [lineupRow(0)] };
      return { rows: [] };
    });

    await expect(new PgCartStore(harness.pool).holdEventItem(holdInput()))
      .rejects.toThrow('Insufficient event allocation for item-1');
    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((sql) => sql.startsWith('INSERT INTO inventory_reservation'))).toBe(false);
    expect(statements.some((sql) => sql.startsWith('UPDATE cart'))).toBe(false);
  });

  it('rejects a hidden event tuple before reading physical stock', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('SELECT payload FROM cart')) return { rows: [{ payload: emptyCart('cart-1') }] };
      if (sql.includes('FROM event_lineup_item AS item')) return { rows: [] };
      if (sql.includes('FROM storefront_product')) return { rows: [{ available_qty: 0 }] };
      return { rows: [] };
    });

    await expect(new PgCartStore(harness.pool).holdEventItem(holdInput()))
      .rejects.toThrow('Event item is not available');
    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.some((sql) => sql.includes('FROM storefront_product'))).toBe(false);
    expect(statements.some((sql) => sql.startsWith('UPDATE event_lineup_item'))).toBe(false);
  });
});

describe.runIf(process.env.SIDESTAGE_PG_INTEGRATION === '1')('PgCartStore against Postgres', () => {
  it('survives restart, deduplicates a replay, and rejects a second cart after allocation is consumed', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 3 });
    const suffix = randomUUID();
    const eventId = `cart-test-event-${suffix}`;
    const eventItemId = `cart-test-item-${suffix}`;
    const productId = `cart-test-product-${suffix}`;
    const cartId = `cart-test-${suffix}`;
    const secondCartId = `cart-test-other-${suffix}`;
    const input = holdInput({
      cartId, eventId, eventItemId, productId, quantity: 2, idempotencyKey: `hold-${suffix}`,
    });

    try {
      await pool.query(
        `INSERT INTO storefront_product
           (id, slug, region, sku, price_cents, active, qty, reserved_qty)
         VALUES ($1, $1, 'US', $2, 9999, true, 2, 0)`,
        [productId, `CART-TEST-${suffix}`],
      );
      await pool.query(
        `INSERT INTO event (event_id, title, seller_id, seller_name, status)
         VALUES ($1, 'Cart test event', $2, 'Cart Test Seller', 'live')`,
        [eventId, `seller-${suffix}`],
      );
      await pool.query(
        `INSERT INTO event_lineup_item
           (event_item_id, event_id, product_id, position,
            reference_price_cents, current_price_cents,
            listed_quantity, current_quantity, stage_state, title)
         VALUES ($1, $2, $3, 0, 2000, 1500, 2, 2, 'on-stage', 'Event-priced mug')`,
        [eventItemId, eventId, productId],
      );

      const firstProcess = new PgCartStore(pool);
      await expect(firstProcess.holdEventItem(input)).resolves.toMatchObject({
        subtotalCents: 3_000,
        items: [{ priceCents: 1_500, quantity: 2 }],
      });
      await expect(firstProcess.holdEventItem(input)).resolves.toMatchObject({ subtotalCents: 3_000 });

      const restarted = new PgCartStore(pool);
      await expect(restarted.get(cartId)).resolves.toMatchObject({
        eventHoldKeys: [input.idempotencyKey],
        items: [{ eventId, eventItemId, productId, quantity: 2 }],
      });
      await expect(restarted.holdEventItem({
        ...input, cartId: secondCartId, quantity: 1, idempotencyKey: `other-${suffix}`,
      })).rejects.toThrow(/Insufficient (available quantity|event allocation)/);
      await expect(pool.query<{ current_quantity: number }>(
        'SELECT current_quantity FROM event_lineup_item WHERE event_item_id = $1',
        [eventItemId],
      )).resolves.toMatchObject({ rows: [{ current_quantity: 0 }] });
      await expect(pool.query<{ quantity: number; state: string }>(
        `SELECT quantity, state FROM inventory_reservation
          WHERE source_kind = 'cart' AND source_id = $1 AND variant_id = $2`,
        [cartId, productId],
      )).resolves.toMatchObject({ rows: [{ quantity: 2, state: 'held' }] });
    } finally {
      await pool.query('DELETE FROM cart WHERE id = ANY($1::text[])', [[cartId, secondCartId]]);
      await pool.query("DELETE FROM inventory_reservation WHERE source_kind = 'cart' AND source_id = ANY($1::text[])", [[cartId, secondCartId]]);
      await pool.query('DELETE FROM event_lineup_item WHERE event_item_id = $1', [eventItemId]);
      await pool.query('DELETE FROM storefront_product WHERE id = $1', [productId]);
      await pool.query('DELETE FROM event WHERE event_id = $1', [eventId]);
      await pool.end();
    }
  });
});
