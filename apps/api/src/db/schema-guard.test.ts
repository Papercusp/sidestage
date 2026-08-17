import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_ACTION_AUDIT_STRUCTURES,
  REQUIRED_CHAT_STRUCTURES,
  REQUIRED_LINEUP_STRUCTURES,
  REQUIRED_OWNERSHIP_STRUCTURES,
  REQUIRED_ORDER_STRUCTURES,
  REQUIRED_TABLES,
  SCHEMA_APPLY_REMEDY,
  type SchemaQueryable,
  assertSchemaCurrent,
  findMissingActionAuditStructures,
  findMissingChatStructures,
  findMissingLineupStructures,
  findMissingOwnershipStructures,
  findMissingOrderStructures,
  findMissingTables,
  formatOwnershipDriftMessage,
  formatActionAuditDriftMessage,
  formatChatDriftMessage,
  formatLineupDriftMessage,
  formatOrderDriftMessage,
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
  structures: readonly string[] = [
    ...REQUIRED_OWNERSHIP_STRUCTURES,
    ...REQUIRED_ORDER_STRUCTURES,
    ...REQUIRED_CHAT_STRUCTURES,
    ...REQUIRED_LINEUP_STRUCTURES,
    ...REQUIRED_ACTION_AUDIT_STRUCTURES,
  ],
): SchemaQueryable {
  return {
    query: async (sql: string, params: unknown[]) => {
      const asked = (params[0] as string[] | undefined) ?? [];
      if (sql.includes('WITH present AS')) {
        return { rows: asked.filter((marker) => structures.includes(marker)).map((marker) => ({ marker })) };
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

describe('policy retention (P-006 / WI-39262)', () => {
  // Asserted on the DDL statement, not on a mention of the index name: the
  // surrounding schema.sql comment names the index too, so a looser match could
  // be satisfied by the comment that merely DESCRIBES the index while the index
  // itself was deleted.
  it('indexes policy_idempotency.created_at so the retention sweep is not a seq scan', () => {
    expect(SCHEMA_SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS policy_idempotency_created_idx\s+ON policy_idempotency \(created_at\)/,
    );
  });

  // Retention is deliberately scoped to the one table where expiry is correct.
  // These two assertions are the guard against a well-meaning follow-up quietly
  // adding retention to a table that must not have it.
  it('does not auto-expire the immutable audit trail', () => {
    expect(SCHEMA_SQL).not.toMatch(/DELETE\s+FROM\s+policy_audit_entry/i);
  });

  it('does not prune the outbox while nothing drains it (WI-39729)', () => {
    // Pruning by delivered_at would prune nothing (nothing sets it); pruning by
    // created_at would delete undelivered pending work. Retention here must
    // follow the drain.
    expect(SCHEMA_SQL).not.toMatch(/DELETE\s+FROM\s+policy_outbox_event/i);
  });
});

describe('policy-audit integrity constraints (P-006 / WI-39262)', () => {
  const POLICY_SERVICE_SQL = readFileSync(join(__dirname, '../policies/policy.service.ts'), 'utf8');

  // The whitelist is only as good as its agreement with the writer. If the
  // service starts writing a seventh action and nobody widens the CHECK, the
  // constraint rejects that write in production; this fails the build instead.
  it('whitelists exactly the actions policy.service.ts actually writes', () => {
    const written = new Set(
      [...POLICY_SERVICE_SQL.matchAll(/\baction:\s*'([a-z_]+)'/g)].map((match) => match[1]),
    );
    // Positive control: if this regex ever stops matching, the comparison below
    // would pass vacuously against two empty sets.
    expect(written.size).toBeGreaterThan(3);

    const checkClause = SCHEMA_SQL.match(
      /ADD CONSTRAINT policy_audit_action_known CHECK \(action IN \(([^)]*)\)\)/,
    );
    expect(checkClause, 'policy_audit_action_known not found in schema.sql').not.toBeNull();
    const allowed = new Set(
      [...(checkClause?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]),
    );

    expect([...allowed].sort()).toEqual([...written].sort());
  });

  it('foreign-keys the audit to its revision and refuses to erase evidence on delete', () => {
    expect(SCHEMA_SQL).toMatch(
      /ADD CONSTRAINT policy_audit_revision_fk FOREIGN KEY \(policy_revision_id\)\s+REFERENCES seller_policy_revision \(id\) ON UPDATE CASCADE ON DELETE RESTRICT/,
    );
    // CASCADE would delete the audit trail along with the revision it documents.
    expect(SCHEMA_SQL).not.toMatch(/policy_audit_revision_fk[\s\S]{0,160}ON DELETE CASCADE/);
  });

  it('rejects a blank seller on the audit trail', () => {
    expect(SCHEMA_SQL).toMatch(
      /ADD CONSTRAINT policy_audit_seller_nonempty CHECK \(btrim\(seller_id\) <> ''\)/,
    );
  });

  // The load-bearing property: policy_audit_entry is created with
  // CREATE TABLE IF NOT EXISTS, so an inline constraint would reach FRESH
  // installs only. These have to be guarded ALTERs so scripts/db-apply.sh
  // lands them on databases that already exist.
  it('adds each constraint idempotently so existing databases get them too', () => {
    for (const name of [
      'policy_audit_action_known',
      'policy_audit_seller_nonempty',
      'policy_audit_revision_fk',
    ]) {
      expect(SCHEMA_SQL).toContain(`WHERE conname = '${name}'`);
      expect(SCHEMA_SQL).toMatch(
        new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_constraint WHERE conname = '${name}'\\) THEN`),
      );
      // NOT VALID keeps a legacy row from failing db-apply, which runs under
      // ON_ERROR_STOP=1 ahead of the image build.
      expect(SCHEMA_SQL).toMatch(new RegExp(`ADD CONSTRAINT ${name}[\\s\\S]{0,400}?NOT VALID;`));
    }
  });

  it('does not put the constraints inline, where an existing table would never see them', () => {
    const createTable = SCHEMA_SQL.match(
      /CREATE TABLE IF NOT EXISTS policy_audit_entry \(([\s\S]*?)\n\);/,
    );
    expect(createTable, 'policy_audit_entry CREATE TABLE not found').not.toBeNull();
    expect(createTable?.[1]).not.toContain('policy_audit_action_known');
    expect(createTable?.[1]).not.toContain('policy_audit_revision_fk');
  });
});

describe('ownership schema guard', () => {
  it('makes catalog signatures unique per seller rather than globally', () => {
    expect(SCHEMA_SQL).toContain('DROP INDEX IF EXISTS storefront_product_group_signature_unique');
    expect(SCHEMA_SQL).toMatch(
      /PARTITION BY\s+COALESCE\(to_jsonb\(candidate\)->>'seller_id', 'demo-seller'\),\s+candidate\.group_id,\s+candidate\.region,\s+candidate\.option_signature/,
    );
    expect(SCHEMA_SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS storefront_product_seller_group_signature_unique\s+ON storefront_product \(seller_id, group_id, region, option_signature\)/,
    );
    expect(SCHEMA_SQL).not.toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS storefront_product_group_signature_unique\s+ON storefront_product \(group_id, region, option_signature\)/,
    );
  });

  it('tracks the columns, foreign keys, and immutable-owner triggers introduced by P-002', () => {
    expect(REQUIRED_OWNERSHIP_STRUCTURES).toEqual(
      expect.arrayContaining([
        'column:storefront_product.seller_id',
        'column:inventory_reservation.seller_id',
        'column:scout_session.buyer_id',
        'index:storefront_product_seller_group_signature_unique',
        'constraint:event_config_event_fk',
        'constraint:auction_state_event_owner_fk',
        'trigger:event_preserve_seller',
        'trigger:inventory_reservation_validate_source_owner',
        'trigger:scout_session_preserve_buyer',
      ]),
    );
  });

  it('keeps one deploy-applied Harbor Kettle source without assigning it to a real seller', () => {
    expect(SCHEMA_SQL).toContain("'sidestage-onboarding-harbor-kettle', 'US', 'KITCHEN', 'Harbor Kettle'");
    expect(SCHEMA_SQL).toContain("'sidestage-onboarding-harbor-kettle-v1', 'demo-seller'");
    expect(SCHEMA_SQL).toContain("'{\"sidestageRole\":\"seller-onboarding-source\"}'::jsonb");
    expect(SCHEMA_SQL).toMatch(
      /ON CONFLICT \(id\) DO UPDATE SET[\s\S]*WHERE storefront_product\.seller_id = EXCLUDED\.seller_id;/,
    );
    expect(SCHEMA_SQL).toContain("RAISE EXCEPTION 'Harbor Kettle onboarding source did not converge'");
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

describe('canonical payable-order schema guard', () => {
  it('tracks lifted columns, uniqueness indexes, state constraints, and immutable source triggers', () => {
    expect(REQUIRED_ORDER_STRUCTURES).toEqual(expect.arrayContaining([
      'column:checkout_order.buyer_id',
      'column:checkout_order.payment_state',
      'column:checkout_order.source_id',
      'column:checkout_order.source_kind',
      'column:checkout_order.stripe_payment_intent_id',
      'constraint:checkout_order_payment_state_check',
      'constraint:checkout_order_payload_identity',
      'index:checkout_order_source_unique',
      'index:checkout_order_stripe_payment_intent_unique',
      'trigger:checkout_order_preserve_source_id',
    ]));
  });

  it('reports a partially-applied payable-order migration', async () => {
    const present = [...REQUIRED_OWNERSHIP_STRUCTURES, ...REQUIRED_ORDER_STRUCTURES]
      .filter((marker) => marker !== 'index:checkout_order_source_unique');
    await expect(findMissingOrderStructures(poolWithTables(REQUIRED_TABLES, present))).resolves.toEqual([
      'index:checkout_order_source_unique',
    ]);
    await expect(assertSchemaCurrent(poolWithTables(REQUIRED_TABLES, present))).rejects.toThrow(
      /index:checkout_order_source_unique/,
    );
  });

  it('names the idempotent schema apply remedy', () => {
    expect(formatOrderDriftMessage(['column:checkout_order.source_kind'])).toContain(SCHEMA_APPLY_REMEDY);
  });
});

describe('durable-chat schema guard', () => {
  it('tracks event ownership, idempotency, paging, and presence indexes', () => {
    expect(REQUIRED_CHAT_STRUCTURES).toEqual(expect.arrayContaining([
      'constraint:chat_message_event_fk',
      'constraint:chat_presence_event_fk',
      'constraint:chat_transcript_moment_event_fk',
      'index:chat_message_copilot_queue_idx',
      'index:chat_message_idempotency_unique',
      'index:chat_message_visible_page_idx',
      'index:chat_presence_freshness_idx',
      'index:chat_transcript_event_timeline_idx',
    ]));
  });

  it('reports a partially-applied durable-chat schema', async () => {
    const present = [
      ...REQUIRED_OWNERSHIP_STRUCTURES,
      ...REQUIRED_ORDER_STRUCTURES,
      ...REQUIRED_CHAT_STRUCTURES,
    ].filter((marker) => marker !== 'index:chat_message_idempotency_unique');
    await expect(findMissingChatStructures(poolWithTables(REQUIRED_TABLES, present))).resolves.toEqual([
      'index:chat_message_idempotency_unique',
    ]);
    await expect(assertSchemaCurrent(poolWithTables(REQUIRED_TABLES, present))).rejects.toThrow(
      /index:chat_message_idempotency_unique/,
    );
  });

  it('names the idempotent schema apply remedy', () => {
    expect(formatChatDriftMessage(['index:chat_presence_freshness_idx'])).toContain(SCHEMA_APPLY_REMEDY);
  });
});

describe('durable-lineup schema guard', () => {
  it('tracks event/product identity, ordered reads, lifecycle, and one on-stage row', () => {
    expect(REQUIRED_LINEUP_STRUCTURES).toEqual(expect.arrayContaining([
      'constraint:event_lineup_item_event_fk',
      'constraint:event_lineup_item_event_product_unique',
      'constraint:event_lineup_item_product_fk',
      'constraint:event_lineup_item_stage_state_known',
      'index:event_lineup_item_event_position_idx',
      'index:event_lineup_item_one_on_stage',
    ]));
  });

  it('reports a partially-applied durable-lineup schema', async () => {
    const present = [
      ...REQUIRED_OWNERSHIP_STRUCTURES,
      ...REQUIRED_ORDER_STRUCTURES,
      ...REQUIRED_CHAT_STRUCTURES,
      ...REQUIRED_LINEUP_STRUCTURES,
    ].filter((marker) => marker !== 'index:event_lineup_item_one_on_stage');
    await expect(findMissingLineupStructures(poolWithTables(REQUIRED_TABLES, present))).resolves.toEqual([
      'index:event_lineup_item_one_on_stage',
    ]);
    await expect(assertSchemaCurrent(poolWithTables(REQUIRED_TABLES, present))).rejects.toThrow(
      /index:event_lineup_item_one_on_stage/,
    );
  });

  it('names the idempotent schema apply remedy', () => {
    expect(formatLineupDriftMessage(['constraint:event_lineup_item_product_fk']))
      .toContain(SCHEMA_APPLY_REMEDY);
  });
});

describe('durable action-audit schema guard', () => {
  it('tracks event ownership, ordered reads, request replay, and one rollback', () => {
    expect(REQUIRED_ACTION_AUDIT_STRUCTURES).toEqual(expect.arrayContaining([
      'constraint:action_audit_event_fk',
      'constraint:action_audit_kind_known',
      'constraint:action_audit_rollback_fk',
      'index:action_audit_event_created_idx',
      'index:action_audit_request_unique',
      'index:action_audit_rollback_unique',
    ]));
  });

  it('reports a partially-applied durable action-audit schema', async () => {
    const present = [
      ...REQUIRED_OWNERSHIP_STRUCTURES,
      ...REQUIRED_ORDER_STRUCTURES,
      ...REQUIRED_CHAT_STRUCTURES,
      ...REQUIRED_LINEUP_STRUCTURES,
      ...REQUIRED_ACTION_AUDIT_STRUCTURES,
    ].filter((marker) => marker !== 'index:action_audit_request_unique');
    await expect(findMissingActionAuditStructures(poolWithTables(REQUIRED_TABLES, present))).resolves.toEqual([
      'index:action_audit_request_unique',
    ]);
    await expect(assertSchemaCurrent(poolWithTables(REQUIRED_TABLES, present))).rejects.toThrow(
      /index:action_audit_request_unique/,
    );
  });

  it('names the idempotent schema apply remedy', () => {
    expect(formatActionAuditDriftMessage(['index:action_audit_rollback_unique']))
      .toContain(SCHEMA_APPLY_REMEDY);
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
