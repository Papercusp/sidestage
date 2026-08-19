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

// Every arg shape is .strict(): an unknown key is a CONTRACT ERROR, never
// silently stripped. Silent stripping is how catalog.page served the wrong
// rows instead of failing loudly when the client sent REST-shaped args to the
// old Zero leaf (WI-39855) — a loud zod throw surfaces the drift immediately.
const eventArg = z.object({ eventId: z.string().min(1) }).strict();
const eventPageArgs = z.object({
  eventId: z.string().min(1),
  limit: z.number().int().positive().max(500).default(100),
}).strict();
const idArg = z.object({ id: z.string().min(1) }).strict();

// ── Registry ────────────────────────────────────────────────────────────────

export const queries = defineQueries({
  /** `events.byId` — single-event read. `events.guide`/`events.mine` are
   * deliberately REST-only: both return SERVER-COMPUTED fields (see
   * UNSYNCED_QUERY_REASONS). */
  events: {
    byId: defineQuery(eventArg, ({ args: { eventId } }) =>
      zql.event
        .where('eventId', eventId)
        .related('config', (q) => q.one())
        .related('runOfShow', (q) => q.one())
        .one(),
    ),
  },

  event: {
    /** `event.config` and `event.runOfShow` are deliberately REST-only: both
     * read payload-jsonb DOCUMENT-STORE tables, so a Zero leaf can only ever
     * serve the opaque `payload` column (D-025). See UNSYNCED_QUERY_REASONS. */

    lineup: {
      /**
       * `event.lineup.items` — the buyer-facing lineup: exactly the replicated
       * `event_lineup_item` row, nothing more.
       *
       * D-036: this deliberately does NOT relate to `product`. Two reasons, and
       * the second is a security one:
       *
       * 1. Nothing needs it. BuyerTab renders this event-authoritative row
       *    directly and does not fall back to global catalog selection.
       * 2. `storefront_product` is published WHOLE (db/zero-publication.sql),
       *    including `qty`, `reserved_qty`, `price_cents` and `active` — the
       *    seller's inventory position and base-price structure. Relating to it
       *    from THIS query would serve that on a PUBLIC buyer read.
       *
       * An earlier version of this comment claimed the relation "matches the
       * SSE-rendered one row for row". That was measured FALSE (Zero nested
       * `product`; REST flattened seven catalog keys) and is what D-024/D-036
       * resolved.
       */
      items: defineQuery(eventArg, ({ args: { eventId } }) =>
        zql.eventLineupItem
          .where('eventId', eventId)
          .orderBy('position', 'asc')
          .orderBy('eventItemId', 'asc'),
      ),
    },

    actions: {
      /**
       * `event.actions.items` — the seller's action surface over the lineup.
       * D-036: same shape as the buyer leaf, and for the same reasons; the
       * `product` relation was this query's only remaining Zero/REST drift.
       */
      items: defineQuery(eventArg, ({ args: { eventId } }) =>
        zql.eventLineupItem
          .where('eventId', eventId)
          .orderBy('position', 'asc')
          .orderBy('eventItemId', 'asc'),
      ),
    },

    auction: {
      /** `event.auction.active` is deliberately REST-only: auction_state keeps
       * bids / allocationState / winnerOrder / startingPriceCents in a payload
       * jsonb column (D-025). See UNSYNCED_QUERY_REASONS. */

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

    /** `event.replay.chapters` is deliberately REST-only: the REST rung DERIVES
     * chapters by merging chat_transcript_moment rows, and a derived view is not
     * a table (D-025). `event.copilot.proposals` is deliberately REST-only:
     * copilot_proposal keeps reply / citations / grounding in a payload jsonb
     * column (D-025). Both: see UNSYNCED_QUERY_REASONS. */

    audit: {
      /** Guarded-action evidence; also the source of `event.pricingHistory`. */
      entries: defineQuery(eventPageArgs, ({ args: { eventId, limit } }) =>
        zql.actionAuditEntry.where('eventId', eventId).orderBy('createdAt', 'desc').limit(limit),
      ),
    },
  },

  /** `catalog.byId` — forward scope; `catalog.page`/`inventory.page` are
   * deliberately REST-only (see UNSYNCED_QUERY_REASONS). */
  catalog: {
    byId: defineQuery(idArg, ({ args: { id } }) =>
      zql.storefrontProduct
        .where('id', id)
        .related('catalog', (q) => q.one())
        .related('options', (q) => q.related('axis', (a) => a.one()).related('value', (v) => v.one()))
        .one(),
    ),
  },

  /** `cart.byId` is deliberately REST-only: `cart` is a payload-jsonb DOCUMENT
   * STORE ({id, payload, updatedAt}), so a Zero leaf can only ever serve the
   * opaque blob — items, subtotalCents, currency, buyerId, revision,
   * eventHoldKeys and eventTerminalTransition all live inside it (D-025).
   * See UNSYNCED_QUERY_REASONS. */

  /** `orders.byBuyer` — routed through the buyer's cart id. */
  orders: {
    byCart: defineQuery(
      z.object({ cartId: z.string().min(1) }).strict(),
      ({ args: { cartId } }) =>
        zql.checkoutOrder.where('cartId', cartId).orderBy('updatedAt', 'desc'),
    ),
    byId: defineQuery(idArg, ({ args: { id } }) => zql.checkoutOrder.where('id', id).one()),
  },

  /** Seller policy revisions behind the Config tab's guardrails. */
  policy: {
    published: defineQuery(
      z.object({ sellerId: z.string().min(1) }).strict(),
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
  'events.byId': 'public',
  'event.lineup.items': 'public',
  'event.actions.items': 'seller',
  'event.auction.history': 'public',
  'event.chat.messages': 'public',
  'event.chat.presence': 'public',
  'event.chat.transcript': 'public',
  'event.audit.entries': 'seller',
  'catalog.byId': 'public',
  'orders.byCart': 'buyer',
  'orders.byId': 'buyer',
  'policy.published': 'seller',
} as const satisfies Record<string, 'public' | 'buyer' | 'seller' | 'operational'>;

export type SyncedQueryName = keyof typeof SYNCED_QUERY_PRINCIPAL_SCOPE;

/**
 * REST/SSE query names that deliberately do NOT get a Zero equivalent, with the
 * reason each one stays on the existing transport.
 *
 * Two separate guards, because listing a name here has two separate
 * consequences and for a while only the first was checked:
 *
 * 1. REGISTRATION side — the parity test requires every `SyncQueryRegistry`
 *    registration to be either a synced query above or listed here, so a new
 *    REST query can never be silently forgotten by the Zero cutover.
 * 2. CALL-SITE side — a name listed here has NO Zero registry leaf, so asking
 *    for it via `useSyncQuery` throws `Query '<name>' is not a function` on the
 *    WEBSOCKETS transport. Polling/SSE resolve the same name over REST without
 *    consulting the registry, so such a call site looks perfectly healthy until
 *    a client actually reaches WebSockets. Guard 1 cannot see this at all — it
 *    compares name sets and never reads a call site. That gap shipped
 *    `event.chat.stats` to production (WI-39763); the parity test now walks
 *    apps/web for it too.
 */
export const UNSYNCED_QUERY_REASONS: Readonly<Record<string, string>> = {
  // ── payload-jsonb DOCUMENT STORES (D-025) ─────────────────────────────────
  // Measured by the WI-39867 differential harness against seeded live Postgres
  // (2026-08-18): each of these reads a table whose whole domain object lives in
  // a `payload` jsonb column, so the Zero row is {id, payload, updatedAt} and
  // EVERY named field the REST rung serves is absent. ZQL cannot unpack jsonb —
  // it has no select/project/map at all (fact `zql-has-no-projection-layer`) —
  // so this is not a leaf that needs fixing, it is a query that cannot be a leaf.
  // Unpacking client-side is refused: that is a second implementation of the DTO
  // in the client, which is the exact defect that shipped as WI-39855.
  'event.config':
    "payload-document-store (D-025): `event_config` is {event_id, payload jsonb, updated_at} (libs/zero/src/schema.ts). The Config tab's whole settings document — name, policy, policySource, guardrails, replyTone — lives INSIDE payload, so the Zero rung served none of them (measured 2026-08-18). Promotion to real columns is refused as a gate: an open settings document grows a migration per setting forever. Call sites pin the REST path via useRestSyncQuery.",
  'event.runOfShow':
    'payload-document-store (D-025): `event_run_of_show` is {event_id, payload jsonb, updated_at}. `plannedOrder` is an ARRAY inside payload — not a column at all, and an array member is its own table, i.e. a real relational redesign rather than a rename. Call sites pin the REST path via useRestSyncQuery.',
  'event.auction.active':
    'payload-document-store (D-025): `auction_state` carries the hot fields as real columns but keeps allocationState, bids, winnerOrder and startingPriceCents in `payload` jsonb (measured 2026-08-18). `bids` is an array, so the same array-is-its-own-table objection as event.runOfShow applies. Note `event.auction.history` remains a synced leaf — it reads only the replicated columns. Call sites pin the REST path via useRestSyncQuery.',
  'event.copilot.proposals':
    'payload-document-store (D-025): `copilot_proposal` is {id, event_id, source_message_id, status, revision, payload jsonb, ...}, and the proposal itself — reply, citations, grounding — is inside payload (measured 2026-08-18). `citations` is an array. Call sites pin the REST path via useRestSyncQuery.',
  'cart.byId':
    'payload-document-store (D-025): `cart` is literally {id, payload jsonb, updated_at}, so the Zero rung served the blob and none of items, subtotalCents, currency, buyerId, revision, eventHoldKeys or eventTerminalTransition (measured 2026-08-18). `items` is an array whose Zero-native form is a `cart_item` TABLE — the one promotion here that is a genuine relational redesign, tracked as follow-up and deliberately NOT gating D-023. Call sites pin the REST path via useRestSyncQuery.',
  // ── DERIVED VIEW (D-025) ──────────────────────────────────────────────────
  'event.replay.chapters':
    'derived-view (D-025): the REST rung DERIVES chapters by merging chat_transcript_moment rows and decorating them with evidenceKind / evidenceLabel / previewText; the Zero leaf read the moments straight. Measured 2026-08-18: REST returned 1 row where Zero returned 2, and endMs disagreed 15000 vs 5000 — i.e. the WS rung served UNMERGED moments as if they were chapters. A derived view is not a table, so ZQL cannot produce it. The Zero-native replacement is client-side composition over `event.chat.transcript`, a call-site change rather than a rename. Call sites pin the REST path via useRestSyncQuery.',
  'events.guide': "SERVER-COMPUTED fields (WI-39855/WI-39839): EventService.listForGuide (apps/api/src/events/event.service.ts:725) decorates every row with `viewers` (live chat presence via chat.getStats(eventId).activeUsers) and `playbackUrl` (whepPlaybackUrl(eventId)). NEITHER is a column on the Zero `event` table (libs/zero/src/schema.ts) and neither is derivable in ZQL — presence is a different table's live aggregate, and the URL is composed from runtime config. The retired Zero leaf therefore served rows with `viewers` UNDEFINED, which formatViewers rendered as a confident \"0 watching\" beside a correct \"2 watching\" from event.stats (WI-39839 symptom 3). Name-set parity cannot see this class of drift. Call sites pin the REST path via useRestSyncQuery.",
  'events.mine': "SERVER-COMPUTED field (WI-39855): EventService.listForSeller (apps/api/src/events/event.service.ts:753) decorates every row with `withheldFromGuide` = guideWithholdReason(record) — a POLICY VERDICT computed from several fields, not a stored column, and absent from the Zero `event` table. Same class as events.guide: ZQL cannot derive it, so the retired Zero leaf silently dropped the seller's only signal for why a room is hidden from the guide (WI-39723). Call sites pin the REST path via useRestSyncQuery.",
  'build.history': 'Operational build snapshot read from a generated JSON artifact, not a Postgres table (census: no backing table, P-020).',
  'judge.latest': 'Operational judge run; a command-with-synced-result surface whose authority is the judge service, not a replicated table (census: no backing table, P-020).',
  'rehearsal.preflight': 'Operational rehearsal preflight computed on demand; no durable table (census: no backing table, P-020).',
  'identity.current': 'Demo identity selection is device-local browser state (census DEVICE_LOCAL_SURFACES) and must never be replicated.',
  'catalog.page': "Contract collision (WI-39855): the REST registration takes {q, productType, availability, page, pageSize} and returns a CatalogPage ENVELOPE (rows + total + facets) that consumers unwrap via data[0].rows, while the retired Zero leaf took {region, limit} over storefrontProduct and returned bare rows — same name, two incompatible contracts, so the WS rung silently served the wrong shape. ZQL cannot reproduce the envelope (no COUNT for total, no facet aggregation). Call sites pin the REST path via useRestSyncQuery; a future Zero leaf needs a NEW name plus client-side envelope composition.",
  'inventory.page': "Same contract collision as catalog.page (WI-39855): the REST registration is the seller-scoped CatalogPage envelope search ({q, productType, availability, page, pageSize}), the retired Zero leaf was {sellerId, limit} bare storefrontProduct rows. Also envelope-blocked in ZQL (no COUNT/facets). Call sites pin the REST path via useRestSyncQuery.",
  'catalog.types': 'Distinct-value aggregate over product_catalog.product_type. ZQL has no DISTINCT/aggregate; derive it client-side from catalog.page or keep the REST handler.',
  'event.chat.stats': 'Aggregate counts over chat_message + chat_presence. ZQL has no COUNT; derive client-side from event.chat.messages / event.chat.presence or keep the REST handler.',
  'event.stats': 'Aggregate over event + checkout_order + auction_state. Same COUNT/SUM limitation as event.chat.stats.',
  'event.pricingHistory': 'Fan-in composite over an aggregate, not a table read: PricingHistoryService.read (apps/api/src/stats/stats.module.ts:99) merges three sources — a SUM/FILTER/GROUP BY over checkout_order CROSS JOIN LATERAL jsonb_array_elements(payload->\'items\'), the offer snapshots in action_audit_entry (via GuardedActionService.listAudit), and auction_state (via AuctionService.listByProduct). Two independent blockers, the same pair as orders.byBuyer: (1) ZQL has no SUM/GROUP BY, the same limitation recorded above for event.stats and event.chat.stats; (2) ZQL cannot union three sources into one result set. Replicating any single table does NOT unblock it — the Zero-native replacement is client-side composition over separate leaves, a call-site change rather than a rename.',
  'orders.byBuyer': 'Fan-in composite, not a table read: BuyerOrdersService.listForBuyer merges OrderStore.listByBuyer + AuctionService.listWinnerOrdersForBuyer + GuardedActionService.listOffersForBuyer + EventService.listForGuide, then decorates each row with chat replay chapters (apps/api/src/checkout/buyer-orders.service.ts:76). Two independent blockers: (1) ZQL cannot union four sources into one result set; (2) neither `cart` nor `checkout_order` carries a buyer column at all (db/schema.sql) — the buyer is derived from the request principal, so even the checkout_order leg alone is not filterable in ZQL. The Zero-native replacement is the `orders.byCart` / `orders.byId` pair below plus client-side composition; that is a P-004 call-site change, NOT a drop-in rename.',
};

/**
 * Synced queries this contract defines that NO `SyncQueryRegistry` registration
 * serves yet. They are deliberate forward scope, not drift — but they are listed
 * explicitly so the parity test can tell "planned" apart from "accidentally
 * invented", and so nothing ships a client call site whose name the `/zero/query`
 * handler would 404 on.
 */
export const CONTRACT_AHEAD_OF_REGISTRY: Readonly<Record<string, string>> = {
  'events.byId': 'Single-event read; the web client currently filters events.guide client-side.',
  'event.auction.history': 'Closed-auction history; no REST equivalent is registered today.',
  'event.audit.entries': 'Seller audit trail over action_audit_entry; no REST equivalent is registered today.',
  'catalog.byId': 'Single-product read; the web client currently filters catalog.page client-side.',
  'orders.byCart': 'Zero-native replacement leg for the unsynced orders.byBuyer composite (see UNSYNCED_QUERY_REASONS). Adopting it is a P-004 call-site change.',
  'orders.byId': 'Zero-native single-order read; the REST equivalent is GET /checkout/orders/:id, not a sync query.',
  'policy.published': 'Published seller policy revisions; today they reach the client folded into event.config.',
};
