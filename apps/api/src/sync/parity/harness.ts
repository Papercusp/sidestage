/**
 * P-005 prep: per-surface Zero parity verification harness (buyer / seller /
 * operational) — plan sidestage-websocket-sync-cutover-2026-08-17, WI-39617.
 *
 * ## What this harness checks TODAY (Phase 1 — structural/classification parity)
 *
 * `zero-contract.parity.test.ts` (P-002) already guards that the contract and
 * the census AGREE on which surfaces exist and how each is disposed (synced /
 * unsynced / deferred). It does not check WHICH surface (buyer vs seller vs
 * operational) owns each entry, and it does not cross-check the contract's
 * own `SYNCED_QUERY_PRINCIPAL_SCOPE` against the census's independently
 * authored `DataAudience` tags — two classification systems that could drift
 * from each other without either one alone catching it. `buyer.parity.test.ts`
 * / `seller.parity.test.ts` / `operational.parity.test.ts` close that gap,
 * organized per surface so `npm run test:file` can run just the surface a
 * lane actually touched. `resolveQueryLeaf` and `mutatorLeaves` below are the
 * shared registry-introspection they use; `diffRows` is the row-comparison
 * Phase 2 needs and has no runtime dependency, so it is real and tested now.
 *
 * ## What this harness does NOT check yet, and why (Phase 2 — data-level parity)
 *
 * The literal P-005 scope ("reconnect and failover drills… load smoke,
 * principal-isolation checks on WS queries") is a RUNTIME comparison: the
 * same request answered by the SSE-era resolver (`SyncQueryRegistry`, real
 * Postgres) and by the Zero query (real `/zero/query` handler, same
 * Postgres) must return the same rows, and a query scoped to one principal
 * must never leak another's. This lane is explicitly NOT that (WI-39617:
 * "Do NOT flip the app transport"). Two things are pinned here so wiring it
 * in is a button-press, not a re-investigation:
 *
 *   - **The handler now EXISTS** — `apps/api/src/sync/zero.controller.ts`
 *     (P-011 / WI-39663), registered in `SyncModule`, serving `POST
 *     /zero/query` + `POST /zero/mutate`. It was built by P-011, not P-004;
 *     P-004 only flipped the app transport. Note the two endpoints are NOT
 *     symmetric: `/zero/query` is a PURE TRANSFORM (it resolves a named query
 *     against the shared `queries` registry and returns the ZQL AST for
 *     zero-cache to execute against its own replica), so it touches no
 *     database; `/zero/mutate` is the one that writes.
 *   - **Execution mechanism for THIS harness's Phase 2 seam** — confirmed
 *     present at `@rocicorp/zero@^1.8.0` (this repo's pinned version). The
 *     adapters map ships `./server/adapters/{drizzle,kysely,prisma,pg,postgresjs}`.
 *     Use `zeroNodePg(schema, pool)` from `@rocicorp/zero/server/adapters/pg`
 *     — the same adapter `zero.controller.ts` uses, and the reason is
 *     load-bearing: `zeroNodePg` accepts the `node-postgres` `Pool` the app
 *     ALREADY provides via `PG_POOL`, whereas `zeroPostgresJS` would open a
 *     SECOND, unsupervised `postgres.js` pool against the same database,
 *     bypassing the app's probe/schema-guard and its `max:10` limit (plan
 *     decision on sidestage-websocket-sync-cutover-2026-08-17). Either wraps
 *     the connection into a `ZQLDatabase` whose `.run(query)` executes a ZQL
 *     `Query` — exactly what `queries.event.lineup.items({eventId})` builds —
 *     directly against Postgres, with NO zero-cache replica required. Built
 *     on the adapter production uses, a comparison exercises shipping code
 *     rather than a reimplementation that could itself drift.
 *   - **SSE-side execution**: bootstrap the real Nest `AppModule` (the way
 *     `sync.controller.spec.ts` already bootstraps `SyncModule`) and call the
 *     live `SyncQueryRegistry.resolve(name, args, context)` — the actual
 *     production resolver, not a mock.
 *
 * ## Phase 2 is now IMPLEMENTED (WI-39867)
 *
 * `createZeroQueryRunner` / `createSseQueryRunner` below replace the throwing
 * seams this header used to describe. The per-query DIFFERENTIAL that consumes
 * them — row key sets, cardinality, and value equality against seeded live data
 * — lives in `differential.ts` + `differential.integration.test.ts`, and is what
 * plan Decision D-023 gates the WS rung's return on.
 *
 * Note what `diffRows` below can and cannot do: it is an ORDER-SENSITIVE,
 * whole-row equality check, which answers "are these two result sets identical".
 * It cannot say WHY they differ, and in particular it cannot distinguish "the
 * Zero rung dropped a server-computed field" (the WI-39839/WI-39855 class) from
 * an unrelated value change. `diffQueryShape` in `differential.ts` is the one
 * that separates those axes; prefer it for parity verdicts.
 */
import type { Pool } from 'pg';
import { zeroNodePg } from '@rocicorp/zero/server/adapters/pg';
import { addContextToQuery } from '@rocicorp/zero/bindings';
import { queries, schema } from '@papercusp/sidestage-zero';

/** A registry leaf: a callable query/mutator function, possibly carrying Zero's derived wire name. */
type RegistryLeaf = ((...args: never[]) => unknown) & { queryName?: string };

/** Resolve a dot-path (e.g. `'event.lineup.items'`) against the named query registry. */
export function resolveQueryLeaf(path: string): RegistryLeaf | undefined {
  let node: unknown = queries;
  for (const key of path.split('.')) {
    if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'function' ? (node as RegistryLeaf) : undefined;
}

/** Every leaf in `createMutators()`, as `{ path: 'namespace.name', fn }` pairs. */
export function mutatorLeaves(mutators: Record<string, Record<string, unknown>>): { path: string; fn: (...args: never[]) => unknown }[] {
  return Object.entries(mutators).flatMap(([namespace, group]) =>
    Object.entries(group)
      .filter((entry): entry is [string, (...args: never[]) => unknown] => typeof entry[1] === 'function')
      .map(([name, fn]) => ({ path: `${namespace}.${name}`, fn })),
  );
}

/**
 * Source-level markers that count as a principal-ownership guard on a Zero
 * mutator (checked against `fn.toString()` — the actual shipped function
 * body, not the file's text, so this survives unrelated formatting/refactors
 * as long as the guard call keeps a recognizable name). Extend this list
 * alongside any new guard helper `mutators.ts` introduces.
 */
const MUTATOR_GUARD_MARKERS = ['assertOwnPrincipal', 'ctx.principal', 'ctx?.principal'];

/** Does this mutator's actual source contain a recognized principal-ownership guard? */
export function mutatorGuardsOwnPrincipal(fn: (...args: never[]) => unknown): boolean {
  const source = fn.toString();
  return MUTATOR_GUARD_MARKERS.some((marker) => source.includes(marker));
}

/**
 * Deep-canonicalize (recursively sort object keys) so two rows built with
 * different key insertion order still compare equal.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

/**
 * Row-for-row parity between an SSE-era result and a Zero result:
 * order-sensitive (row ORDER is part of what a buyer/seller sees, so a
 * reordering on transport flip is a real regression, not noise) and
 * tolerant of key order within a row. Returns a readable mismatch list,
 * empty when the two result sets match exactly.
 */
export function diffRows(sseRows: readonly unknown[], zeroRows: readonly unknown[]): string[] {
  const mismatches: string[] = [];
  if (sseRows.length !== zeroRows.length) {
    mismatches.push(`row count: SSE=${sseRows.length} Zero=${zeroRows.length}`);
  }
  const shared = Math.min(sseRows.length, zeroRows.length);
  for (let i = 0; i < shared; i += 1) {
    const a = JSON.stringify(canonicalize(sseRows[i]));
    const b = JSON.stringify(canonicalize(zeroRows[i]));
    if (a !== b) mismatches.push(`row[${i}]: SSE=${a} Zero=${b}`);
  }
  return mismatches;
}

/**
 * PHASE 2, IMPLEMENTED (WI-39867). Executes a named Zero query as ZQL directly
 * against Postgres and returns what the WS rung would serve.
 *
 * This deliberately does NOT call the `/zero/query` HTTP handler. That endpoint
 * exists (P-011) but is a PURE AST TRANSFORM — it hands zero-cache a ZQL AST to
 * run against its own replica and returns no rows at all, so it cannot answer a
 * data-level parity question. What we need is ZQL *executed*, which is what the
 * adapter below does.
 *
 * `zeroNodePg` — NOT `zeroPostgresJS` — because it accepts the `node-postgres`
 * `Pool` the app already owns (`PG_POOL`), whereas postgresjs would open a
 * second unsupervised pool against the same database, bypassing the app's probe,
 * schema guard and `max:10` limit. Plan Decisions D-010/D-014; `zero.controller.ts`
 * uses the same adapter, so the comparison exercises SHIPPING code rather than a
 * reimplementation that could itself drift.
 *
 * ⚠ THE `addContextToQuery` STEP IS NOT OPTIONAL. Calling a registry leaf
 * returns a `QueryRequest` DESCRIPTOR (`{query, args, '~':'QueryRequest'}`), not
 * a `Query`; passing that straight to `.run()` fails Zero's brand check — and it
 * fails MISLEADINGLY, asserting "there are two copies of Zero in your runtime",
 * which sends you hunting a split module graph that is not there. Measured
 * 2026-08-17 (WI-39663, plan Decision D-016): the module graph was exonerated by
 * A/B; the handler was simply passing the wrong object. `addContextToQuery` is
 * what `zero-client`/`zero-react` call on every client-side read.
 *
 * Returns the RAW result, not a normalized array: a `.one()` leaf resolves to a
 * single row or `undefined`, and flattening that here would destroy the
 * cardinality axis the differential has to measure (WI-39855 leg c). See
 * `diffQueryShape` in `differential.ts`, which normalizes it explicitly.
 */
export type ZeroQueryRunner = (
  queryPath: string,
  args: Record<string, unknown>,
  principal: string | null,
) => Promise<unknown>;

export function createZeroQueryRunner(pool: Pool): ZeroQueryRunner {
  const database = zeroNodePg(schema, pool);
  return async (queryPath, args, principal) => {
    const leaf = resolveQueryLeaf(queryPath);
    if (!leaf) {
      throw new Error(
        `Unknown Zero query '${queryPath}' — not defined in @papercusp/sidestage-zero's queries registry.`,
      );
    }
    const build = leaf as (...callArgs: unknown[]) => unknown;
    const request = build(args);
    const query = addContextToQuery(request as never, { userID: principal } as never);
    return database.run(query as never);
  };
}

/**
 * PHASE 2, IMPLEMENTED (WI-39867). Runs the same named query through the LIVE
 * REST/SSE resolver — the actual `SyncQueryRegistry` a bootstrapped `AppModule`
 * populated, not a mock. A mock would be re-describing the behaviour under test
 * and could agree with the Zero rung while production disagreed.
 *
 * `SyncQueryRegistry.resolve` already enforces the array contract, so the return
 * type is honest: any singular-vs-array asymmetry lives entirely on the Zero
 * side, which is what makes the cardinality comparison meaningful.
 */
export type SseQueryRunner = (
  queryName: string,
  args: Record<string, unknown>,
  principal: string | null,
) => Promise<unknown[]>;

export function createSseQueryRunner(registry: {
  resolve: (name: string, args: Record<string, unknown>, context: { principal: string | null }) => Promise<unknown[]>;
}): SseQueryRunner {
  return (queryName, args, principal) => registry.resolve(queryName, args, { principal });
}
