import type { Pool } from 'pg';
import type { ScoutMessage, ScoutSession, ScoutSessionStore } from '../scout/scout.types';

interface SessionRow {
  id: string;
  buyer_id: string;
  messages: ScoutMessage[];
  last_active_at: Date | string;
}

/**
 * Durable scout transcripts. Like the cart, a session is a single-writer
 * document, so the message list is stored whole as jsonb rather than
 * normalized into a message table nothing would ever query independently.
 */
export class PgScoutSessionStore implements ScoutSessionStore {
  constructor(private readonly pool: Pool) {}

  async get(buyerId: string, id: string): Promise<ScoutSession | null> {
    const result = await this.pool.query<SessionRow>(
      'SELECT id, buyer_id, messages, last_active_at FROM scout_session WHERE id = $1 AND buyer_id = $2',
      [id, buyerId],
    );
    const row = result.rows[0];
    return row ? toSession(row) : null;
  }

  /**
   * Append in ONE statement — `messages || $2::jsonb` concatenates server-side
   * rather than read-modify-write from the process. Two turns racing on one
   * session (a resumed connection alongside a fresh one) would otherwise lose
   * whichever wrote first, and the loss is invisible: the transcript simply
   * comes back short.
   */
  async append(
    buyerId: string,
    id: string,
    messages: readonly ScoutMessage[],
  ): Promise<ScoutSession> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO scout_session (id, buyer_id, messages, last_active_at)
            VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (id) DO UPDATE
               SET messages = scout_session.messages || EXCLUDED.messages,
                   last_active_at = now()
             WHERE scout_session.buyer_id = EXCLUDED.buyer_id
         RETURNING id, buyer_id, messages, last_active_at`,
      [id, buyerId, JSON.stringify(messages)],
    );
    if (!result.rows[0]) throw new Error('Scout session not found');
    return toSession(result.rows[0]);
  }
}

function toSession(row: SessionRow): ScoutSession {
  return {
    id: row.id,
    buyerId: row.buyer_id,
    messages: Array.isArray(row.messages) ? row.messages : [],
    lastActiveAt:
      row.last_active_at instanceof Date
        ? row.last_active_at.toISOString()
        : String(row.last_active_at),
  };
}
