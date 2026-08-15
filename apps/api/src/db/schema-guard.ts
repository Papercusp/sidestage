/**
 * The single query this guard runs, as a structural type.
 *
 * Deliberately NOT Pick<Pool, 'query'>: pg types `query` as a stack of
 * overloads (Submittable, QueryArrayConfig, QueryConfig, text+values), and a
 * test double can never satisfy all of them — you end up widening the double
 * with `as unknown as Pool`, which throws away the very type-checking that
 * would catch a real mistake. A real Pool satisfies this narrow shape, and so
 * does an honest fake.
 */
export interface SchemaQueryable {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Array<{ table_name?: string; marker?: string }> }>;
}

/**
 * Boot-time schema drift guard.
 *
 * db/schema.sql is mounted at /docker-entrypoint-initdb.d (docker-compose.prod.yml,
 * infra/docker-compose.data.yml), and Postgres runs that directory ONLY when it
 * initialises an EMPTY data volume. So any table added to schema.sql after a dev
 * volume already exists is never created, and nothing reports the drift — the
 * store seams keep resolving, and the first query against the missing table 500s
 * at request time instead.
 *
 * That is not hypothetical: the P-114 policy block (seller_policy_revision and
 * friends) was absent from an existing dev database, so GET /events/:id/config
 * 500'd for EVERY event. It stayed invisible because the only buyer-side caller
 * swallowed the error and rendered its placeholder, which looks exactly like an
 * event that has no thumbnail.
 *
 * So: check once, at the moment the pool is confirmed reachable, and fail loudly
 * naming the missing tables and the one-line remedy. A boot that cannot serve
 * correctly should not start.
 */

/**
 * Every table db/schema.sql creates.
 *
 * Kept as a literal rather than parsed from schema.sql at runtime because the
 * production image ships only apps/api/dist and libs/typesense/dist — schema.sql
 * is not in it, so a runtime read would degrade to "no check" exactly where the
 * check still has value. schema-guard.test.ts parses the real file and fails if
 * this list drifts from it, which keeps the literal honest without the runtime
 * file dependency.
 */
export const REQUIRED_TABLES: readonly string[] = [
  'auction_state',
  'cart',
  'chat_message',
  'chat_presence',
  'chat_transcript_moment',
  'checkout_order',
  'copilot_proposal',
  'event',
  'event_config',
  'event_run_of_show',
  'inventory_reservation',
  'policy_audit_entry',
  'policy_idempotency',
  'policy_outbox_event',
  'product_catalog',
  'product_option_axes',
  'product_option_values',
  'scout_memory',
  'scout_session',
  'seller_policy_revision',
  'storefront_product',
  'storefront_product_option',
  'system_test_artifact',
  'system_test_cancellation',
  'system_test_case',
  'system_test_cleanup',
  'system_test_environment',
  'system_test_fixture_lease',
  'system_test_fixture_resource',
  'system_test_retention',
  'system_test_run',
  'system_test_suite',
  'system_test_transition',
];

/**
 * Ownership structures that must exist in addition to the tables themselves.
 *
 * The original guard only noticed a wholly missing table. P-002 evolves
 * existing tables in place, so a stale volume can have every table while still
 * lacking the columns, foreign keys, and immutable-owner triggers that make
 * cross-user isolation real. These catalog markers keep that partial-migration
 * state from booting quietly.
 */
export const REQUIRED_OWNERSHIP_STRUCTURES: readonly string[] = [
  'column:auction_state.seller_id',
  'column:inventory_reservation.seller_id',
  'column:scout_session.buyer_id',
  'column:storefront_product.seller_id',
  'constraint:auction_state_event_owner_fk',
  'constraint:copilot_proposal_event_fk',
  'constraint:event_config_event_fk',
  'constraint:event_run_of_show_event_fk',
  'constraint:inventory_reservation_variant_owner_fk',
  'trigger:auction_state_preserve_seller',
  'trigger:event_preserve_seller',
  'trigger:inventory_reservation_preserve_seller',
  'trigger:scout_session_preserve_buyer',
  'trigger:storefront_product_preserve_seller',
];

/** Canonical payable-order structures introduced by the Stripe/order plan. */
export const REQUIRED_ORDER_STRUCTURES: readonly string[] = [
  'column:checkout_order.buyer_id',
  'column:checkout_order.payment_state',
  'column:checkout_order.source_id',
  'column:checkout_order.source_kind',
  'column:checkout_order.stripe_payment_intent_id',
  'constraint:checkout_order_payment_state_check',
  'constraint:checkout_order_payload_identity',
  'constraint:checkout_order_source_kind_check',
  'index:checkout_order_buyer_payment_state_idx',
  'index:checkout_order_source_unique',
  'index:checkout_order_stripe_payment_intent_unique',
  'trigger:checkout_order_preserve_buyer',
  'trigger:checkout_order_preserve_source_id',
  'trigger:checkout_order_preserve_source_kind',
];

/** Durable chat structures required for idempotency, paging, and restart-safe reads. */
export const REQUIRED_CHAT_STRUCTURES: readonly string[] = [
  'constraint:chat_message_event_fk',
  'constraint:chat_presence_event_fk',
  'constraint:chat_transcript_moment_event_fk',
  'index:chat_message_copilot_queue_idx',
  'index:chat_message_idempotency_unique',
  'index:chat_message_visible_page_idx',
  'index:chat_presence_freshness_idx',
  'index:chat_transcript_event_timeline_idx',
];

/** The remedy, in one place — it appears in the thrown message and the README. */
export const SCHEMA_APPLY_REMEDY = 'npm run db:apply';

/**
 * Which of `required` are absent from the connected database's public schema.
 * Returned in the caller's order so the message is stable and diffable.
 */
export async function findMissingTables(
  pool: SchemaQueryable,
  required: readonly string[] = REQUIRED_TABLES,
): Promise<string[]> {
  if (required.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[...required]],
  );
  const present = new Set(rows.map((row) => row.table_name).filter((name): name is string => Boolean(name)));
  return required.filter((table) => !present.has(table));
}

/** Required P-002 ownership markers absent from the connected public schema. */
export async function findMissingSchemaStructures(
  pool: SchemaQueryable,
  required: readonly string[],
): Promise<string[]> {
  if (required.length === 0) return [];
  const { rows } = await pool.query(
    `WITH present AS (
       SELECT 'column:' || table_name || '.' || column_name AS marker
         FROM information_schema.columns
        WHERE table_schema = 'public'
       UNION ALL
       SELECT 'constraint:' || constraint_name AS marker
         FROM information_schema.table_constraints
        WHERE constraint_schema = 'public'
       UNION ALL
       SELECT 'trigger:' || trigger_name AS marker
         FROM information_schema.triggers
        WHERE trigger_schema = 'public'
       UNION ALL
       SELECT 'index:' || indexname AS marker
         FROM pg_indexes
        WHERE schemaname = 'public'
     )
     SELECT marker FROM present WHERE marker = ANY($1::text[])`,
    [[...required]],
  );
  const present = new Set(rows.map((row) => row.marker).filter((marker): marker is string => Boolean(marker)));
  return required.filter((marker) => !present.has(marker));
}

/** Required demo-principal ownership markers absent from the public schema. */
export function findMissingOwnershipStructures(
  pool: SchemaQueryable,
  required: readonly string[] = REQUIRED_OWNERSHIP_STRUCTURES,
): Promise<string[]> {
  return findMissingSchemaStructures(pool, required);
}

/** Required canonical payable-order markers absent from the public schema. */
export function findMissingOrderStructures(
  pool: SchemaQueryable,
  required: readonly string[] = REQUIRED_ORDER_STRUCTURES,
): Promise<string[]> {
  return findMissingSchemaStructures(pool, required);
}

/** Required durable-chat markers absent from the public schema. */
export function findMissingChatStructures(
  pool: SchemaQueryable,
  required: readonly string[] = REQUIRED_CHAT_STRUCTURES,
): Promise<string[]> {
  return findMissingSchemaStructures(pool, required);
}

/**
 * The operator-facing drift message. Names every missing table (not just a
 * count) and the exact command that fixes it, because the failure is silent by
 * nature and whoever hits it has no other breadcrumb.
 */
export function formatSchemaDriftMessage(missing: readonly string[]): string {
  const lines = [
    `schema drift — ${missing.length} table(s) missing from the database:`,
    ...missing.map((table) => `    ${table}`),
    '',
    'db/schema.sql only runs when Postgres initialises an EMPTY volume, so tables',
    'added to it later never reach an existing database.',
    '',
    `  remedy: ${SCHEMA_APPLY_REMEDY}`,
    '',
    'That re-applies db/schema.sql, which is idempotent (every CREATE is guarded),',
    'so it is safe to run against a database that is only partially behind.',
  ];
  return lines.join('\n');
}

export function formatOwnershipDriftMessage(missing: readonly string[]): string {
  return [
    `schema drift — ${missing.length} ownership structure(s) missing from the database:`,
    ...missing.map((marker) => `    ${marker}`),
    '',
    'The tables exist, but this volume has not received the complete demo-principal',
    'ownership migration. Starting would make user isolation depend on stale schema.',
    '',
    `  remedy: ${SCHEMA_APPLY_REMEDY}`,
  ].join('\n');
}

export function formatOrderDriftMessage(missing: readonly string[]): string {
  return [
    `schema drift — ${missing.length} payable-order structure(s) missing from the database:`,
    ...missing.map((marker) => `    ${marker}`),
    '',
    'The checkout_order table exists, but this volume has not received the',
    'canonical cart/auction/offer order migration. Starting would permit duplicate',
    'sources or make payment recovery depend on unindexed JSON fields.',
    '',
    `  remedy: ${SCHEMA_APPLY_REMEDY}`,
  ].join('\n');
}

export function formatChatDriftMessage(missing: readonly string[]): string {
  return [
    `schema drift — ${missing.length} durable-chat structure(s) missing from the database:`,
    ...missing.map((marker) => `    ${marker}`),
    '',
    'The chat tables exist, but idempotency, paging, or event ownership is only',
    'partially applied. Starting would make public chat fail or fork after retries.',
    '',
    `  remedy: ${SCHEMA_APPLY_REMEDY}`,
  ].join('\n');
}

/**
 * Throws when the connected database is missing tables the code queries.
 *
 * Deliberately fatal rather than a warning: the alternative is the status quo,
 * where the process starts and then 500s per request, which is what hid this for
 * as long as it did. Falling back to the in-memory stores would be worse still —
 * it would silently strand whatever durable data the database does hold.
 */
export async function assertSchemaCurrent(
  pool: SchemaQueryable,
  required: readonly string[] = REQUIRED_TABLES,
): Promise<void> {
  const missing = await findMissingTables(pool, required);
  if (missing.length > 0) throw new Error(formatSchemaDriftMessage(missing));
  const missingOwnership = await findMissingOwnershipStructures(pool);
  if (missingOwnership.length > 0) {
    throw new Error(formatOwnershipDriftMessage(missingOwnership));
  }
  const missingOrder = await findMissingOrderStructures(pool);
  if (missingOrder.length > 0) {
    throw new Error(formatOrderDriftMessage(missingOrder));
  }
  const missingChat = await findMissingChatStructures(pool);
  if (missingChat.length > 0) {
    throw new Error(formatChatDriftMessage(missingChat));
  }
}
