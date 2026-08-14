import type { Pool } from 'pg';
import {
  isEventStatus,
  type EventPublication,
  type EventRecord,
  type EventStore,
} from '../events/event.service';

interface EventRow {
  event_id: string;
  title: string;
  seller_id: string;
  seller_name: string;
  status: string;
  starts_at: Date | null;
  ended_at: Date | null;
  thumbnail_url: string | null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Postgres-backed event directory for the buyer Channel Guide (P-118 / D-019).
 *
 * The `status <> 'draft'` filter is applied in SQL rather than after the fetch:
 * an unpublished event should not leave the database on a buyer read at all,
 * so there is no window in which it exists in an API process's memory.
 */
export class PgEventStore implements EventStore {
  constructor(private readonly pool: Pool) {}

  async listBuyerVisible(): Promise<EventRecord[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT event_id, title, seller_id, seller_name, status,
              starts_at, ended_at, thumbnail_url
         FROM event
        WHERE status <> 'draft'
        ORDER BY CASE status
                   WHEN 'live' THEN 0
                   WHEN 'scheduled' THEN 1
                   ELSE 2
                 END,
                 starts_at NULLS LAST,
                 title`,
    );

    return result.rows.flatMap((row) => mapRow(row));
  }

  async listBySeller(sellerId: string): Promise<EventRecord[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT event_id, title, seller_id, seller_name, status,
              starts_at, ended_at, thumbnail_url
         FROM event
        WHERE seller_id = $1
        ORDER BY CASE status
                   WHEN 'live' THEN 0
                   WHEN 'scheduled' THEN 1
                   WHEN 'draft' THEN 2
                   ELSE 3
                 END,
                 starts_at NULLS LAST,
                 title`,
      [sellerId],
    );

    return result.rows.flatMap((row) => mapRow(row));
  }

  /**
   * Upsert the seller-created event's directory row (EI-20426845001666103 /
   * P-014). A NEW event inserts as 'scheduled' so it is buyer-visible at
   * creation; the table default 'draft' is exactly the invisibility this call
   * exists to fix. The conflict branch deliberately does NOT set status,
   * starts_at or ended_at: a config re-save (rename, thumbnail swap) on a live
   * or ended event must never reset its lifecycle.
   */
  async publish(input: EventPublication): Promise<void> {
    await this.pool.query(
      `INSERT INTO event (event_id, title, seller_id, seller_name, status, thumbnail_url)
       VALUES ($1, $2, $3, $4, 'scheduled', $5)
       ON CONFLICT (event_id) DO UPDATE
         SET title = EXCLUDED.title,
             seller_id = EXCLUDED.seller_id,
             seller_name = EXCLUDED.seller_name,
             thumbnail_url = EXCLUDED.thumbnail_url,
             status = CASE
               WHEN event.status = 'draft' THEN 'scheduled'
               ELSE event.status
             END,
             updated_at = now()`,
      [input.eventId, input.title, input.sellerId, input.sellerName, input.thumbnailUrl ?? null],
    );
  }

  async unpublish(eventId: string, sellerId: string): Promise<boolean> {
    const result = await this.pool.query<{ event_id: string }>(
      `UPDATE event
          SET status = 'draft',
              starts_at = NULL,
              ended_at = NULL,
              updated_at = now()
        WHERE event_id = $1
          AND seller_id = $2
      RETURNING event_id`,
      [eventId, sellerId],
    );
    return result.rows.length > 0;
  }
}

function mapRow(row: EventRow): EventRecord[] {
  // A status outside the known set means the CHECK constraint was dropped
  // or the row predates it. Skipping is the honest response: the guide
  // groups BY status, so a row with an ungroupable status has nowhere to
  // go, and inventing a group for it would show buyers a bucket the
  // product does not define.
  if (!isEventStatus(row.status)) return [];
  return [
    {
      eventId: row.event_id,
      title: row.title,
      sellerId: row.seller_id,
      sellerName: row.seller_name,
      status: row.status,
      startsAt: iso(row.starts_at),
      endedAt: iso(row.ended_at),
      ...(row.thumbnail_url ? { thumbnailUrl: row.thumbnail_url } : {}),
    },
  ];
}
