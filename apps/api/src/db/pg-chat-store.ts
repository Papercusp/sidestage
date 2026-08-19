import { ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { ChatMessage, ChatPresence, TranscriptMoment } from '../chat/chat.service';
import type { AppendMessageResult, ChatCursor, ChatMessagePage, ChatStore } from '../chat/chat.store';

interface MessageRow {
  id: string;
  event_id: string;
  user_id: string;
  display_name: string;
  role: 'buyer' | 'seller';
  text: string;
  grounding: ChatMessage['grounding'] | string | null;
  client_request_id: string | null;
  created_at: Date | string;
  /**
   * D-029: selected purely so `toMessage` can emit the key. Every read path
   * here also carries `moderated_at IS NULL`, so it is null on every delivered
   * row — but reading the real column keeps the DTO honest if that filter ever
   * changes, instead of hard-coding an invariant in a second place.
   */
  moderated_at: Date | string | null;
}

interface TranscriptRow {
  id: string;
  event_id: string;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
  product_id: string | null;
  product_title: string | null;
  created_at: Date | string;
}

interface PresenceRow {
  event_id: string;
  user_id: string;
  display_name: string;
  role: 'buyer' | 'seller';
  last_seen_at: Date | string;
}

export class PgChatStore implements ChatStore {
  constructor(private readonly pool: Pool) {}

  async listMessages(eventId: string, limit: number, before?: ChatCursor): Promise<ChatMessagePage> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, event_id, user_id, display_name, role, text, grounding, client_request_id, created_at, moderated_at
         FROM chat_message
        WHERE event_id = $1 AND moderated_at IS NULL
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::text))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [eventId, before ? atMillis(before.createdAt) : null, before?.id ?? '', limit + 1],
    );
    const newestFirst = result.rows.map(toMessage);
    const hasOlder = newestFirst.length > limit;
    if (hasOlder) newestFirst.pop();
    const items = newestFirst.reverse();
    return {
      items,
      ...(hasOlder && items[0] ? { nextCursor: { createdAt: items[0].createdAt, id: items[0].id } } : {}),
    };
  }

  async listQueuedQuestions(eventId: string, limit: number, after?: ChatCursor): Promise<ChatMessagePage> {
    const result = await this.pool.query<MessageRow>(
      `SELECT id, event_id, user_id, display_name, role, text, grounding, client_request_id, created_at, moderated_at
         FROM chat_message
        WHERE event_id = $1 AND role = 'buyer' AND moderated_at IS NULL
          AND grounding->>'status' = 'seller-queue'
          AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::text))
        ORDER BY created_at ASC, id ASC
        LIMIT $4`,
      [eventId, after ? atMillis(after.createdAt) : null, after?.id ?? '', limit + 1],
    );
    const items = result.rows.map(toMessage);
    const hasMore = items.length > limit;
    if (hasMore) items.pop();
    return {
      items,
      ...(hasMore && items.at(-1)
        ? { nextCursor: { createdAt: items.at(-1)!.createdAt, id: items.at(-1)!.id } }
        : {}),
    };
  }

  async appendMessage(message: ChatMessage): Promise<AppendMessageResult> {
    return this.transaction(async (client) => {
      const inserted = await client.query<MessageRow>(
        `INSERT INTO chat_message
           (id, event_id, user_id, display_name, role, text, grounding, client_request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (event_id, user_id, client_request_id)
           WHERE client_request_id IS NOT NULL DO NOTHING
         RETURNING id, event_id, user_id, display_name, role, text, grounding, client_request_id, created_at, moderated_at`,
        [message.id, message.eventId, message.userId, message.displayName, message.role, message.text,
          message.grounding ? JSON.stringify(message.grounding) : null, message.clientRequestId ?? null, atMillis(message.createdAt)],
      );
      let persisted = inserted.rows[0] ? toMessage(inserted.rows[0]) : undefined;
      if (!persisted && message.clientRequestId) {
        const replay = await client.query<MessageRow>(
          `SELECT id, event_id, user_id, display_name, role, text, grounding, client_request_id, created_at, moderated_at
             FROM chat_message
            WHERE event_id = $1 AND user_id = $2 AND client_request_id = $3
            FOR UPDATE`,
          [message.eventId, message.userId, message.clientRequestId],
        );
        persisted = replay.rows[0] ? toMessage(replay.rows[0]) : undefined;
        if (!persisted) throw new Error('Idempotent chat insert neither created nor recovered a row');
        if (!sameMutation(persisted, message)) throw new ConflictException('Idempotency key was already used for a different message');
      }
      if (!persisted) throw new Error('Chat message was not persisted');
      if (inserted.rows.length > 0) {
        await this.upsertPresence(client, message.eventId, {
          eventId: message.eventId, userId: message.userId, displayName: message.displayName, role: message.role, lastSeenAt: message.createdAt,
        });
      }
      return { message: persisted, created: inserted.rows.length > 0 };
    });
  }

  async patchMessageGrounding(
    eventId: string,
    messageId: string,
    patch: Partial<NonNullable<ChatMessage['grounding']>>,
  ): Promise<ChatMessage | undefined> {
    const result = await this.pool.query<MessageRow>(
      `UPDATE chat_message
          SET grounding = COALESCE(grounding, '{}'::jsonb) || $3::jsonb
        WHERE event_id = $1 AND id = $2 AND moderated_at IS NULL
          AND grounding IS DISTINCT FROM (COALESCE(grounding, '{}'::jsonb) || $3::jsonb)
        RETURNING id, event_id, user_id, display_name, role, text, grounding, client_request_id, created_at, moderated_at`,
      [eventId, messageId, JSON.stringify(patch)],
    );
    return result.rows[0] ? toMessage(result.rows[0]) : undefined;
  }

  async listTranscript(eventId: string, limit: number): Promise<TranscriptMoment[]> {
    const result = await this.pool.query<TranscriptRow>(
      `SELECT id, event_id, text, start_ms, end_ms, product_id, product_title, created_at
         FROM chat_transcript_moment WHERE event_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [eventId, limit],
    );
    return result.rows.reverse().map(toTranscript);
  }

  async appendTranscript(eventId: string, moment: TranscriptMoment): Promise<TranscriptMoment> {
    const result = await this.pool.query<TranscriptRow>(
      `INSERT INTO chat_transcript_moment
         (id, event_id, text, start_ms, end_ms, product_id, product_title, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, event_id, text, start_ms, end_ms, product_id, product_title, created_at`,
      [moment.id, eventId, moment.text, moment.startMs ?? null, moment.endMs ?? null,
        moment.productId ?? null, moment.productTitle ?? null, atMillis(moment.createdAt)],
    );
    return toTranscript(result.rows[0]);
  }

  async listPresence(eventId: string, cutoffMs: number): Promise<ChatPresence[]> {
    // A pure read. Expiry is the sweeper's job (expireStalePresence) so that a
    // client reading the replicated chat_presence table directly sees the same
    // live set this endpoint returns, instead of rows that only a REST read
    // would have pruned.
    const result = await this.pool.query<PresenceRow>(
      `SELECT event_id, user_id, display_name, role, last_seen_at
         FROM chat_presence WHERE event_id = $1 AND last_seen_at >= $2 ORDER BY user_id`,
      [eventId, atMillis(cutoffMs)],
    );
    return result.rows.map(toPresence);
  }

  async expireStalePresence(cutoffMs: number): Promise<string[]> {
    const result = await this.pool.query<{ event_id: string }>(
      'DELETE FROM chat_presence WHERE last_seen_at < $1 RETURNING event_id',
      [atMillis(cutoffMs)],
    );
    return [...new Set(result.rows.map((row) => row.event_id))];
  }

  async touchPresence(eventId: string, presence: ChatPresence): Promise<ChatPresence> {
    return this.upsertPresence(this.pool, eventId, presence);
  }

  async removePresence(eventId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM chat_presence WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    return (result.rowCount ?? 0) > 0;
  }

  async countMessages(eventId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM chat_message WHERE event_id = $1 AND moderated_at IS NULL', [eventId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async moderateMessage(eventId: string, messageId: string, moderatorId: string, reason: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE chat_message SET moderated_at = now(), moderated_by = $3, moderation_reason = $4
        WHERE event_id = $1 AND id = $2 AND moderated_at IS NULL`,
      [eventId, messageId, moderatorId, reason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async upsertPresence(queryable: Pick<Pool | PoolClient, 'query'>, eventId: string, presence: ChatPresence): Promise<ChatPresence> {
    const result = await queryable.query<PresenceRow>(
      `INSERT INTO chat_presence (event_id, user_id, display_name, role, last_seen_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id, user_id) DO UPDATE
         SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, last_seen_at = EXCLUDED.last_seen_at
       RETURNING event_id, user_id, display_name, role, last_seen_at`,
      [eventId, presence.userId, presence.displayName, presence.role, atMillis(presence.lastSeenAt)],
    );
    return toPresence(result.rows[0]);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
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

/**
 * D-026: the sync contract's timestamp encoding is integer epoch milliseconds,
 * so the REST rung decodes the `timestamptz(3)` column the same way Zero's
 * replication does. `Date.prototype.getTime` is integral by definition, and the
 * columns are `timestamptz(3)`, so both rungs land on the same integer — this is
 * NOT the `Math.trunc` half-fix D-026 rejects, which would have left Zero
 * fractional and turned a type mismatch into a value mismatch.
 */
function epochMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Timestamps cross into SQL as `Date`; node-pg renders one as a millisecond-precision timestamptz literal. */
function atMillis(value: number): Date {
  return new Date(value);
}

/**
 * D-029: these three mappers emit EVERY contract key unconditionally, using
 * `null` for an absent value.
 *
 * They previously spread the key away when the column was null
 * (`...(x === null ? {} : { x })`), which made the REST rung's key set depend on
 * the DATA rather than on the contract: a row with a null column produced an
 * object missing that key, while the Zero rung — replicating the table — always
 * sends it as null. That is real drift, and it is invisible in any fixture whose
 * rows happen to populate the column.
 */
function toMessage(row: MessageRow): ChatMessage {
  const grounding = typeof row.grounding === 'string' ? JSON.parse(row.grounding) as ChatMessage['grounding'] : row.grounding;
  return {
    id: row.id, eventId: row.event_id, userId: row.user_id, displayName: row.display_name,
    role: row.role, text: row.text, createdAt: epochMillis(row.created_at),
    grounding: grounding ?? null,
    clientRequestId: row.client_request_id ?? null,
    moderatedAt: row.moderated_at === null ? null : epochMillis(row.moderated_at),
  };
}

function toTranscript(row: TranscriptRow): TranscriptMoment {
  return {
    id: row.id, eventId: row.event_id, text: row.text,
    startMs: row.start_ms === null ? null : Number(row.start_ms),
    endMs: row.end_ms === null ? null : Number(row.end_ms),
    productId: row.product_id,
    productTitle: row.product_title,
    createdAt: epochMillis(row.created_at),
  };
}

function toPresence(row: PresenceRow): ChatPresence {
  return { eventId: row.event_id, userId: row.user_id, displayName: row.display_name, role: row.role, lastSeenAt: epochMillis(row.last_seen_at) };
}

function sameMutation(left: ChatMessage, right: ChatMessage): boolean {
  return left.displayName === right.displayName && left.role === right.role && left.text === right.text
    && JSON.stringify(left.grounding ?? null) === JSON.stringify(right.grounding ?? null);
}
