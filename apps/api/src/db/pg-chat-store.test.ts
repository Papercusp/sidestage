import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/chat.service';
import { DEFAULT_DATABASE_URL } from './database.module';
import { PgChatStore } from './pg-chat-store';

type QueryResult = { rows: unknown[]; rowCount?: number };
type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>;

const MESSAGE: ChatMessage = {
  id: 'chat-1',
  eventId: 'event-1',
  userId: 'buyer-1',
  displayName: 'Maya',
  role: 'buyer',
  text: 'Is the blue mug available?',
  createdAt: '2026-08-14T18:00:00.000Z',
  grounding: { status: 'seller-queue' },
  clientRequestId: 'chat:req-1',
  moderatedAt: null,
};

function row(message: ChatMessage = MESSAGE) {
  return {
    id: message.id,
    event_id: message.eventId,
    user_id: message.userId,
    display_name: message.displayName,
    role: message.role,
    text: message.text,
    grounding: message.grounding ?? null,
    client_request_id: message.clientRequestId ?? null,
    created_at: message.createdAt,
  };
}

function transactionalPool(handler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params));
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as never, connect, query, release };
}

describe('PgChatStore durable authority', () => {
  it('persists a new message and presence in one transaction', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('INSERT INTO chat_message')) return { rows: [row()] };
      if (sql.includes('INSERT INTO chat_presence')) {
        return { rows: [{ user_id: 'buyer-1', display_name: 'Maya', role: 'buyer', last_seen_at: MESSAGE.createdAt }] };
      }
      return { rows: [] };
    });

    await expect(new PgChatStore(harness.pool).appendMessage(MESSAGE)).resolves.toEqual({
      message: MESSAGE,
      created: true,
    });

    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO chat_message'),
      expect.stringContaining('INSERT INTO chat_presence'),
      'COMMIT',
    ]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('replays an idempotent message without touching presence again', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('INSERT INTO chat_message')) return { rows: [] };
      if (sql.includes('FROM chat_message') && sql.includes('FOR UPDATE')) return { rows: [row()] };
      return { rows: [] };
    });

    await expect(new PgChatStore(harness.pool).appendMessage({ ...MESSAGE, id: 'chat-retry' }))
      .resolves.toEqual({ message: MESSAGE, created: false });
    expect(harness.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO chat_presence'))).toBe(false);
    expect(harness.query.mock.calls.map(([sql]) => sql.trim()).at(-1)).toBe('COMMIT');
  });

  it('rejects reuse of an idempotency key for a different message and rolls back', async () => {
    const harness = transactionalPool((sql) => {
      if (sql.includes('INSERT INTO chat_message')) return { rows: [] };
      if (sql.includes('FROM chat_message') && sql.includes('FOR UPDATE')) {
        return { rows: [row({ ...MESSAGE, text: 'A different mutation.' })] };
      }
      return { rows: [] };
    });

    await expect(new PgChatStore(harness.pool).appendMessage(MESSAGE)).rejects.toBeInstanceOf(ConflictException);
    expect(harness.query.mock.calls.map(([sql]) => sql.trim()).at(-1)).toBe('ROLLBACK');
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('returns chronological pages with an opaque-cursor boundary', async () => {
    const messages = [
      { ...MESSAGE, id: 'chat-3', createdAt: '2026-08-14T18:00:03.000Z' },
      { ...MESSAGE, id: 'chat-2', createdAt: '2026-08-14T18:00:02.000Z' },
      { ...MESSAGE, id: 'chat-1', createdAt: '2026-08-14T18:00:01.000Z' },
    ];
    const query = vi.fn().mockResolvedValue({ rows: messages.map(row) });

    await expect(new PgChatStore({ query } as never).listMessages('event-1', 2)).resolves.toEqual({
      items: [messages[1], messages[0]],
      nextCursor: { createdAt: messages[1].createdAt, id: messages[1].id },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $4'), ['event-1', null, '', 3]);
  });

  it('pages persisted seller-queue questions oldest first for durable Copilot catch-up', async () => {
    const messages = [
      { ...MESSAGE, id: 'chat-1', createdAt: '2026-08-14T18:00:01.000Z' },
      { ...MESSAGE, id: 'chat-2', createdAt: '2026-08-14T18:00:02.000Z' },
      { ...MESSAGE, id: 'chat-3', createdAt: '2026-08-14T18:00:03.000Z' },
    ];
    const query = vi.fn().mockResolvedValue({ rows: messages.map(row) });

    await expect(new PgChatStore({ query } as never).listQueuedQuestions('event-1', 2)).resolves.toEqual({
      items: messages.slice(0, 2),
      nextCursor: { createdAt: messages[1]!.createdAt, id: messages[1]!.id },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("grounding->>'status' = 'seller-queue'"),
      ['event-1', null, '', 3],
    );
  });

  it('merges a Copilot resolution into the durable message grounding', async () => {
    const answered: ChatMessage = {
      ...MESSAGE,
      grounding: {
        status: 'answered',
        proposalId: 'proposal-1',
        responseMessageId: 'reply-1',
      },
    };
    const query = vi.fn().mockResolvedValue({ rows: [row(answered)] });

    await expect(new PgChatStore({ query } as never).patchMessageGrounding('event-1', 'chat-1', {
      status: 'answered',
      proposalId: 'proposal-1',
      responseMessageId: 'reply-1',
    })).resolves.toEqual(answered);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("COALESCE(grounding, '{}'::jsonb) || $3::jsonb"),
      ['event-1', 'chat-1', JSON.stringify({
        status: 'answered', proposalId: 'proposal-1', responseMessageId: 'reply-1',
      })],
    );
  });
});

describe('PgChatStore presence expiry', () => {
  function pool(handler: QueryHandler) {
    const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params));
    return { pool: { query } as never, query };
  }

  it('reads presence without writing — expiry is not a side effect of a read', async () => {
    const harness = pool(() => ({ rows: [] }));

    await new PgChatStore(harness.pool).listPresence('event-1', '2026-08-14T18:00:00.000Z');

    const statements = harness.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('SELECT');
    // The pre-cutover implementation issued a DELETE here. A client reading the
    // replicated chat_presence table directly never triggers this path, so any
    // pruning that lived here was invisible to it.
    expect(statements.some((sql) => sql.includes('DELETE'))).toBe(false);
    expect(harness.query.mock.calls[0]?.[1]).toEqual(['event-1', '2026-08-14T18:00:00.000Z']);
  });

  it('bounds the presence read by the freshness cutoff', async () => {
    const harness = pool(() => ({
      rows: [{ user_id: 'buyer-1', display_name: 'Maya', role: 'buyer', last_seen_at: '2026-08-14T18:00:30.000Z' }],
    }));

    await expect(new PgChatStore(harness.pool).listPresence('event-1', '2026-08-14T18:00:00.000Z')).resolves.toEqual([
      { userId: 'buyer-1', displayName: 'Maya', role: 'buyer', lastSeenAt: '2026-08-14T18:00:30.000Z' },
    ]);
    expect(harness.query.mock.calls[0]?.[0]).toContain('last_seen_at >= $2');
  });

  it('expires stale rows across every event and reports each affected event once', async () => {
    const harness = pool(() => ({
      rows: [{ event_id: 'event-1' }, { event_id: 'event-2' }, { event_id: 'event-1' }],
    }));

    await expect(new PgChatStore(harness.pool).expireStalePresence('2026-08-14T18:00:00.000Z'))
      .resolves.toEqual(['event-1', 'event-2']);

    const [sql, params] = harness.query.mock.calls[0] ?? [];
    expect(sql?.replace(/\s+/g, ' ').trim())
      .toBe('DELETE FROM chat_presence WHERE last_seen_at < $1 RETURNING event_id');
    expect(params).toEqual(['2026-08-14T18:00:00.000Z']);
  });

  it('reports no affected events when nothing was stale', async () => {
    const harness = pool(() => ({ rows: [] }));

    await expect(new PgChatStore(harness.pool).expireStalePresence('2026-08-14T18:00:00.000Z')).resolves.toEqual([]);
  });
});

describe.runIf(process.env.SIDESTAGE_PG_INTEGRATION === '1')('PgChatStore against Postgres', () => {
  it('survives a store restart, deduplicates retries, and hides moderated messages', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 2 });
    const suffix = randomUUID();
    const eventId = `chat-test-event-${suffix}`;
    const message = { ...MESSAGE, id: `chat-test-${suffix}`, eventId, clientRequestId: `chat:req-${suffix}` };

    try {
      await pool.query(
        `INSERT INTO event (event_id, title, seller_id, seller_name, status)
         VALUES ($1, 'Chat test event', 'seller-demo', 'Demo Seller', 'live')`,
        [eventId],
      );
      const firstProcess = new PgChatStore(pool);
      await expect(firstProcess.appendMessage(message)).resolves.toMatchObject({ created: true });

      const restartedProcess = new PgChatStore(pool);
      await expect(restartedProcess.appendMessage({ ...message, id: `${message.id}-retry` }))
        .resolves.toMatchObject({ message: { id: message.id }, created: false });
      await expect(restartedProcess.listMessages(eventId, 10)).resolves.toMatchObject({
        items: [{ id: message.id, eventId }],
      });
      await expect(restartedProcess.moderateMessage(eventId, message.id, 'seller-demo', 'test cleanup'))
        .resolves.toBe(true);
      await expect(restartedProcess.listMessages(eventId, 10)).resolves.toEqual({ items: [] });
    } finally {
      await pool.query('DELETE FROM event WHERE event_id = $1', [eventId]);
      await pool.end();
    }
  });

  it('expires stale presence without a read, and leaves live participants in place', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 2 });
    const suffix = randomUUID();
    const eventId = `presence-test-event-${suffix}`;
    const store = new PgChatStore(pool);
    const cutoff = new Date('2026-08-14T18:00:00.000Z');

    try {
      await pool.query(
        `INSERT INTO event (event_id, title, seller_id, seller_name, status)
         VALUES ($1, 'Presence test event', 'seller-demo', 'Demo Seller', 'live')`,
        [eventId],
      );
      const stale = new Date(cutoff.getTime() - 60_000).toISOString();
      const live = new Date(cutoff.getTime() + 60_000).toISOString();
      await store.touchPresence(eventId, { eventId, userId: 'ghost-1', displayName: 'Ghost', role: 'buyer', lastSeenAt: stale });
      await store.touchPresence(eventId, { eventId, userId: 'live-1', displayName: 'Maya', role: 'buyer', lastSeenAt: live });

      // The row is gone because the sweeper ran, not because anyone read it —
      // the property a client reading the replicated table depends on.
      await expect(store.expireStalePresence(cutoff.toISOString())).resolves.toContain(eventId);
      await expect(store.listPresence(eventId, new Date(0).toISOString())).resolves.toEqual([
        { userId: 'live-1', displayName: 'Maya', role: 'buyer', lastSeenAt: live },
      ]);

      // A second sweep with nothing stale reports no affected events.
      await expect(store.expireStalePresence(cutoff.toISOString())).resolves.not.toContain(eventId);
    } finally {
      await pool.query('DELETE FROM event WHERE event_id = $1', [eventId]);
      await pool.end();
    }
  });
});
