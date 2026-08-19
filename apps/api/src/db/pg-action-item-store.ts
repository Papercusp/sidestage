import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type {
  ActionItemChange,
  ActionItemDraft,
  ActionItemStore,
  StoredActionEventItem,
} from '../actions/action-item.store';
import type { ActionItemStageState } from '../actions/action.types';

interface ActionItemRow {
  event_item_id: string;
  event_id: string;
  product_id: string;
  position: number;
  reference_price_cents: number;
  current_price_cents: number;
  listed_quantity: number;
  current_quantity: number;
  stage_state: ActionItemStageState;
  title: string;
  description: string | null;
  attributes: Record<string, string | number | boolean> | string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

const SELECT_COLUMNS = `event_item_id, event_id, product_id, position,
  reference_price_cents, current_price_cents, listed_quantity, current_quantity,
  stage_state, title, description, attributes, version, created_at, updated_at`;

/**
 * D-026: the sync contract's timestamp encoding is integer epoch milliseconds.
 * Every write here sets the column with SQL `now()`, and the column is
 * `timestamptz(3)`, so Postgres truncates to the millisecond and this decode is
 * integral for the same reason the replicated value is.
 */
function epochMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function mapRow(row: ActionItemRow): StoredActionEventItem {
  const attributes = typeof row.attributes === 'string'
    ? JSON.parse(row.attributes) as Record<string, string | number | boolean>
    : row.attributes;
  return {
    eventItemId: row.event_item_id,
    eventId: row.event_id,
    productId: row.product_id,
    position: row.position,
    referencePriceCents: row.reference_price_cents,
    priceCents: row.current_price_cents,
    quantity: row.listed_quantity,
    availableQty: row.current_quantity,
    stageState: row.stage_state,
    onStage: row.stage_state === 'on-stage',
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    attributes: { ...attributes },
    version: Number(row.version),
    createdAt: epochMillis(row.created_at),
    updatedAt: epochMillis(row.updated_at),
  };
}

function postgresCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function postgresConstraint(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'constraint' in error && typeof error.constraint === 'string'
    ? error.constraint
    : undefined;
}

/** db/schema.sql:892 — UNIQUE (event_id) WHERE stage_state = 'on-stage'. */
const ONE_ON_STAGE_INDEX = 'event_lineup_item_one_on_stage';

/** Postgres production authority for event lineup items. */
export class PgActionItemStore implements ActionItemStore {
  constructor(private readonly pool: Pool) {}

  async list(eventId: string): Promise<StoredActionEventItem[]> {
    const result = await this.pool.query<ActionItemRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM event_lineup_item
        WHERE event_id = $1
        ORDER BY position, event_item_id`,
      [eventId],
    );
    return result.rows.map(mapRow);
  }

  async register(eventId: string, items: readonly ActionItemDraft[]): Promise<StoredActionEventItem[]> {
    try {
      return await this.transaction(async (client) => {
        await this.lockEvent(client, eventId);
        if (items.filter((item) => item.stageState === 'on-stage').length > 1) {
          throw new ConflictException('Only one lineup item may be on stage for an event');
        }
        if (items.some((item) => item.stageState === 'on-stage')) {
          await client.query(
            `UPDATE event_lineup_item
                SET stage_state = 'queued', version = version + 1, updated_at = now()
              WHERE event_id = $1 AND stage_state = 'on-stage'`,
            [eventId],
          );
        }
        for (const item of items) {
          if (item.eventId !== eventId) throw new ConflictException('Lineup item belongs to another event');
          await client.query(
            `INSERT INTO event_lineup_item
               (event_item_id, event_id, product_id, position,
                reference_price_cents, current_price_cents,
                listed_quantity, current_quantity, stage_state,
                title, description, attributes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
             ON CONFLICT (event_id, product_id) DO UPDATE
               SET position = EXCLUDED.position,
                   current_price_cents = EXCLUDED.current_price_cents,
                   listed_quantity = EXCLUDED.listed_quantity,
                   current_quantity = EXCLUDED.current_quantity,
                   stage_state = EXCLUDED.stage_state,
                   title = EXCLUDED.title,
                   description = EXCLUDED.description,
                   attributes = EXCLUDED.attributes,
                   version = event_lineup_item.version + 1,
                   updated_at = now()`,
            this.params(item),
          );
        }
        return this.listWith(client, eventId);
      });
    } catch (error) {
      if (postgresCode(error) === '23505') throw new ConflictException('Event lineup identity conflicts with an existing item');
      if (postgresCode(error) === '23503') throw new NotFoundException('Event or catalog product was not found');
      throw error;
    }
  }

  async write(eventId: string, changes: readonly ActionItemChange[]): Promise<StoredActionEventItem[]> {
    try {
      return await this.writeWithin(eventId, changes);
    } catch (error) {
      /*
       * A raw 23505 escaping this method reaches the seller as Nest's bare
       * "Internal server error" (WI-39837). The stage handover below makes that
       * unreachable, but the mapping stays as the backstop: a lineup write is a
       * CONFLICT, never a server fault, and the seller is entitled to be told
       * which.
       */
      if (postgresCode(error) === '23505') {
        throw new ConflictException(
          postgresConstraint(error) === ONE_ON_STAGE_INDEX
            ? 'Only one lineup item may be on stage for an event'
            : 'Event lineup write conflicts with an existing item',
        );
      }
      throw error;
    }
  }

  private async writeWithin(eventId: string, changes: readonly ActionItemChange[]): Promise<StoredActionEventItem[]> {
    return this.transaction(async (client) => {
      const current = await this.lockEvent(client, eventId);
      const byProduct = new Map(current.map((item) => [item.productId, item]));
      const projected = new Map(current.map((item) => [item.productId, item]));
      for (const change of changes) {
        const found = byProduct.get(change.item.productId);
        if (!found) throw new NotFoundException(`Event item ${change.item.productId} was not found`);
        if (found.version !== change.expectedVersion) {
          throw new ConflictException(`Event item ${change.item.productId} changed; reload the lineup and retry`);
        }
        projected.set(change.item.productId, {
          ...found,
          ...change.item,
          eventItemId: found.eventItemId,
          referencePriceCents: found.referencePriceCents,
          position: found.position,
          version: found.version + 1,
        });
      }
      if ([...projected.values()].filter((item) => item.stageState === 'on-stage').length > 1) {
        throw new ConflictException('Only one lineup item may be on stage for an event');
      }
      /*
       * ONE SAFE ORDER, and the caller does not supply it.
       *
       * `event_lineup_item_one_on_stage` is a partial UNIQUE INDEX, so Postgres
       * checks it per-statement and it cannot be deferred (only CONSTRAINTS
       * defer, and a partial unique index cannot be declared as one). A change
       * set that hands the stage from one item to another is therefore only
       * applicable RELEASE-FIRST: claiming first leaves two rows at
       * stage_state = 'on-stage' for the length of one statement, which is all
       * the index needs to raise 23505.
       *
       * That is exactly what "Take live" did (WI-39837): applyOnce builds
       * [the pushed item (claim), ...clear-the-previous-stage (release)] and
       * this loop applied it verbatim. Ordering here rather than at the caller
       * makes the invariant a property of the store — the layer that knows the
       * index exists — so a future caller cannot reintroduce the 500 by
       * assembling its change set in the natural reading order.
       *
       * `sort` is stable, so changes of equal rank keep the caller's order.
       */
      const stageRank = (change: ActionItemChange): number => {
        const before = byProduct.get(change.item.productId)?.stageState;
        const after = change.item.stageState;
        if (before === 'on-stage' && after !== 'on-stage') return 0;
        if (before !== 'on-stage' && after === 'on-stage') return 2;
        return 1;
      };
      const ordered = [...changes].sort((left, right) => stageRank(left) - stageRank(right));
      for (const change of ordered) {
        const result = await client.query<ActionItemRow>(
          `UPDATE event_lineup_item
              SET current_price_cents = $4,
                  listed_quantity = $5,
                  current_quantity = $6,
                  stage_state = $7,
                  title = $8,
                  description = $9,
                  attributes = $10::jsonb,
                  version = version + 1,
                  updated_at = now()
            WHERE event_id = $1 AND product_id = $2 AND version = $3
        RETURNING ${SELECT_COLUMNS}`,
          [
            eventId,
            change.item.productId,
            change.expectedVersion,
            change.item.priceCents,
            change.item.quantity,
            change.item.availableQty,
            change.item.stageState,
            change.item.title,
            change.item.description ?? null,
            JSON.stringify(change.item.attributes),
          ],
        );
        if (result.rows.length !== 1) {
          throw new ConflictException(`Event item ${change.item.productId} changed; reload the lineup and retry`);
        }
      }
      return this.listWith(client, eventId);
    });
  }

  private params(item: ActionItemDraft): unknown[] {
    return [
      item.eventItemId,
      item.eventId,
      item.productId,
      item.position,
      item.referencePriceCents,
      item.priceCents,
      item.quantity,
      item.availableQty,
      item.stageState,
      item.title,
      item.description ?? null,
      JSON.stringify(item.attributes),
    ];
  }

  private async lockEvent(client: PoolClient, eventId: string): Promise<StoredActionEventItem[]> {
    const event = await client.query<{ event_id: string }>(
      `SELECT event_id
         FROM event
        WHERE event_id = $1
        FOR UPDATE`,
      [eventId],
    );
    if (event.rows.length !== 1) throw new NotFoundException('Event was not found');
    const result = await client.query<ActionItemRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM event_lineup_item
        WHERE event_id = $1
        ORDER BY position, event_item_id
        FOR UPDATE`,
      [eventId],
    );
    return result.rows.map(mapRow);
  }

  private async listWith(client: PoolClient, eventId: string): Promise<StoredActionEventItem[]> {
    const result = await client.query<ActionItemRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM event_lineup_item
        WHERE event_id = $1
        ORDER BY position, event_item_id`,
      [eventId],
    );
    return result.rows.map(mapRow);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
