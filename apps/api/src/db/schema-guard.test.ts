import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_OWNERSHIP_STRUCTURES,
  REQUIRED_TABLES,
  SCHEMA_APPLY_REMEDY,
  type SchemaQueryable,
  assertSchemaCurrent,
  findMissingOwnershipStructures,
  findMissingTables,
  formatOwnershipDriftMessage,
  formatSchemaDriftMessage,
} from './schema-guard';

/** db/schema.sql, from the repo root (this file is apps/api/src/db/). */
const SCHEMA_SQL = readFileSync(join(__dirname, '../../../../db/schema.sql'), 'utf8');

/** Every table schema.sql creates, as the file itself declares them. */
function tablesDeclaredInSchemaSql(sql: string): string[] {
  const matches = sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi);
  return [...matches].map((m) => m[1].toLowerCase()).sort();
}

/** A pg Pool stand-in that reports exactly `present` as existing. */
function poolWithTables(
  present: readonly string[],
  ownership: readonly string[] = REQUIRED_OWNERSHIP_STRUCTURES,
): SchemaQueryable {
  return {
    query: async (sql: string, params: unknown[]) => {
      const asked = (params[0] as string[] | undefined) ?? [];
      if (sql.includes('WITH present AS')) {
        return { rows: asked.filter((marker) => ownership.includes(marker)).map((marker) => ({ marker })) };
      }
      return { rows: asked.filter((table) => present.includes(table)).map((table_name) => ({ table_name })) };
    },
  };
}

describe('REQUIRED_TABLES tracks db/schema.sql', () => {
  /**
   * The guard's whole value is that it fails when the database is behind
   * schema.sql. If someone adds a table to schema.sql and not to REQUIRED_TABLES,
   * the guard goes quiet about exactly the new table most likely to be missing —
   * which is the original bug wearing a different hat. This is the test that
   * makes the hand-maintained literal safe.
   */
  it('lists exactly the tables schema.sql creates', () => {
    expect([...REQUIRED_TABLES].sort()).toEqual(tablesDeclaredInSchemaSql(SCHEMA_SQL));
  });

  it('includes the P-114 policy block that was missing in the dev DB', () => {
    // The concrete regression: these four were absent and every
    // GET /events/:id/config 500'd because PolicyService queries the first one.
    expect(REQUIRED_TABLES).toEqual(
      expect.arrayContaining([
        'seller_policy_revision',
        'policy_audit_entry',
        'policy_outbox_event',
        'policy_idempotency',
      ]),
    );
  });

  it('parses a non-trivial number of tables, so a broken regex cannot pass vacuously', () => {
    // Guards the guard: if the matcher silently stopped matching, both this and
    // the equality test would agree on an empty set and report success.
    expect(tablesDeclaredInSchemaSql(SCHEMA_SQL).length).toBeGreaterThanOrEqual(10);
  });

  /**
   * FALSIFIABILITY CONTROL — a guard that has never failed is not known to work.
   *
   * The equality test above only earns trust if it would actually FAIL when
   * schema.sql gains a table nobody added to REQUIRED_TABLES. Proving that by
   * editing schema.sql would be unsafe here: the git-sync routine sweeps the whole
   * tree on a schedule and would happily commit the mutant. So the control feeds a
   * SYNTHETIC schema through the same parser instead — no file is touched, and the
   * proof is permanent rather than a one-off probe someone ran once.
   */
  it('WOULD fail if schema.sql gained a table missing from REQUIRED_TABLES', () => {
    const withNewTable = `${SCHEMA_SQL}\nCREATE TABLE IF NOT EXISTS seller_payout_ledger (id text primary key);\n`;
    const parsed = tablesDeclaredInSchemaSql(withNewTable);

    expect(parsed).toContain('seller_payout_ledger');
    // The assertion the real test makes — here it must NOT hold.
    expect([...REQUIRED_TABLES].sort()).not.toEqual(parsed);
  });
});

describe('findMissingTables', () => {
  it('returns nothing when every required table is present', async () => {
    const pool = poolWithTables(REQUIRED_TABLES);
    await expect(findMissingTables(pool)).resolves.toEqual([]);
  });

  it('returns only the absent tables, in the declared order', async () => {
    const present = REQUIRED_TABLES.filter(
      (t) => t !== 'seller_policy_revision' && t !== 'policy_outbox_event',
    );
    await expect(findMissingTables(poolWithTables(present))).resolves.toEqual([
      'policy_outbox_event',
      'seller_policy_revision',
    ]);
  });

  it('reports every required table when the database is empty', async () => {
    await expect(findMissingTables(poolWithTables([]))).resolves.toEqual([...REQUIRED_TABLES]);
  });

  it('does not query at all for an empty requirement set', async () => {
    let called = false;
    const pool: SchemaQueryable = {
      query: async () => { called = true; return { rows: [] }; },
    };
    await expect(findMissingTables(pool, [])).resolves.toEqual([]);
    expect(called).toBe(false);
  });
});

describe('ownership schema guard', () => {
  it('tracks the columns, foreign keys, and immutable-owner triggers introduced by P-002', () => {
    expect(REQUIRED_OWNERSHIP_STRUCTURES).toEqual(
      expect.arrayContaining([
        'column:storefront_product.seller_id',
        'column:inventory_reservation.seller_id',
        'column:scout_session.buyer_id',
        'constraint:event_config_event_fk',
        'constraint:auction_state_event_owner_fk',
        'trigger:event_preserve_seller',
        'trigger:scout_session_preserve_buyer',
      ]),
    );
  });

  it('reports a partially-applied ownership migration even when every table exists', async () => {
    const present = REQUIRED_OWNERSHIP_STRUCTURES.filter(
      (marker) => marker !== 'constraint:event_config_event_fk',
    );
    await expect(findMissingOwnershipStructures(poolWithTables(REQUIRED_TABLES, present))).resolves.toEqual([
      'constraint:event_config_event_fk',
    ]);
    await expect(assertSchemaCurrent(poolWithTables(REQUIRED_TABLES, present))).rejects.toThrow(
      /constraint:event_config_event_fk/,
    );
  });

  it('names the apply remedy for ownership drift', () => {
    expect(formatOwnershipDriftMessage(['column:scout_session.buyer_id'])).toContain(SCHEMA_APPLY_REMEDY);
  });
});

describe('assertSchemaCurrent', () => {
  it('resolves when the schema is current', async () => {
    await expect(assertSchemaCurrent(poolWithTables(REQUIRED_TABLES))).resolves.toBeUndefined();
  });

  it('throws naming every missing table and the remedy', async () => {
    const present = REQUIRED_TABLES.filter((t) => t !== 'seller_policy_revision');
    await expect(assertSchemaCurrent(poolWithTables(present))).rejects.toThrow(
      /seller_policy_revision/,
    );
    await expect(assertSchemaCurrent(poolWithTables(present))).rejects.toThrow(
      new RegExp(SCHEMA_APPLY_REMEDY.replace(/ /g, '\\s')),
    );
  });
});

describe('formatSchemaDriftMessage', () => {
  it('names each missing table on its own line and states the count', () => {
    const message = formatSchemaDriftMessage(['seller_policy_revision', 'policy_audit_entry']);
    expect(message).toContain('2 table(s) missing');
    expect(message).toContain('\n    seller_policy_revision');
    expect(message).toContain('\n    policy_audit_entry');
  });

  it('explains the init-only cause, so the reader is not left guessing', () => {
    expect(formatSchemaDriftMessage(['event'])).toContain('EMPTY volume');
  });

  it('carries the remedy verbatim', () => {
    expect(formatSchemaDriftMessage(['event'])).toContain(SCHEMA_APPLY_REMEDY);
  });
});
