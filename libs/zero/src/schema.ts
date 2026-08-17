/**
 * SideStage Zero schema — the client-side shape of every replicated table.
 *
 * Hand-derived from `db/schema.sql` (Postgres is the sole authority; this file
 * is a projection of it, never a second source of truth). The companion
 * parity test in `apps/api/src/sync/zero-contract.parity.test.ts` fails the
 * build if a table declared here stops matching schema.sql, or if a
 * `replicate`-disposition surface in the data-surface census has no table here.
 *
 * Conventions, all borrowed from the Restart reference implementation
 * (/home/marsh-office/Restart/libs/zero/src/schema.ts):
 *
 *   - Table names are camelCase in ZQL, `.from('snake_case')` to Postgres.
 *   - Column names are camelCase in ZQL, `.from('snake_case')` to Postgres.
 *   - TIMESTAMPS ARE `number()` (epoch ms), NOT `string()`. zero-cache converts
 *     Postgres timestamptz to epoch milliseconds on the wire. Declaring one as
 *     string() is the single most common Zero schema bug.
 *   - `jsonb` columns are `json()`. SideStage lifts hot columns out of its
 *     jsonb documents, so the payload stays available without being the only
 *     way to read the row.
 *
 * ── Columns deliberately NOT declared here (P-003 publication constraints) ──
 *
 *   product_catalog.search_tsv   — `tsvector` has no Zero column type. The
 *                                  publication MUST use a PG15+ column list
 *                                  that omits it, or zero-cache refuses the
 *                                  table at initial sync.
 *   storefront_product.availableQty — GENERATED ALWAYS ... STORED. Postgres
 *                                  logical replication does not publish
 *                                  generated columns before PG17
 *                                  (`publish_generated_columns`). It is
 *                                  declared `.optional()` below so the client
 *                                  type is honest either way; consumers should
 *                                  derive `qty - reservedQty` rather than rely
 *                                  on it until P-003 confirms the server
 *                                  version publishes it.
 */
import {
  boolean,
  createBuilder,
  createSchema,
  json,
  number,
  relationships,
  Row,
  string,
  table,
} from '@rocicorp/zero';

// ── Event domain ────────────────────────────────────────────────────────────

/** db/schema.sql: `event` — the live-selling event itself. */
export const event = table('event')
  .from('event')
  .columns({
    eventId: string().from('event_id'),
    title: string(),
    sellerId: string().from('seller_id'),
    sellerName: string().from('seller_name'),
    status: string(), // 'draft' | 'scheduled' | 'live' | 'ended'
    startsAt: number().optional().from('starts_at'),
    endedAt: number().optional().from('ended_at'),
    thumbnailUrl: string().optional().from('thumbnail_url'),
    createdAt: number().from('created_at'),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('eventId');

/** db/schema.sql: `event_lineup_item` — the restart-safe lineup authority. */
export const eventLineupItem = table('eventLineupItem')
  .from('event_lineup_item')
  .columns({
    eventItemId: string().from('event_item_id'),
    eventId: string().from('event_id'),
    productId: string().from('product_id'),
    position: number(),
    referencePriceCents: number().from('reference_price_cents'),
    currentPriceCents: number().from('current_price_cents'),
    listedQuantity: number().from('listed_quantity'),
    currentQuantity: number().from('current_quantity'),
    stageState: string().from('stage_state'), // 'queued' | 'on-stage' | 'completed'
    title: string(),
    description: string().optional(),
    attributes: json(),
    version: number(),
    createdAt: number().from('created_at'),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('eventItemId');

/** db/schema.sql: `event_config` — one jsonb settings document per event. */
export const eventConfig = table('eventConfig')
  .from('event_config')
  .columns({
    eventId: string().from('event_id'),
    payload: json(),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('eventId');

/** db/schema.sql: `event_run_of_show` — advisory seller run-of-show plan. */
export const eventRunOfShow = table('eventRunOfShow')
  .from('event_run_of_show')
  .columns({
    eventId: string().from('event_id'),
    payload: json(),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('eventId');

// ── Auction ─────────────────────────────────────────────────────────────────

/** db/schema.sql: `auction_state` — transaction-owned auction aggregate. */
export const auctionState = table('auctionState')
  .from('auction_state')
  .columns({
    id: string(),
    eventId: string().from('event_id'),
    eventItemId: string().from('event_item_id'),
    productId: string().from('product_id'),
    status: string(), // 'active' | 'closed'
    quantity: number(),
    currentPriceCents: number().from('current_price_cents'),
    winnerBidderId: string().optional().from('winner_bidder_id'),
    startedAt: number().from('started_at'),
    endsAt: number().from('ends_at'),
    closedAt: number().optional().from('closed_at'),
    payload: json(),
    createdAt: number().from('created_at'),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('id');

// ── Chat ────────────────────────────────────────────────────────────────────

/** db/schema.sql: `chat_message` — durable room messages. */
export const chatMessage = table('chatMessage')
  .from('chat_message')
  .columns({
    id: string(),
    eventId: string().from('event_id'),
    userId: string().from('user_id'),
    displayName: string().from('display_name'),
    role: string(), // 'buyer' | 'seller'
    text: string(),
    grounding: json().optional(),
    clientRequestId: string().optional().from('client_request_id'),
    createdAt: number().from('created_at'),
    moderatedAt: number().optional().from('moderated_at'),
    moderatedBy: string().optional().from('moderated_by'),
    moderationReason: string().optional().from('moderation_reason'),
  })
  .primaryKey('id');

/** db/schema.sql: `chat_presence` — composite (event_id, user_id) primary key. */
export const chatPresence = table('chatPresence')
  .from('chat_presence')
  .columns({
    eventId: string().from('event_id'),
    userId: string().from('user_id'),
    displayName: string().from('display_name'),
    role: string(), // 'buyer' | 'seller'
    lastSeenAt: number().from('last_seen_at'),
  })
  .primaryKey('eventId', 'userId');

/** db/schema.sql: `chat_transcript_moment` — replay chapters / transcript. */
export const chatTranscriptMoment = table('chatTranscriptMoment')
  .from('chat_transcript_moment')
  .columns({
    id: string(),
    eventId: string().from('event_id'),
    text: string(),
    startMs: number().optional().from('start_ms'),
    endMs: number().optional().from('end_ms'),
    productId: string().optional().from('product_id'),
    productTitle: string().optional().from('product_title'),
    createdAt: number().from('created_at'),
  })
  .primaryKey('id');

// ── Seller copilot, policy, audit ───────────────────────────────────────────

/** db/schema.sql: `copilot_proposal` — the seller Copilot review queue. */
export const copilotProposal = table('copilotProposal')
  .from('copilot_proposal')
  .columns({
    id: string(),
    eventId: string().from('event_id'),
    sourceMessageId: string().from('source_message_id'),
    status: string(), // 'pending' | 'approved' | 'skipped' | 'blocked' | 'executed'
    revision: number(),
    payload: json(),
    createdAt: number().from('created_at'),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('id');

/** db/schema.sql: `seller_policy_revision` — immutable policy revisions. */
export const sellerPolicyRevision = table('sellerPolicyRevision')
  .from('seller_policy_revision')
  .columns({
    id: string(),
    sellerId: string().from('seller_id'),
    eventId: string().optional().from('event_id'),
    revision: number(),
    state: string(), // 'draft' | 'validated' | 'published' | 'superseded' | 'rejected'
    fingerprint: string(),
    payload: json(),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('id');

/** db/schema.sql: `action_audit_entry` — immutable guarded-action evidence. */
export const actionAuditEntry = table('actionAuditEntry')
  .from('action_audit_entry')
  .columns({
    id: string(),
    eventId: string().from('event_id'),
    actorId: string().from('actor_id'),
    kind: string(),
    productId: string().from('product_id'),
    buyerId: string().optional().from('buyer_id'),
    reason: string(),
    beforeState: json().from('before_state'),
    afterState: json().from('after_state'),
    clientRequestId: string().optional().from('client_request_id'),
    rollbackOf: string().optional().from('rollback_of'),
    rolledBackAt: number().optional().from('rolled_back_at'),
    createdAt: number().from('created_at'),
  })
  .primaryKey('id');

/**
 * db/schema.sql: `targeted_offer` — a seller's guarded offer aimed at one buyer.
 *
 * Timestamps map to `number()` for the same reason `actionAuditEntry` does: the
 * columns are `timestamptz`, and Zero carries them as epoch millis client-side.
 * `version` backs the compare-and-set in PgTargetedOfferStore.setStatus, so it
 * is replicated rather than hidden — a client that renders an offer needs the
 * same version it would send back.
 */
export const targetedOffer = table('targetedOffer')
  .from('targeted_offer')
  .columns({
    offerId: string().from('offer_id'),
    eventId: string().from('event_id'),
    eventItemId: string().from('event_item_id'),
    productId: string().from('product_id'),
    buyerId: string().from('buyer_id'),
    priceCents: number().from('price_cents'),
    quantity: number(),
    status: string(), // 'pending' | 'accepted' | 'cancelled'
    auditId: string().optional().from('audit_id'),
    clientRequestId: string().optional().from('client_request_id'),
    version: number(),
    createdAt: number().from('created_at'),
    updatedAt: number().from('updated_at'),
    acceptedAt: number().optional().from('accepted_at'),
    cancelledAt: number().optional().from('cancelled_at'),
  })
  .primaryKey('offerId');

// ── Buyer: cart, orders, reservations ───────────────────────────────────────

/** db/schema.sql: `cart` — single-writer buyer cart document. */
export const cart = table('cart')
  .from('cart')
  .columns({
    id: string(),
    payload: json(),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('id');

/** db/schema.sql: `checkout_order` — buyer order lifecycle. */
export const checkoutOrder = table('checkoutOrder')
  .from('checkout_order')
  .columns({
    id: string(),
    cartId: string().from('cart_id'),
    status: string(), // 'pending' | 'paid' | 'failed'
    payload: json(),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('id');

/** db/schema.sql: `inventory_reservation` — held/consumed stock. */
export const inventoryReservation = table('inventoryReservation')
  .from('inventory_reservation')
  .columns({
    id: number(), // bigint GENERATED BY DEFAULT AS IDENTITY
    variantId: string().from('variant_id'),
    sellerId: string().optional().from('seller_id'),
    sourceKind: string().from('source_kind'),
    sourceId: string().from('source_id'),
    quantity: number(),
    state: string(),
    expiresAt: number().optional().from('expires_at'),
    createdAt: number().from('created_at'),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('id');

// ── Catalog ─────────────────────────────────────────────────────────────────

/**
 * db/schema.sql: `product_catalog` — composite (group_id, region) primary key.
 * `search_tsv` is intentionally absent: see the header note.
 */
export const productCatalog = table('productCatalog')
  .from('product_catalog')
  .columns({
    groupId: string().from('group_id'),
    region: string(),
    productType: string().from('product_type'),
    title: string(),
    description: string(),
    brand: string(),
    manufacturer: string().optional(),
    countryOfOrigin: string().optional().from('country_of_origin'),
    variantSlug: string().optional().from('variant_slug'),
    identifiers: json(),
    properties: json(),
    images: json(),
    bullets: json(),
    weight: json().optional(),
    dimensions: json().optional(),
    tier1: number().from('tier_1'),
    tier1Discount: number().from('tier_1_discount'),
    tier2: number().from('tier_2'),
    tier2Discount: number().from('tier_2_discount'),
    tier3: number().from('tier_3'),
    tier3Discount: number().from('tier_3_discount'),
    tier4: number().from('tier_4'),
    tier4Discount: number().from('tier_4_discount'),
    tier5: number().from('tier_5'),
    tier5Discount: number().from('tier_5_discount'),
    createdAt: number().from('created_at'),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('groupId', 'region');

/**
 * db/schema.sql: `storefront_product` — sellable variant identity, stock, price.
 * `availableQty` is a STORED generated column; see the header note.
 */
export const storefrontProduct = table('storefrontProduct')
  .from('storefront_product')
  .columns({
    id: string(),
    slug: string(),
    region: string(),
    sku: string(),
    sellerId: string().optional().from('seller_id'),
    priceCents: number().from('price_cents'),
    active: boolean(),
    groupId: string().optional().from('group_id'),
    condition: string().optional(),
    handling: number().optional(),
    optionSignature: string().from('option_signature'),
    variantImages: json().from('variant_images'),
    qty: number(),
    reservedQty: number().from('reserved_qty'),
    // NOTE: `availableQty` is deliberately ABSENT — it is GENERATED ALWAYS AS
    // (GREATEST(0, qty - reserved_qty)) STORED (db/schema.sql:63) and is not
    // carried by logical replication, so declaring it here would promise the
    // client a column that never arrives. Derive it from the two replicated
    // columns instead: Math.max(0, row.qty - row.reservedQty).
    createdAt: number().from('created_at'),
    updatedAt: number().from('updated_at'),
  })
  .primaryKey('id');

/** db/schema.sql: `product_option_axes`. */
export const productOptionAxis = table('productOptionAxis')
  .from('product_option_axes')
  .columns({
    id: string(),
    groupId: string().from('group_id'),
    region: string(),
    slug: string(),
    label: string(),
    position: number(),
    required: boolean(),
  })
  .primaryKey('id');

/** db/schema.sql: `product_option_values`. */
export const productOptionValue = table('productOptionValue')
  .from('product_option_values')
  .columns({
    id: string(),
    axisId: string().from('axis_id'),
    slug: string(),
    label: string(),
    position: number(),
    metadata: json(),
  })
  .primaryKey('id');

/** db/schema.sql: `storefront_product_option` — variant ↔ option join rows. */
export const storefrontProductOption = table('storefrontProductOption')
  .from('storefront_product_option')
  .columns({
    variantId: string().from('variant_id'),
    axisId: string().from('axis_id'),
    valueId: string().from('value_id'),
  })
  .primaryKey('variantId', 'axisId', 'valueId');

// ── Relationships ───────────────────────────────────────────────────────────

export const eventRelationships = relationships(event, ({ many, one }) => ({
  lineup: many({ sourceField: ['eventId'], destSchema: eventLineupItem, destField: ['eventId'] }),
  messages: many({ sourceField: ['eventId'], destSchema: chatMessage, destField: ['eventId'] }),
  presence: many({ sourceField: ['eventId'], destSchema: chatPresence, destField: ['eventId'] }),
  transcript: many({
    sourceField: ['eventId'],
    destSchema: chatTranscriptMoment,
    destField: ['eventId'],
  }),
  auctions: many({ sourceField: ['eventId'], destSchema: auctionState, destField: ['eventId'] }),
  config: one({ sourceField: ['eventId'], destSchema: eventConfig, destField: ['eventId'] }),
  runOfShow: one({ sourceField: ['eventId'], destSchema: eventRunOfShow, destField: ['eventId'] }),
}));

export const eventLineupItemRelationships = relationships(eventLineupItem, ({ one }) => ({
  event: one({ sourceField: ['eventId'], destSchema: event, destField: ['eventId'] }),
  // The buyer lineup renders price/stock from storefront_product and
  // title/images/type from product_catalog — the same JOIN the REST
  // `event.lineup.items` handler performs, so the Zero-rendered lineup matches
  // the SSE-rendered one row for row.
  product: one({ sourceField: ['productId'], destSchema: storefrontProduct, destField: ['id'] }),
}));

export const auctionStateRelationships = relationships(auctionState, ({ one }) => ({
  event: one({ sourceField: ['eventId'], destSchema: event, destField: ['eventId'] }),
  product: one({ sourceField: ['productId'], destSchema: storefrontProduct, destField: ['id'] }),
  lineupItem: one({
    sourceField: ['eventItemId'],
    destSchema: eventLineupItem,
    destField: ['eventItemId'],
  }),
}));

export const chatMessageRelationships = relationships(chatMessage, ({ one }) => ({
  event: one({ sourceField: ['eventId'], destSchema: event, destField: ['eventId'] }),
}));

export const chatTranscriptMomentRelationships = relationships(
  chatTranscriptMoment,
  ({ one }) => ({
    event: one({ sourceField: ['eventId'], destSchema: event, destField: ['eventId'] }),
  }),
);

export const copilotProposalRelationships = relationships(copilotProposal, ({ one }) => ({
  event: one({ sourceField: ['eventId'], destSchema: event, destField: ['eventId'] }),
  sourceMessage: one({
    sourceField: ['sourceMessageId'],
    destSchema: chatMessage,
    destField: ['id'],
  }),
}));

export const actionAuditEntryRelationships = relationships(actionAuditEntry, ({ one }) => ({
  event: one({ sourceField: ['eventId'], destSchema: event, destField: ['eventId'] }),
  product: one({ sourceField: ['productId'], destSchema: storefrontProduct, destField: ['id'] }),
}));

export const targetedOfferRelationships = relationships(targetedOffer, ({ one }) => ({
  event: one({ sourceField: ['eventId'], destSchema: event, destField: ['eventId'] }),
  item: one({ sourceField: ['eventItemId'], destSchema: eventLineupItem, destField: ['eventItemId'] }),
  product: one({ sourceField: ['productId'], destSchema: storefrontProduct, destField: ['id'] }),
  audit: one({ sourceField: ['auditId'], destSchema: actionAuditEntry, destField: ['id'] }),
}));

export const checkoutOrderRelationships = relationships(checkoutOrder, ({ one }) => ({
  cart: one({ sourceField: ['cartId'], destSchema: cart, destField: ['id'] }),
}));

export const storefrontProductRelationships = relationships(storefrontProduct, ({ many, one }) => ({
  catalog: one({
    sourceField: ['groupId', 'region'],
    destSchema: productCatalog,
    destField: ['groupId', 'region'],
  }),
  options: many({
    sourceField: ['id'],
    destSchema: storefrontProductOption,
    destField: ['variantId'],
  }),
  reservations: many({
    sourceField: ['id'],
    destSchema: inventoryReservation,
    destField: ['variantId'],
  }),
}));

export const productCatalogRelationships = relationships(productCatalog, ({ many }) => ({
  variants: many({
    sourceField: ['groupId', 'region'],
    destSchema: storefrontProduct,
    destField: ['groupId', 'region'],
  }),
  axes: many({
    sourceField: ['groupId', 'region'],
    destSchema: productOptionAxis,
    destField: ['groupId', 'region'],
  }),
}));

export const productOptionAxisRelationships = relationships(productOptionAxis, ({ many }) => ({
  values: many({ sourceField: ['id'], destSchema: productOptionValue, destField: ['axisId'] }),
}));

export const storefrontProductOptionRelationships = relationships(
  storefrontProductOption,
  ({ one }) => ({
    axis: one({ sourceField: ['axisId'], destSchema: productOptionAxis, destField: ['id'] }),
    value: one({ sourceField: ['valueId'], destSchema: productOptionValue, destField: ['id'] }),
    variant: one({ sourceField: ['variantId'], destSchema: storefrontProduct, destField: ['id'] }),
  }),
);

// ── Schema ──────────────────────────────────────────────────────────────────

export const schema = createSchema({
  tables: [
    event,
    eventLineupItem,
    eventConfig,
    eventRunOfShow,
    auctionState,
    chatMessage,
    chatPresence,
    chatTranscriptMoment,
    copilotProposal,
    sellerPolicyRevision,
    actionAuditEntry,
    targetedOffer,
    cart,
    checkoutOrder,
    inventoryReservation,
    productCatalog,
    storefrontProduct,
    productOptionAxis,
    productOptionValue,
    storefrontProductOption,
  ],
  relationships: [
    eventRelationships,
    eventLineupItemRelationships,
    auctionStateRelationships,
    chatMessageRelationships,
    chatTranscriptMomentRelationships,
    copilotProposalRelationships,
    actionAuditEntryRelationships,
    targetedOfferRelationships,
    checkoutOrderRelationships,
    storefrontProductRelationships,
    productCatalogRelationships,
    productOptionAxisRelationships,
    storefrontProductOptionRelationships,
  ],
});

export type Schema = typeof schema;

/** ZQL builder — `zql.chatMessage.where('eventId', id)`. */
export const zql = createBuilder(schema);

/**
 * The Postgres table names this schema replicates, in declaration order.
 * `db/schema.sql` and the P-003 publication are both checked against this list,
 * so adding a table here is the single edit that widens replication.
 */
export const REPLICATED_TABLES = [
  'event',
  'event_lineup_item',
  'event_config',
  'event_run_of_show',
  'auction_state',
  'chat_message',
  'chat_presence',
  'chat_transcript_moment',
  'copilot_proposal',
  'seller_policy_revision',
  'action_audit_entry',
  'targeted_offer',
  'cart',
  'checkout_order',
  'inventory_reservation',
  'product_catalog',
  'storefront_product',
  'product_option_axes',
  'product_option_values',
  'storefront_product_option',
] as const;

/**
 * Columns that exist in Postgres but MUST be excluded from the Zero publication
 * (see the header note). P-003's publication DDL is generated from this map, so
 * the exclusion travels with the reason instead of living only in a runbook.
 */
export const UNPUBLISHABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // tsvector has no Zero column type, and it is trigger-maintained server-side.
  product_catalog: ['search_tsv'],
  // GENERATED ALWAYS AS (GREATEST(0, qty - reserved_qty)) STORED — Postgres does
  // not publish stored generated columns before PG17's publish_generated_columns,
  // and it is redundant anyway: both operands are replicated, so the client
  // derives it as Math.max(0, qty - reservedQty).
  storefront_product: ['availableQty'],
};

// Row types
export type EventRow = Row<typeof schema.tables.event>;
export type EventLineupItemRow = Row<typeof schema.tables.eventLineupItem>;
export type EventConfigRow = Row<typeof schema.tables.eventConfig>;
export type EventRunOfShowRow = Row<typeof schema.tables.eventRunOfShow>;
export type AuctionStateRow = Row<typeof schema.tables.auctionState>;
export type ChatMessageRow = Row<typeof schema.tables.chatMessage>;
export type ChatPresenceRow = Row<typeof schema.tables.chatPresence>;
export type ChatTranscriptMomentRow = Row<typeof schema.tables.chatTranscriptMoment>;
export type CopilotProposalRow = Row<typeof schema.tables.copilotProposal>;
export type SellerPolicyRevisionRow = Row<typeof schema.tables.sellerPolicyRevision>;
export type ActionAuditEntryRow = Row<typeof schema.tables.actionAuditEntry>;
export type CartRow = Row<typeof schema.tables.cart>;
export type CheckoutOrderRow = Row<typeof schema.tables.checkoutOrder>;
export type InventoryReservationRow = Row<typeof schema.tables.inventoryReservation>;
export type ProductCatalogRow = Row<typeof schema.tables.productCatalog>;
export type StorefrontProductRow = Row<typeof schema.tables.storefrontProduct>;
export type ProductOptionAxisRow = Row<typeof schema.tables.productOptionAxis>;
export type ProductOptionValueRow = Row<typeof schema.tables.productOptionValue>;
export type StorefrontProductOptionRow = Row<typeof schema.tables.storefrontProductOption>;
