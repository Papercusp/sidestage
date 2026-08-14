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
  ): Promise<{ rows: Array<{ table_name: string }> }>;
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
  'cart',
  'checkout_order',
  'event',
  'event_config',
  'inventory_reservation',
  'policy_audit_entry',
  'policy_idempotency',
  'policy_outbox_event',
  'product_catalog',
  'product_option_axes',
  'product_option_values',
  'seller_policy_revision',
  'storefront_product',
  'storefront_product_option',
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
  const present = new Set(rows.map((row) => row.table_name));
  return required.filter((table) => !present.has(table));
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
}
