/**
 * Zero contract <-> Postgres PUBLICATION parity
 * (plan sidestage-websocket-sync-cutover-2026-08-17, P-003).
 *
 * `zero-contract.parity.test.ts` guards contract == census. This file guards the
 * other half of the cutover: contract == the logical-replication publication that
 * actually feeds zero-cache. Without it, a table can be added to the Zero schema,
 * pass every existing test, and then simply never replicate at runtime — the
 * client subscribes happily and receives nothing, which reads as an empty table
 * rather than an error.
 *
 * The table list is derived DYNAMICALLY from `REPLICATED_TABLES`. It is
 * deliberately NOT hardcoded to a count: the whole point is that widening the
 * contract turns into a failure here that names the missing table, instead of a
 * silent runtime gap.
 *
 * ── A hazard this test cannot see ───────────────────────────────────────────
 * db/zero-publication.sql wraps CREATE PUBLICATION in
 * `IF NOT EXISTS (SELECT 1 FROM pg_publication ...)`. Against a database where
 * the publication ALREADY exists, re-running the file is a silent no-op — it
 * will NOT add a newly-contracted table. Widening replication on a live database
 * therefore requires an explicit `ALTER PUBLICATION zero_publication ADD TABLE`;
 * see infra/zero/README.md. This test guards the FILE, which is what a fresh
 * database gets; it cannot observe an already-provisioned server.
 *
 * Lives under apps/api/src so the root vitest `sidestage-node` project runs it in
 * the release gate; the root config's projects cover only deploy/**,
 * apps/api/src/** and apps/web/src/**, so a copy under libs/zero/** or infra/**
 * would silently never run.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPLICATED_TABLES, UNPUBLISHABLE_COLUMNS, schema } from '@papercusp/sidestage-zero';

const REPO_ROOT = resolve(__dirname, '../../../..');
const PUBLICATION_SQL = readFileSync(resolve(REPO_ROOT, 'db/zero-publication.sql'), 'utf8');
const SCHEMA_SQL = readFileSync(resolve(REPO_ROOT, 'db/schema.sql'), 'utf8');

interface PublishedTable {
  /** Bare table name, `public.` stripped. */
  readonly name: string;
  /**
   * The explicit column list, when the publication narrows the table. `null`
   * means "whole table" — Postgres publishes every column except ones it
   * auto-excludes (stored generated columns before PG17).
   */
  readonly columns: readonly string[] | null;
}

/**
 * Pull the `FOR TABLE ...` payload out of the CREATE PUBLICATION statement and
 * split it into entries. Splitting cannot be a plain `.split(',')`: the
 * product_catalog entry carries a parenthesised 27-column list whose commas are
 * NOT entry separators, so we track paren depth and only break at depth 0.
 */
function parsePublishedTables(sql: string): PublishedTable[] {
  const start = sql.indexOf('CREATE PUBLICATION zero_publication FOR TABLE');
  if (start === -1) {
    throw new Error('db/zero-publication.sql no longer contains a CREATE PUBLICATION zero_publication statement');
  }

  // Strip `--` comments FIRST, before any structural scan. Both scans below are
  // punctuation-driven — `;` ends the statement, `,` separates entries — and the
  // comments in this file carry prose, which has both. Stripping afterwards (as
  // this did originally, per-entry) let a comment silently truncate the parse:
  // a `;` inside one cut the statement short so most tables read as UNPUBLISHED,
  // and a `,` cut an entry in half, surfacing as
  // `could not parse publication entry: "and the two omitted columns"`. Both
  // present as the SQL being wrong when the parser is.
  const body = sql
    .slice(start + 'CREATE PUBLICATION zero_publication FOR TABLE'.length)
    .replace(/--[^\n]*/g, '');
  const end = body.indexOf(';');
  if (end === -1) throw new Error('unterminated CREATE PUBLICATION statement');

  const statement = body.slice(0, end);

  const entries: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of statement) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      entries.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  entries.push(current);

  return entries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const match = /^(?:public\.)?([a-z_][a-z0-9_]*)\s*(?:\(([\s\S]*)\))?$/i.exec(entry);
      if (!match) throw new Error(`could not parse publication entry: ${JSON.stringify(entry)}`);
      const [, name, columnList] = match;
      return {
        name,
        columns: columnList
          ? columnList
              .split(',')
              .map((c) => c.trim())
              .filter((c) => c.length > 0)
          : null,
      };
    });
}

/**
 * Is `column` declared GENERATED in `table`'s CREATE TABLE block? A stored
 * generated column is auto-excluded from replication by Postgres 16, so it needs
 * no explicit column list; a plain unpublishable column (a tsvector, say) is NOT
 * auto-excluded and must be narrowed away by hand.
 */
function isGeneratedColumn(table: string, column: string): boolean {
  const block = new RegExp(`CREATE TABLE[^;]*?\\b${table}\\b([\\s\\S]*?);`, 'i').exec(SCHEMA_SQL);
  if (!block) return false;
  const line = block[1]
    .split('\n')
    .find((l) => new RegExp(`^\\s*"?${column}"?\\s`, 'i').test(l));
  return line ? /GENERATED\s+ALWAYS/i.test(line) : false;
}

const published = parsePublishedTables(PUBLICATION_SQL);
const publishedNames = published.map((t) => t.name).sort();
// Widened to string[] deliberately: REPLICATED_TABLES is a readonly tuple of
// string literals, so `.includes(someString)` on it is a type error. Comparing
// the two sets is exactly this test's job, and the names come from parsed SQL.
const contractNames: string[] = [...REPLICATED_TABLES].sort();

describe('zero_publication <-> Zero contract parity', () => {
  it('publishes exactly the tables the contract replicates', () => {
    // Set equality, reported as two directed diffs so the failure names the
    // actual offender instead of dumping two 19-element arrays side by side.
    const missing = contractNames.filter((t) => !publishedNames.includes(t));
    const extra = publishedNames.filter((t) => !contractNames.includes(t));

    expect(
      missing,
      `REPLICATED_TABLES lists ${missing.join(', ')}, but db/zero-publication.sql does not publish them. ` +
        'A contracted table that is not published never replicates: the client subscribes and silently ' +
        'receives nothing. Add it to the CREATE PUBLICATION list — and on any already-provisioned database ' +
        'also run ALTER PUBLICATION zero_publication ADD TABLE public.<name>, because the file is guarded ' +
        'by IF NOT EXISTS and will no-op there.',
    ).toEqual([]);

    expect(
      extra,
      `db/zero-publication.sql publishes ${extra.join(', ')}, which the Zero contract does not replicate. ` +
        'Publishing a table the contract does not carry ships its rows to every client for no reason, and ' +
        'for a table with no PRIMARY KEY it additionally makes every UPDATE/DELETE on it fail at runtime. ' +
        'Operational tables (judge_run, rehearsal_run, system_test_*) belong in the census as `operational`, ' +
        'never here.',
    ).toEqual([]);

    expect(publishedNames).toEqual(contractNames);
  });

  it('does not publish any column the contract marks unpublishable', () => {
    for (const [table, columns] of Object.entries(UNPUBLISHABLE_COLUMNS)) {
      const entry = published.find((t) => t.name === table);
      if (!entry?.columns) continue;
      for (const column of columns) {
        expect(
          entry.columns,
          `db/zero-publication.sql publishes ${table}.${column}, which the contract marks unpublishable.`,
        ).not.toContain(column);
      }
    }
  });

  it('narrows every unpublishable column that Postgres will not auto-exclude', () => {
    // A STORED generated column is dropped from the stream by PG16 on its own.
    // Anything else — a tsvector, say — is published unless an explicit column
    // list leaves it out, and zero-cache then fails on a type it cannot map.
    for (const [table, columns] of Object.entries(UNPUBLISHABLE_COLUMNS)) {
      for (const column of columns) {
        if (isGeneratedColumn(table, column)) continue;
        const entry = published.find((t) => t.name === table);
        expect(
          entry?.columns,
          `${table}.${column} is unpublishable but is NOT a generated column, so Postgres will replicate it ` +
            `unless ${table} is published with an explicit column list that omits it.`,
        ).not.toBeNull();
      }
    }
  });

  /**
   * The REVERSE direction of the two tests above, and the one that actually
   * bites. They ask "is an unpublishable column absent"; this asks "is every
   * column the contract DOES declare actually published".
   *
   * A narrowed table makes that a live hazard. Adding a column to a table in
   * libs/zero/src/schema.ts is enough on its own for a whole-table publication —
   * Postgres carries it — but for a table published by column list the new
   * column simply never replicates. Zero then declares a field the stream never
   * carries, so the WS rung serves it as undefined while REST serves the real
   * value: the exact WI-39839 / WI-39855 signature, and silent, because nothing
   * errors.
   */
  it('publishes every contract column of a table narrowed by a column list', () => {
    const tables = Object.values(schema.tables) as {
      name: string;
      serverName?: string;
      columns: Record<string, { serverName?: string }>;
    }[];
    let tablesChecked = 0;

    for (const entry of published) {
      if (!entry.columns) continue; // whole-table publication: nothing to narrow
      const table = tables.find((t) => (t.serverName ?? t.name) === entry.name);
      // A published table the contract does not declare is the table-parity
      // test's failure to report, not this one's.
      if (!table) continue;

      const unpublishable = new Set(UNPUBLISHABLE_COLUMNS[entry.name] ?? []);
      const contractColumns = Object.entries(table.columns)
        .map(([key, def]) => def.serverName ?? key)
        .filter((column) => !unpublishable.has(column));

      const missing = contractColumns.filter((column) => !entry.columns!.includes(column));
      expect(
        missing,
        `db/zero-publication.sql publishes ${entry.name} with an explicit column list that omits ` +
          `${missing.join(', ')}, but the Zero contract declares ${missing.length === 1 ? 'it' : 'them'}. ` +
          'A contracted column outside the publication never replicates: the WS rung serves it as ' +
          'undefined while REST serves the real value, with no error on either side. Either add the ' +
          `column to the list, or — if it must never reach clients — add it to UNPUBLISHABLE_COLUMNS.${entry.name} ` +
          'and drop it from the contract.',
      ).toEqual([]);

      tablesChecked += 1;
    }

    // Positive control. Every assertion above is an ABSENCE, so a lookup that
    // silently matched no tables would pass this test while measuring nothing —
    // and it would do so at exactly the moment the contract's shape changed.
    expect(
      tablesChecked,
      'no narrowed table was matched against the contract, so the assertions above ran on an empty ' +
        'set. Either the publication no longer narrows any table, or the contract-table lookup broke ' +
        '(a Zero upgrade renaming `serverName` would do it). Fix the instrument before trusting a pass.',
    ).toBeGreaterThan(0);
  });

  it('keeps the publication name in sync with what the compose files pass to zero-cache', () => {
    // ZERO_APP_PUBLICATIONS is how zero-cache is told which publication to read.
    // A rename on one side alone leaves zero-cache pointed at a publication that
    // does not exist, which it reports as an empty upstream rather than an error.
    const prodCompose = readFileSync(resolve(REPO_ROOT, 'docker-compose.prod.yml'), 'utf8');
    expect(prodCompose).toContain('ZERO_APP_PUBLICATIONS: zero_publication');
    expect(PUBLICATION_SQL).toContain('CREATE PUBLICATION zero_publication');
  });
});
