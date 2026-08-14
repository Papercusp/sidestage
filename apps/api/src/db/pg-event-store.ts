import type { Pool } from 'pg';
import {
  isEventStatus,
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

    return result.rows.flatMap((row) => {
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
    });
  }
}
