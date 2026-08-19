/**
 * D-026 / D-030 — every REPLICATED timestamp column stores MILLISECOND
 * precision, so the Zero rung's epoch-millis projection is integral BY
 * CONSTRUCTION rather than by hoping nobody writes a row with `now()`.
 *
 * WHY THIS EXISTS AS A SCHEMA TEST AND NOT A VALUE TEST
 * The defect is invisible in ordinary fixtures: a seed that SUPPLIES its own
 * timestamps (JS `toISOString()`, millisecond precision) produces whole millis
 * and makes an affected column look exempt, while a seed that omits the column
 * falls to `DEFAULT now()` (microsecond precision) and produces a fraction.
 * That is precisely how this was once mis-scoped to a single table. Asserting
 * on the COLUMN TYPE is fixture-independent — it asks "can this column ever
 * carry sub-millisecond precision", not "did today's rows happen to".
 *
 * The narrowing itself lives in db/schema.sql (applied by scripts/db-apply.sh
 * on every deploy), scoped by the property rather than by a list of tables.
 *
 * Opt in with the repo's existing real-Postgres switch:
 *   SIDESTAGE_PG_INTEGRATION=1 npm run test:file -- \
 *     apps/api/src/sync/parity/replicated-timestamp-precision.integration.test.ts
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_DATABASE_URL } from '../../db/database.module';

const ARMED = process.env.SIDESTAGE_PG_INTEGRATION === '1';

/**
 * `atttypmod` for a `timestamptz` is the declared fractional-seconds precision,
 * or -1 for "no declared precision" — which in Postgres means the maximum,
 * microseconds. So -1 is exactly the defect and 3 is exactly the fix.
 */
const TIMESTAMP_PRECISION_SQL = `
  SELECT c.relname AS table_name, a.attname AS column_name, a.atttypmod AS precision
    FROM pg_publication_tables pt
    JOIN pg_namespace n ON n.nspname = pt.schemaname
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = pt.tablename
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type t ON t.oid = a.atttypid
   WHERE pt.pubname = 'zero_publication'
     AND t.typname = 'timestamptz'
   ORDER BY c.relname, a.attname`;

describe.runIf(ARMED)('replicated timestamp precision (D-026/D-030)', () => {
  let pool: Pool;
  let rows: { table_name: string; column_name: string; precision: number }[];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
    rows = (await pool.query(TIMESTAMP_PRECISION_SQL)).rows;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('POSITIVE CONTROL — the probe actually found replicated timestamp columns', () => {
    // Without this, a publication that does not exist, a renamed catalog view,
    // or a typo'd type name all yield zero rows — and "no column is wrong"
    // would be reported as a pass. An empty result must fail loudly instead.
    expect(
      rows.length,
      'found NO replicated timestamptz columns at all — the probe is broken (or zero_publication is missing), '
        + 'not the schema. Do not read this as parity.',
    ).toBeGreaterThan(0);
  });

  it('every replicated timestamptz column declares millisecond precision', () => {
    const offenders = rows
      .filter((row) => row.precision !== 3)
      .map((row) => `${row.table_name}.${row.column_name} (precision=${row.precision === -1 ? 'microseconds/default' : row.precision})`);

    expect(
      offenders,
      `these replicated columns can carry sub-millisecond precision, so a row written by now() replicates to `
        + `Zero as a FRACTIONAL epoch-millis value and the epoch-millis contract stops being one contract. `
        + `Fix in db/schema.sql (the timestamptz(3) narrowing), never with a Math.trunc on the REST side — `
        + `that leaves Zero fractional and converts a TYPE mismatch into a VALUE mismatch.`,
    ).toEqual([]);
  });
});
