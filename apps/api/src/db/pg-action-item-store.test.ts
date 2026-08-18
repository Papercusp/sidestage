import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { ActionItemDraft } from '../actions/action-item.store';
import { DEFAULT_DATABASE_URL } from './database.module';
import { PgActionItemStore } from './pg-action-item-store';

type QueryResult = { rows: unknown[] };
type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>;

function draft(eventId: string, productId: string, overrides: Partial<ActionItemDraft> = {}): ActionItemDraft {
  return {
    eventId,
    eventItemId: `${eventId}:${productId}`,
    productId,
    position: 0,
    referencePriceCents: 1_500,
    priceCents: 1_500,
    quantity: 5,
    availableQty: 5,
    stageState: 'queued',
    onStage: false,
    title: 'Blue mug',
    attributes: { color: 'blue' },
    ...overrides,
  };
}

function transactionalPool(handler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params));
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as never, connect, query, release };
}

describe('PgActionItemStore transaction boundary', () => {
  it('locks the parent event before reading or upserting lineup rows', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('FROM event\n')) return { rows: [{ event_id: 'event-1' }] };
      return { rows: [] };
    });

    await new PgActionItemStore(harness.pool).register('event-1', [draft('event-1', 'mug')]);

    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements).toEqual([
      'BEGIN',
      expect.stringMatching(/SELECT event_id FROM event WHERE event_id = \$1 FOR UPDATE/),
      expect.stringMatching(/SELECT .* FROM event_lineup_item .* FOR UPDATE/),
      expect.stringContaining('INSERT INTO event_lineup_item'),
      expect.stringMatching(/SELECT .* FROM event_lineup_item .* ORDER BY position/),
      'COMMIT',
    ]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('rolls back the whole registration when the event does not exist', async () => {
    const harness = transactionalPool(() => ({ rows: [] }));

    await expect(new PgActionItemStore(harness.pool).register('missing', [draft('missing', 'mug')]))
      .rejects.toThrow('Event was not found');
    expect(harness.query.mock.calls.map(([sql]) => sql.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('SELECT event_id'),
      'ROLLBACK',
    ]);
    expect(harness.release).toHaveBeenCalledOnce();
  });
});

/**
 * WI-39837 — "Take live" 500'd on `event_lineup_item_one_on_stage`.
 *
 * The index is PARTIAL UNIQUE, so it is checked per-statement and cannot be
 * deferred; a stage handover applied claim-first leaves two rows on stage for
 * the length of one statement, which is all it takes to raise 23505. The store
 * — not the caller — owns the ordering, so the guard lives here.
 */
describe('PgActionItemStore stage handover ordering', () => {
  function row(overrides: Record<string, unknown>) {
    return {
      event_item_id: 'event-1:mug',
      event_id: 'event-1',
      product_id: 'mug',
      position: 0,
      reference_price_cents: 1_500,
      current_price_cents: 1_500,
      listed_quantity: 5,
      current_quantity: 5,
      stage_state: 'queued',
      title: 'Blue mug',
      description: null,
      attributes: {},
      version: 1,
      created_at: '2026-08-18T00:00:00.000Z',
      updated_at: '2026-08-18T00:00:00.000Z',
      ...overrides,
    };
  }

  /** Two lineup rows: `onStageProduct` holds the stage, `queuedProduct` waits. */
  function handoverPool() {
    const lineup = [
      row({ event_item_id: 'event-1:bearing', product_id: 'bearing', stage_state: 'on-stage', position: 0 }),
      row({ event_item_id: 'event-1:mug', product_id: 'mug', stage_state: 'queued', position: 1 }),
    ];
    return transactionalPool((sql, params) => {
      if (sql.includes('FROM event\n')) return { rows: [{ event_id: 'event-1' }] };
      if (sql.startsWith('UPDATE event_lineup_item')) {
        return { rows: [row({ product_id: String(params?.[1]), stage_state: String(params?.[6]), version: 2 })] };
      }
      return { rows: lineup };
    });
  }

  /** The change set applyOnce builds for a push: the CLAIM first, release after. */
  function pushChanges() {
    return [
      {
        expectedVersion: 1,
        item: { ...draft('event-1', 'mug'), stageState: 'on-stage' as const, onStage: true },
      },
      {
        expectedVersion: 1,
        item: { ...draft('event-1', 'bearing'), stageState: 'queued' as const, onStage: false },
      },
    ];
  }

  it('applies the stage RELEASE before the stage CLAIM, whatever order the caller sent', async () => {
    const harness = handoverPool();

    await new PgActionItemStore(harness.pool).write('event-1', pushChanges());

    const updates = harness.query.mock.calls
      .filter(([sql]) => String(sql).startsWith('UPDATE event_lineup_item'))
      .map(([, params]) => ({ productId: (params as unknown[])[1], stageState: (params as unknown[])[6] }));
    expect(updates).toEqual([
      { productId: 'bearing', stageState: 'queued' },
      { productId: 'mug', stageState: 'on-stage' },
    ]);
  });

  it('reports a one-on-stage violation as a conflict, never as a server fault', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('FROM event\n')) return { rows: [{ event_id: 'event-1' }] };
      if (sql.startsWith('UPDATE event_lineup_item')) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'event_lineup_item_one_on_stage',
        });
      }
      return { rows: [row({ product_id: 'mug', stage_state: 'queued' })] };
    });

    await expect(new PgActionItemStore(harness.pool).write('event-1', [{
      expectedVersion: 1,
      item: { ...draft('event-1', 'mug'), stageState: 'on-stage' as const, onStage: true },
    }])).rejects.toBeInstanceOf(ConflictException);
  });
});

describe.runIf(process.env.SIDESTAGE_PG_INTEGRATION === '1')('PgActionItemStore against Postgres', () => {
  it('survives a store restart and rejects a stale cross-process write', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 3 });
    const suffix = randomUUID();
    const eventId = `lineup-test-event-${suffix}`;
    const productId = `lineup-test-product-${suffix}`;

    try {
      await pool.query(
        `INSERT INTO storefront_product
           (id, slug, sku, price_cents, qty, reserved_qty, seller_id)
         VALUES ($1, $1, $1, 1500, 5, 0, 'seller-demo')`,
        [productId],
      );
      await pool.query(
        `INSERT INTO event (event_id, title, seller_id, seller_name, status)
         VALUES ($1, 'Lineup test event', 'seller-demo', 'Demo Seller', 'live')`,
        [eventId],
      );

      const firstProcess = new PgActionItemStore(pool);
      const [registered] = await firstProcess.register(eventId, [draft(eventId, productId)]);
      expect(registered).toMatchObject({
        eventItemId: `${eventId}:${productId}`,
        referencePriceCents: 1_500,
        version: 1,
      });

      const restartedProcess = new PgActionItemStore(pool);
      await expect(restartedProcess.list(eventId)).resolves.toMatchObject([
        { productId, priceCents: 1_500, availableQty: 5, version: 1 },
      ]);
      const [updated] = await restartedProcess.write(eventId, [{
        expectedVersion: registered!.version,
        item: { ...registered!, priceCents: 1_250, availableQty: 4 },
      }]);
      expect(updated).toMatchObject({ priceCents: 1_250, availableQty: 4, version: 2 });

      await expect(firstProcess.write(eventId, [{
        expectedVersion: registered!.version,
        item: { ...registered!, priceCents: 1_100 },
      }])).rejects.toBeInstanceOf(ConflictException);
      await expect(firstProcess.list(eventId)).resolves.toMatchObject([
        { priceCents: 1_250, availableQty: 4, version: 2 },
      ]);
    } finally {
      await pool.query('DELETE FROM event WHERE event_id = $1', [eventId]);
      await pool.query('DELETE FROM storefront_product WHERE id = $1', [productId]);
      await pool.end();
    }
  });
});
