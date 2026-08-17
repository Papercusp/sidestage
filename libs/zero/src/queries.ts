/**
 * SideStage named ZQL query registry.
 *
 * The dot-path of each query here MIRRORS the name the app already passes to
 * `useSyncQuery({ queryName })` against the REST/SSE `SyncQueryRegistry`
 * (apps/api/src/sync/sync-query.registry.ts). That is deliberate and is the
 * whole point of the contract: `@papercusp/sync`'s `resolveQuery` walks the
 * dotted name through this object, so flipping `syncType` from `"SSE"` to
 * `"WEBSOCKETS"` changes the transport WITHOUT touching a single call site.
 *
 * Every zod validator is load-bearing: on the server these args arrive from an
 * untrusted browser through zero-cache's `/zero/query` call, so the validator
 * is the parse boundary, not documentation.
 *
 * Identity/authorization is NOT expressed here. Zero resolves these queries
 * server-side through the API's `/zero/query` handler, which supplies the
 * authenticated principal in `ctx` — see `SYNCED_QUERY_PRINCIPAL_SCOPE` below
 * and P-005's principal-isolation drills.
 */
import { defineQueries, defineQuery } from '@rocicorp/zero';
import { z } from 'zod';
import { zql } from './schema';

// ── Shared arg shapes ───────────────────────────────────────────────────────

const eventArg = z.object({ eventId: z.string().min(1) });
const eventPageArgs = z.object({
  eventId: z.string().min(1),
  limit: z.number().int().positive().max(500).default(100),
});
const idArg = z.object({ id: z.string().min(1) });
const sellerArg = z.object({ sellerId: z.string().min(1) });
const regionPageArgs = z.object({
  region: z.string().min(1).default('US'),
  limit: z.number().int().positive().max(500).default(100),
});

// ── Registry ────────────────────────────────────────────────────────────────

export const queries = defineQueries({
  /** `events.guide` (public directory) / `events.mine` (seller's own). */
  events: {
    guide: defineQuery(() =>
      zql.event
        .where('status', 'IN', ['scheduled', 'live', 'ended'])
        .orderBy('status', 'asc')
        .orderBy('startsAt', 'asc')
        .limit(200),
    ),
    mine: defineQuery(sellerArg, ({ args: { sellerId } }) =>
      zql.event.where('sellerId', sellerId).orderBy('createdAt', 'desc').limit(200),
    ),
    byId: defineQuery(eventArg, ({ args: { eventId } }) =>
      zql.event
        .where('eventId', eventId)
        .related('config', (q) => q.one())
        .related('runOfShow', (q) => q.one())
        .one(),
    ),
  },

  event: {
    /** `event.config` — the Config tab's settings document. */
    config: defineQuery(eventArg, ({ args: { eventId } }) =>
      zql.eventConfig.where('eventId', eventId).one(),
    ),

    /** `event.runOfShow` — advisory planned product order. */
    runOfShow: defineQuery(eventArg, ({ args: { eventId } }) =>
      zql.eventRunOfShow.where('eventId', eventId).one(),
    ),

    lineup: {
      /**
       * `event.lineup.items` — the buyer-facing lineup. Related
       * `product` → `catalog` reproduces the JOIN the REST handler performs, so
       * a Zero-rendered lineup matches the SSE-rendered one row for row.
       */
      items: defineQuery(eventArg, ({ args: { eventId } }) =>
        zql.eventLineupItem
          .where('eventId', eventId)
          .orderBy('position', 'asc')
          .orderBy('eventItemId', 'asc')
          .related('product', (q) =>
            q.one().related('catalog', (c) => c.one()).related('options', (o) => o),
          ),
      ),
    },

    actions: {
      /** `event.actions.items` — the seller's action surface over the lineup. */
      items: defineQuery(eventArg, ({ args: { eventId } }) =>
        zql.eventLineupItem
          .where('eventId', eventId)
          .orderBy('position', 'asc')
          .orderBy('eventItemId', 'asc')
          .related('product', (q) => q.one()),
      ),
    },

    auction: {
      /** `event.auction.active` — at most one active auction per event. */
      active: defineQuery(eventArg, ({ args: { eventId } }) =>
        zql.auctionState
          .where('eventId', eventId)
          .where('status', 'active')
          .related('product', (q) => q.one())
          .related('lineupItem', (q) => q.one())
          .one(),
      ),
      /** History for the pricing/replay surfaces. */
      history: defineQuery(eventPageArgs, ({ args: { eventId, limit } }) =>
        zql.auctionState.where('eventId', eventId).orderBy('startedAt', 'desc').limit(limit),
      ),
    },

    chat: {
      /** `event.chat.messages` — visible (unmoderated) room messages. */
      messages: defineQuery(eventPageArgs, ({ args: { eventId, limit } }) =>
        zql.chatMessage
          .where('eventId', eventId)
          .where('moderatedAt', 'IS', null)
          .orderBy('createdAt', 'desc')
          .orderBy('id', 'desc')
          .limit(limit),
      ),
      /** `event.chat.presence` — who is in the room right now. */
      presence: defineQuery(eventArg, ({ args: { eventId } }) =>
        zql.chatPresence.where('eventId', eventId).orderBy('lastSeenAt', 'desc'),
      ),
      /** `event.chat.transcript` — seller-authored transcript moments. */
      transcript: defineQuery(eventPageArgs, ({ args: { eventId, limit } }) =>
        zql.chatTranscriptMoment
          .where('eventId', eventId)
          .orderBy('createdAt', 'desc')
          .orderBy('id', 'desc')
          .limit(limit),
      ),
    },

    replay: {
      /** `event.replay.chapters` — transcript moments in playback order. */
      chapters: defineQuery(eventArg, ({ args: { eventId } }) =>
        zql.chatTranscriptMoment
          .where('eventId', eventId)
          .orderBy('startMs', 'asc')
          .orderBy('createdAt', 'asc'),
      ),
    },

    copilot: {
      /** `event.copilot.proposals` — the seller Copilot review queue. */
      proposals: defineQuery(eventArg, ({ args: { eventId } }) =>
        zql.copilotProposal
          .where('eventId', eventId)
          .orderBy('createdAt', 'desc')
          .related('sourceMessage', (q) => q.one()),
      ),
    },

    audit: {
      /** Guarded-action evidence; also the source of `event.pricingHistory`. */
      entries: defineQuery(eventPageArgs, ({ args: { eventId, limit } }) =>
        zql.actionAuditEntry.where('eventId', eventId).orderBy('createdAt', 'desc').limit(limit),
      ),
    },
  },

  /** `catalog.page` — the public buyer catalog. */
  catalog: {
    page: defineQuery(regionPageArgs, ({ args: { region, limit } }) =>
      zql.storefrontProduct
        .where('region', region)
        .where('active', true)
        .orderBy('updatedAt', 'desc')
        .limit(limit)
        .related('catalog', (q) => q.one())
        .related('options', (q) => q.related('axis', (a) => a.one()).related('value', (v) => v.one())),
    ),
    byId: defineQuery(idArg, ({ args: { id } }) =>
      zql.storefrontProduct
        .where('id', id)
        .related('catalog', (q) => q.one())
        .related('options', (q) => q.related('axis', (a) => a.one()).related('value', (v) => v.one()))
        .one(),
    ),
  },

  /** `inventory.page` — the seller Studio inventory grid. */
  inventory: {
    page: defineQuery(
      z.object({
        sellerId: z.string().min(1),
        limit: z.number().int().positive().max(1000).default(200),
      }),
      ({ args: { sellerId, limit } }) =>
        zql.storefrontProduct
          .where('sellerId', sellerId)
          .orderBy('updatedAt', 'desc')
          .limit(limit)
          .related('catalog', (q) => q.one())
          .related('reservations', (q) => q.where('state', 'held')),
    ),
  },

  /** `cart.byId` — the buyer's cart document. */
  cart: {
    byId: defineQuery(idArg, ({ args: { id } }) => zql.cart.where('id', id).one()),
  },

  /** `orders.byBuyer` — routed through the buyer's cart id. */
  orders: {
    byCart: defineQuery(
      z.object({ cartId: z.string().min(1) }),
      ({ args: { cartId } }) =>
        zql.checkoutOrder.where('cartId', cartId).orderBy('updatedAt', 'desc'),
    ),
    byId: defineQuery(idArg, ({ args: { id } }) => zql.checkoutOrder.where('id', id).one()),
  },

  /** Seller policy revisions behind the Config tab's guardrails. */
  policy: {
    published: defineQuery(
      z.object({ sellerId: z.string().min(1) }),
      ({ args: { sellerId } }) =>
        zql.sellerPolicyRevision
          .where('sellerId', sellerId)
          .where('state', 'published')
          .orderBy('revision', 'desc'),
    ),
  },
});

export type Queries = typeof queries;

/**
 * Which principal each synced query must be scoped to on the server.
 *
 * The `/zero/query` handler reads this map to decide what to enforce against
 * the authenticated `ctx` before returning ZQL, so the rule lives beside the
 * query rather than in a handler switch statement that silently drifts. It is
 * also the input to P-005's principal-isolation drills.
 */
export const SYNCED_QUERY_PRINCIPAL_SCOPE = {
  'events.guide': 'public',
  'events.mine': 'seller',
  'events.byId': 'public',
  'event.config': 'seller',
  'event.runOfShow': 'seller',
  'event.lineup.items': 'public',
  'event.actions.items': 'seller',
  'event.auction.active': 'public',
  'event.auction.history': 'public',
  'event.chat.messages': 'public',
  'event.chat.presence': 'public',
  'event.chat.transcript': 'public',
  'event.replay.chapters': 'public',
  'event.copilot.proposals': 'seller',
  'event.audit.entries': 'seller',
  'catalog.page': 'public',
  'catalog.byId': 'public',
  'inventory.page': 'seller',
  'cart.byId': 'buyer',
  'orders.byCart': 'buyer',
  'orders.byId': 'buyer',
  'policy.published': 'seller',
} as const satisfies Record<string, 'public' | 'buyer' | 'seller' | 'operational'>;

export type SyncedQueryName = keyof typeof SYNCED_QUERY_PRINCIPAL_SCOPE;

/**
 * REST/SSE query names that deliberately do NOT get a Zero equivalent, with the
 * reason each one stays on the existing transport. The parity test requires
 * every `SyncQueryRegistry` registration to be either a synced query above or
 * listed here — so a new REST query can never be silently forgotten by the
 * Zero cutover.
 */
export const UNSYNCED_QUERY_REASONS: Readonly<Record<string, string>> = {
  'build.history': 'Operational build snapshot read from a generated JSON artifact, not a Postgres table (census: no backing table, P-020).',
  'judge.latest': 'Operational judge run; a command-with-synced-result surface whose authority is the judge service, not a replicated table (census: no backing table, P-020).',
  'rehearsal.preflight': 'Operational rehearsal preflight computed on demand; no durable table (census: no backing table, P-020).',
  'identity.current': 'Demo identity selection is device-local browser state (census DEVICE_LOCAL_SURFACES) and must never be replicated.',
  'catalog.types': 'Distinct-value aggregate over product_catalog.product_type. ZQL has no DISTINCT/aggregate; derive it client-side from catalog.page or keep the REST handler.',
  'event.chat.stats': 'Aggregate counts over chat_message + chat_presence. ZQL has no COUNT; derive client-side from event.chat.messages / event.chat.presence or keep the REST handler.',
  'event.stats': 'Aggregate over event + checkout_order + auction_state. Same COUNT/SUM limitation as event.chat.stats.',
  'event.pricingHistory': 'A projection of policy_audit_entry, not action_audit_entry; it lands as a Zero query once policy_audit_entry joins the replicated set (tracked on P-002 follow-up).',
};
