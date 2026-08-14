import type { Pool } from 'pg';
import type { ScoutMessage, ScoutSession, ScoutSessionStore } from '../scout/scout.types';

interface SessionRow {
  id: string;
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

  async get(id: string): Promise<ScoutSession | null> {
    const result = await this.pool.query<SessionRow>(
      'SELECT id, messages, last_active_at FROM scout_session WHERE id = $1',
      [id],
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
  async append(id: string, messages: readonly ScoutMessage[]): Promise<ScoutSession> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO scout_session (id, messages, last_active_at)
            VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE
               SET messages = scout_session.messages || EXCLUDED.messages,
                   last_active_at = now()
         RETURNING id, messages, last_active_at`,
      [id, JSON.stringify(messages)],
    );
    return toSession(result.rows[0]);
  }
}

function toSession(row: SessionRow): ScoutSession {
  return {
    id: row.id,
    messages: Array.isArray(row.messages) ? row.messages : [],
    lastActiveAt:
      row.last_active_at instanceof Date
        ? row.last_active_at.toISOString()
        : String(row.last_active_at),
  };
}
