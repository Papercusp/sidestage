import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_URL } from '../db/database.module';
import { PgChatStore } from '../db/pg-chat-store';
import type { ChatMessage } from './chat.service';
import { InMemoryChatStore, type ChatStore } from './chat.store';

/**
 * Moderation is a CONTRACT of `ChatStore`, not of either implementation.
 *
 * PgChatStore soft-deletes (`moderated_at = now()`, with four `moderated_at IS
 * NULL` predicates guarding the read paths) so the audit trail and the
 * (event_id, user_id, client_request_id) idempotency index both survive.
 * InMemoryChatStore used to `splice()` the message out — a HARD delete that
 * silently diverged from durable authority, and that no test caught because
 * nothing asserted moderation against either store (EI-20673350778863235).
 *
 * Every assertion below therefore runs against BOTH stores from one source, so
 * the dev fallback cannot drift from Postgres again without a red test. The
 * Postgres leg is gated on SIDESTAGE_PG_INTEGRATION=1 like its siblings; the
 * in-memory leg always runs, so the guard has teeth even without a database.
 */

interface StoreHarness {
  name: string;
  enabled: boolean;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  freshEvent(): Promise<{ store: ChatStore; eventId: string }>;
}

function inMemoryHarness(): StoreHarness {
  return {
    name: 'InMemoryChatStore',
    enabled: true,
    async setup() {},
    async teardown() {},
    async freshEvent() {
      return { store: new InMemoryChatStore(), eventId: `chat-contract-${randomUUID()}` };
    },
  };
}

function postgresHarness(): StoreHarness {
  let pool: Pool | undefined;
  const eventIds: string[] = [];
  return {
    name: 'PgChatStore',
    enabled: process.env.SIDESTAGE_PG_INTEGRATION === '1',
    async setup() {
      pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 2 });
    },
    async teardown() {
      if (!pool) return;
      for (const eventId of eventIds) {
        await pool.query('DELETE FROM event WHERE event_id = $1', [eventId]);
      }
      await pool.end();
      pool = undefined;
    },
    async freshEvent() {
      if (!pool) throw new Error('postgres harness was not set up');
      const eventId = `chat-contract-${randomUUID()}`;
      await pool.query(
        `INSERT INTO event (event_id, title, seller_id, seller_name, status)
         VALUES ($1, 'Chat moderation contract', 'seller-demo', 'Demo Seller', 'live')`,
        [eventId],
      );
      eventIds.push(eventId);
      return { store: new PgChatStore(pool), eventId };
    },
  };
}

/** `createdAtIso` stays an ISO literal for legibility; the DTO field is D-026 epoch millis. */
function question(eventId: string, suffix: string, createdAtIso: string): ChatMessage {
  const createdAt = Date.parse(createdAtIso);
  return {
    id: `chat-${suffix}`,
    eventId,
    userId: `buyer-${suffix}`,
    displayName: 'Maya',
    role: 'buyer',
    text: 'Is the blue mug still available?',
    createdAt,
    grounding: { status: 'seller-queue' },
    clientRequestId: `chat:req-${suffix}`,
    moderatedAt: null,
  };
}

for (const harness of [inMemoryHarness(), postgresHarness()]) {
  describe.runIf(harness.enabled)(`ChatStore moderation contract — ${harness.name}`, () => {
    beforeAll(async () => harness.setup());
    afterAll(async () => harness.teardown());

    it('hides a moderated message from every read path, and leaves its neighbour alone', async () => {
      const { store, eventId } = await harness.freshEvent();
      const kept = question(eventId, `kept-${randomUUID()}`, '2026-08-14T18:00:00.000Z');
      const removed = question(eventId, `removed-${randomUUID()}`, '2026-08-14T18:00:01.000Z');
      await store.appendMessage(kept);
      await store.appendMessage(removed);

      await expect(store.countMessages(eventId)).resolves.toBe(2);

      await expect(store.moderateMessage(eventId, removed.id, 'seller-demo', 'off topic')).resolves.toBe(true);

      const listed = await store.listMessages(eventId, 10);
      expect(listed.items.map((message) => message.id)).toEqual([kept.id]);

      const queued = await store.listQueuedQuestions(eventId, 10);
      expect(queued.items.map((message) => message.id)).toEqual([kept.id]);

      await expect(store.countMessages(eventId)).resolves.toBe(1);
    });

    it('refuses to moderate the same message twice', async () => {
      const { store, eventId } = await harness.freshEvent();
      const message = question(eventId, `twice-${randomUUID()}`, '2026-08-14T18:00:00.000Z');
      await store.appendMessage(message);

      await expect(store.moderateMessage(eventId, message.id, 'seller-demo', 'off topic')).resolves.toBe(true);
      // Mirrors `WHERE ... AND moderated_at IS NULL` — the second UPDATE matches
      // no row, so the original moderator/reason/timestamp are never overwritten.
      await expect(store.moderateMessage(eventId, message.id, 'seller-other', 'again')).resolves.toBe(false);
    });

    it('refuses to moderate a message that was never in the event', async () => {
      const { store, eventId } = await harness.freshEvent();

      await expect(store.moderateMessage(eventId, `chat-missing-${randomUUID()}`, 'seller-demo', 'nothing there'))
        .resolves.toBe(false);
    });

    it('refuses to ground a moderated message', async () => {
      const { store, eventId } = await harness.freshEvent();
      const message = question(eventId, `grounding-${randomUUID()}`, '2026-08-14T18:00:00.000Z');
      await store.appendMessage(message);

      await expect(store.patchMessageGrounding(eventId, message.id, { status: 'answered' }))
        .resolves.toMatchObject({ id: message.id, grounding: { status: 'answered' } });

      await expect(store.moderateMessage(eventId, message.id, 'seller-demo', 'off topic')).resolves.toBe(true);

      await expect(store.patchMessageGrounding(eventId, message.id, { status: 'seller-queue' }))
        .resolves.toBeUndefined();
    });

    it('returns the original message when a moderated message\'s idempotency key is replayed', async () => {
      const { store, eventId } = await harness.freshEvent();
      const message = question(eventId, `replay-${randomUUID()}`, '2026-08-14T18:00:00.000Z');
      await store.appendMessage(message);
      await expect(store.moderateMessage(eventId, message.id, 'seller-demo', 'off topic')).resolves.toBe(true);

      // The soft-deleted row still occupies the unique index, so a client retry
      // must resolve to the ORIGINAL message rather than resurrecting the
      // moderated text under a new id.
      await expect(store.appendMessage({ ...message, id: `${message.id}-retry` }))
        .resolves.toMatchObject({ message: { id: message.id }, created: false });

      // ...and the retry must not have made it visible again.
      const listed = await store.listMessages(eventId, 10);
      expect(listed.items).toEqual([]);
      await expect(store.countMessages(eventId)).resolves.toBe(0);
    });
  });
}
