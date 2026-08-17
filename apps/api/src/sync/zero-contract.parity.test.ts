/**
 * Zero contract <-> live surface parity (plan sidestage-websocket-sync-cutover-2026-08-17, P-002).
 *
 * `@papercusp/sidestage-zero` is the ONE package both sides of the sync boundary
 * import: the browser's `<SyncProvider syncType="WEBSOCKETS">` and the API's
 * `/zero/query` + `/zero/mutate` handlers. This test is the guard that keeps that
 * package honest about the transport we actually run today, so the cutover cannot
 * silently drop a read or a write path.
 *
 * It asserts against `data-surface-census.ts` rather than booting Nest. That is
 * safe because `data-surface-census.test.ts` already fails CLOSED against the real
 * tree — it walks the source files and rejects any registration, mutator call site,
 * or `db/schema.sql` table that the census does not classify. So census == reality
 * is upstream-guarded, and this file guards contract == census.
 *
 * Lives under apps/api/src so the root vitest `sidestage-node` project runs it in
 * the release gate; a test under libs/zero/** would not run there.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CONTRACT_AHEAD_OF_REGISTRY,
  REPLICATED_TABLES,
  REST_COMMAND_MUTATORS,
  SYNCED_QUERY_PRINCIPAL_SCOPE,
  UNPUBLISHABLE_COLUMNS,
  UNSYNCED_QUERY_REASONS,
  createMutators,
  queries,
  schema,
} from '@papercusp/sidestage-zero';

import {
  POSTGRES_SURFACES,
  SYNC_MUTATOR_SURFACES,
  SYNC_QUERY_SURFACES,
} from './data-surface-census';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCHEMA_SQL = readFileSync(resolve(REPO_ROOT, 'db/schema.sql'), 'utf8');
const WEB_ROOT = resolve(REPO_ROOT, 'apps/web/src');

function webSourceFiles(): string[] {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else if (/\.tsx?$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name)) output.push(absolute);
    }
  };
  visit(WEB_ROOT);
  return output;
}

/**
 * Every `useSyncQuery({ ... })` invocation in one web source file, with the
 * query-name string literals it can evaluate to.
 *
 * Brace-matched rather than regex-scanned on purpose: a bounded `[\s\S]{0,N}?`
 * window silently walks PAST a call site whose `queryName` is a ternary and
 * attributes the NEXT call site's literal to it, which is a false clean and a
 * false accusation in one. Reading only within the invocation's own argument
 * object cannot do that.
 */
function useSyncQueryCallSites(file: string): { at: string; names: string[] }[] {
  const source = readFileSync(file, 'utf8');
  const at = (index: number) => `${relative(REPO_ROOT, file).replaceAll('\\', '/')}:${source.slice(0, index).split('\n').length}`;
  const sites: { at: string; names: string[] }[] = [];
  const opener = /useSyncQuery(?:<[^(){}]*>)?\(\s*\{/g;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close === -1) continue;
    const args = source.slice(open, close);
    const declaration = /queryName\s*:/.exec(args);
    const names: string[] = [];
    if (declaration) {
      // The queryName expression: everything up to the next top-level comma.
      let depths = 0;
      let cut = args.length;
      for (let i = declaration.index + declaration[0].length; i < args.length; i += 1) {
        const character = args[i];
        if ('{[('.includes(character)) depths += 1;
        else if ('}])'.includes(character)) depths -= 1;
        else if (character === ',' && depths === 0) { cut = i; break; }
      }
      const expression = args.slice(declaration.index + declaration[0].length, cut);
      for (const literal of expression.matchAll(/'([^']+)'/g)) names.push(literal[1]);
    }
    sites.push({ at: at(match.index), names });
    opener.lastIndex = close;
  }
  return sites;
}

/**
 * Web call sites that reach an UNSYNCED_QUERY_REASONS query through
 * `useSyncQuery` and are NOT yet repaired — a ratchet, not a permission. Each
 * one throws `Query '<name>' is not a function` on the WEBSOCKETS transport,
 * because the Zero client resolves the name against a registry that
 * deliberately has no leaf for it.
 *
 * NOW EMPTY, and it must stay that way. All eight known instances were repaired
 * by switching them to `useRestSyncQuery` (WI-39763 for `event.chat.stats`,
 * WI-39772 for the other seven) — that hook always resolves through the REST
 * batch fetcher, so it behaves identically on every transport. The scanner
 * below only matches `useSyncQuery`, so a repaired site simply stops being
 * found.
 *
 * A non-empty list is the fix-ordering hazard written down: these are latent on
 * a rung that has already been demoted to polling, so repairing a WebSocket
 * auth failure alone makes every listed site user-visible at once. Adding an
 * entry is not a fix; it needs the same scrutiny as a new Zero registry
 * exception. Reach for `useRestSyncQuery` instead.
 */
const KNOWN_UNSYNCED_CALL_SITES: readonly string[] = ([] as string[]).sort();

/**
 * Postgres tables the census classifies as `replicate` that this contract does
 * NOT carry yet, each with the reason. Deliberate scope, not an oversight — the
 * test below forces every census table into either this list or the replicated
 * set, so a NEW table can never be quietly skipped by the cutover.
 */
const DEFERRED_REPLICATION: Readonly<Record<string, string>> = {
  scout_session: 'Buyer Scout session state; P-018 lane, outside the auction/chat/catalog cutover.',
  scout_memory: 'Buyer Scout memory (also carries an unpublishable tsvector); P-018 lane.',
  policy_audit_entry: 'Backs event.pricingHistory; joins the replicated set with that query (P-002 follow-up).',
  policy_outbox_event: 'Server-internal outbox plumbing — never client-visible.',
  policy_idempotency: 'Server-internal idempotency keys — never client-visible.',
  system_test_run: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_suite: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_case: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_artifact: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_environment: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_fixture_lease: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_fixture_resource: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_transition: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_cancellation: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_retention: 'Operational test-harness table; operator-only surface (P-020).',
  system_test_cleanup: 'Operational test-harness table; operator-only surface (P-020).',
  judge_run: 'Operational judge-harness table; operator-only Test-tab surface (P-001c).',
  judge_case_result: 'Operational judge-harness table; operator-only Test-tab surface (P-001c).',
  rehearsal_run: 'Operational rehearsal-harness table; seller/operator preflight surface (P-001c).',
};

/** Every leaf query in the registry, as its dot-path. */
const leafPaths = (node: unknown, prefix: readonly string[] = []): string[] =>
  Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => {
    const path = [...prefix, key];
    if (typeof value === 'function') return [path.join('.')];
    if (value && typeof value === 'object') return leafPaths(value, path);
    return [];
  });

/**
 * Zero's table builder keeps `serverName` (the Postgres table name set by
 * `.from()`) on the built schema, but the generated table type is a large union
 * that does not surface it structurally — introspecting it needs an explicit shape.
 */
const zeroTables = Object.values(schema.tables) as unknown as readonly {
  name: string;
  serverName?: string;
  columns: Record<string, unknown>;
}[];

/**
 * A registry leaf: a callable custom query carrying the wire name Zero derived
 * from its nesting position.
 */
type LeafQuery = ((...args: never[]) => unknown) & { queryName?: string };

/** Resolve a dot-path against the query registry without assuming it exists. */
const resolveLeaf = (path: string): LeafQuery | undefined => {
  let node: unknown = queries;
  for (const key of path.split('.')) {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node as LeafQuery | undefined;
};

/** Every mutator in `createMutators()`, as its `namespace.name` path. */
const mutatorPaths = (): string[] =>
  Object.entries(createMutators() as Record<string, Record<string, unknown>>).flatMap(
    ([namespace, group]) => Object.keys(group).map((name) => `${namespace}.${name}`),
  );

describe('Zero contract parity with the live sync surfaces', () => {
  it('replicates only tables that db/schema.sql actually creates', () => {
    const missing = REPLICATED_TABLES.filter(
      (table) => !new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`).test(SCHEMA_SQL),
    );
    expect(missing, 'Zero tables with no CREATE TABLE in db/schema.sql').toEqual([]);
  });

  it('accounts for every census Postgres table as replicated or explicitly deferred', () => {
    const replicated = new Set<string>(REPLICATED_TABLES);
    const unaccounted = Object.keys(POSTGRES_SURFACES).filter(
      (table) => !replicated.has(table) && !(table in DEFERRED_REPLICATION),
    );
    expect(
      unaccounted,
      'census tables neither in REPLICATED_TABLES nor in DEFERRED_REPLICATION — classify them before shipping the cutover',
    ).toEqual([]);
  });

  it('does not defer a table it also replicates', () => {
    const contradictory = REPLICATED_TABLES.filter((table) => table in DEFERRED_REPLICATION);
    expect(contradictory).toEqual([]);
  });

  it('excludes only columns that really exist and really cannot be published', () => {
    for (const [table, columns] of Object.entries(UNPUBLISHABLE_COLUMNS)) {
      const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`).exec(
        SCHEMA_SQL,
      );
      expect(create, `no CREATE TABLE found for ${table}`).not.toBeNull();
      for (const column of columns) {
        expect(create?.[1], `${table}.${column} is not a column in db/schema.sql`).toContain(column);
      }
    }
  });

  it('never declares an unpublishable column as a Zero column', () => {
    const offenders: string[] = [];
    for (const zeroTable of zeroTables) {
      const serverName = zeroTable.serverName ?? zeroTable.name;
      const excluded = UNPUBLISHABLE_COLUMNS[serverName];
      if (!excluded) continue;
      for (const column of excluded) {
        if (column in zeroTable.columns) offenders.push(`${serverName}.${column}`);
      }
    }
    expect(
      offenders,
      'a column excluded from the publication must not be declared as a Zero column — the client would wait forever for a value replication never sends',
    ).toEqual([]);
  });

  it('classifies every live sync query as synced or explicitly unsynced', () => {
    const unclassified = SYNC_QUERY_SURFACES.map((surface) => surface.name).filter(
      (name) => !(name in SYNCED_QUERY_PRINCIPAL_SCOPE) && !(name in UNSYNCED_QUERY_REASONS),
    );
    expect(
      unclassified,
      'registered sync queries with no Zero disposition — the cutover would silently drop these reads',
    ).toEqual([]);
  });

  it('declares every synced query that no registration serves yet', () => {
    const live = new Set(SYNC_QUERY_SURFACES.map((surface) => surface.name));
    const undeclared = Object.keys(SYNCED_QUERY_PRINCIPAL_SCOPE).filter(
      (name) => !live.has(name) && !(name in CONTRACT_AHEAD_OF_REGISTRY),
    );
    expect(
      undeclared,
      'synced queries with neither a live registration nor a CONTRACT_AHEAD_OF_REGISTRY entry — a client call site using one would 404 at /zero/query',
    ).toEqual([]);
  });

  it('never lists a query as both synced and unsynced', () => {
    const both = Object.keys(SYNCED_QUERY_PRINCIPAL_SCOPE).filter(
      (name) => name in UNSYNCED_QUERY_REASONS,
    );
    expect(both).toEqual([]);
  });

  it('resolves every live synced query at a registry path with that exact wire name', () => {
    // THE property that makes flipping syncType a zero-call-site-edit change:
    // Zero derives a query's wire name from its nesting position, and the SSE
    // transport addresses the same read by that exact string. Anchoring on the
    // census name (which `data-surface-census.test.ts` pins to the real
    // registrations) is what keeps this honest — comparing a leaf's queryName to
    // its own path would be a tautology, since Zero derives one from the other.
    const failures: string[] = [];
    for (const { name } of SYNC_QUERY_SURFACES) {
      if (!(name in SYNCED_QUERY_PRINCIPAL_SCOPE)) continue; // unsynced by design
      const leaf = resolveLeaf(name);
      if (typeof leaf !== 'function') {
        failures.push(`${name}: no query defined at that registry path`);
      } else if (leaf.queryName !== name) {
        failures.push(`${name}: registry emits wire name "${leaf.queryName}"`);
      }
    }
    expect(
      failures,
      'a synced query whose Zero wire name would not match the SSE query name the call sites already use',
    ).toEqual([]);
  });

  it('keeps the registry and the principal-scope map in exact agreement', () => {
    expect(leafPaths(queries).sort()).toEqual(Object.keys(SYNCED_QUERY_PRINCIPAL_SCOPE).sort());
  });

  it('classifies every live mutator as a Zero mutator or an explicit REST command', () => {
    const zeroMutators = new Set(mutatorPaths());
    const unclassified = SYNC_MUTATOR_SURFACES.map((surface) => surface.name).filter(
      (name) => !zeroMutators.has(name) && !(name in REST_COMMAND_MUTATORS),
    );
    expect(
      unclassified,
      'web mutator call sites with no Zero disposition — the cutover would silently drop these writes',
    ).toEqual([]);
  });

  it('never lets a web call site name a query the Zero registry deliberately omits', () => {
    // The blind spot that let WI-39763 reach production. Every assertion above
    // compares NAME SETS — contract vs census vs registry — and each one passed
    // while `EventChat.tsx` asked `useSyncQuery` for 'event.chat.stats' by name.
    // An UNSYNCED_QUERY_REASONS entry has no Zero registry leaf by design, so on
    // the WEBSOCKETS transport `resolveQuery` throws
    // `Query '<name>' is not a function`; the polling/SSE adapters resolve the
    // same name over REST and never consult the registry, which is exactly why
    // this class of break stays invisible until a client is really on WebSockets.
    // The ratchet compares `file -> queryName` and deliberately NOT the line
    // number: pinning lines made this test red on any unrelated edit ABOVE a
    // call site (a peer moving BuildHistoryTab.tsx's `build.history` from 922
    // to 926 reds the gate while changing nothing this test is about). It stays
    // exact all the same — offenders keep their multiplicity, so a SECOND call
    // site naming the same query in the same file still grows the list. Line
    // numbers survive where they are actually useful: the failure message.
    const offenders: string[] = [];
    const located: string[] = [];
    const unreadable: string[] = [];
    for (const file of webSourceFiles()) {
      for (const site of useSyncQueryCallSites(file)) {
        // A queryName built at runtime (`scope === 'seller' ? a : b`) is checked
        // on EVERY literal it can evaluate to — one safe branch does not excuse
        // the other. A call site yielding no literal at all is not "clean", it
        // is unreadable, and it fails below rather than passing silently.
        if (site.names.length === 0) unreadable.push(site.at);
        for (const name of site.names) {
          if (!(name in UNSYNCED_QUERY_REASONS)) continue;
          offenders.push(`${relative(REPO_ROOT, file).replaceAll('\\', '/')} -> ${name}`);
          located.push(`${site.at} -> ${name}`);
        }
      }
    }

    // Fail closed on the detector itself: a call site whose queryName this cannot
    // read is a call site this test does not guard, and an under-matching
    // detector reports "clean" for the exact bug it exists to catch.
    expect(
      unreadable,
      'useSyncQuery call sites whose queryName could not be read statically — this detector does not guard them, so it cannot report clean; give the call site a literal queryName or teach the extractor to read it',
    ).toEqual([]);

    expect(
      offenders.sort(),
      `web call sites naming an UNSYNCED_QUERY_REASONS query — each throws "Query '<name>' is not a function" the moment that client is on the WEBSOCKETS transport. Fix the call site (derive client-side, or move it to an explicit REST fetch); do not add the name to the Zero registry, and do not grow the list in KNOWN_UNSYNCED_CALL_SITES.\nCall sites found, with line numbers:\n${located.sort().join('\n')}`,
    ).toEqual(KNOWN_UNSYNCED_CALL_SITES);
  });

  it('gives every deferred table and unsynced query a non-empty reason', () => {
    for (const [table, reason] of Object.entries(DEFERRED_REPLICATION)) {
      expect(reason.length, `${table} needs a reason`).toBeGreaterThan(20);
    }
    for (const [name, reason] of Object.entries(UNSYNCED_QUERY_REASONS)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
    for (const [name, reason] of Object.entries(CONTRACT_AHEAD_OF_REGISTRY)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
    for (const [name, reason] of Object.entries(REST_COMMAND_MUTATORS)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
  });
});
