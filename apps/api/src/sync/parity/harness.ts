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
 * must never leak another's. That needs the `/zero/query` handler P-004
 * builds — this lane is explicitly NOT that (WI-39617: "Do NOT flip the app
 * transport"). Two things are pinned here so wiring it in is a button-press,
 * not a re-investigation:
 *
 *   - **Execution mechanism, confirmed present at `@rocicorp/zero@^1.8.0`**
 *     (this repo's pinned version): `zeroPostgresJS(schema, pg)` from
 *     `@rocicorp/zero/server/adapters/postgresjs` wraps a `postgres.js`
 *     connection into a `ZQLDatabase`, whose `.run(query)` executes a ZQL
 *     `Query` — exactly what `queries.event.lineup.items({eventId})` builds —
 *     directly against Postgres, with NO zero-cache replica required. This is
 *     the same mechanism the real `/zero/query` handler will use, so a
 *     comparison built on it exercises production code, not a
 *     reimplementation that could itself drift from what ships.
 *   - **SSE-side execution**: bootstrap the real Nest `AppModule` (the way
 *     `sync.controller.spec.ts` already bootstraps `SyncModule`) and call the
 *     live `SyncQueryRegistry.resolve(name, args, context)` — the actual
 *     production resolver, not a mock.
 *
 * `runZeroQuery` / `runSseQuery` are the typed seams Phase 2 fills in; they
 * throw until then so a suite that calls them fails loudly instead of
 * silently reporting a pass it never actually ran.
 */
import { queries } from '@papercusp/sidestage-zero';

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
 * PHASE 2 SEAM — deliberately unimplemented (needs the P-004 `/zero/query`
 * handler wired to a live Postgres). Throws rather than returning `[]` so a
 * suite that calls it fails loudly instead of reporting a false pass.
 * Wire it to: `zeroPostgresJS(schema, pg).run(resolveQueryLeaf(queryPath)!(args))`.
 */
export async function runZeroQuery(queryPath: string, _args: Record<string, unknown>): Promise<unknown[]> {
  throw new Error(
    `runZeroQuery('${queryPath}') is a Phase 2 seam (post-P-004 live data parity) — see harness.ts header for the wiring.`,
  );
}

/**
 * PHASE 2 SEAM — deliberately unimplemented (needs a bootstrapped
 * `AppModule` + live Postgres). Throws rather than returning `[]` so a suite
 * that calls it fails loudly instead of reporting a false pass. Wire it to a
 * bootstrapped `AppModule`'s `SyncQueryRegistry.resolve(queryName, args, context)`.
 */
export async function runSseQuery(queryName: string, _args: Record<string, unknown>): Promise<unknown[]> {
  throw new Error(
    `runSseQuery('${queryName}') is a Phase 2 seam (post-P-004 live data parity) — see harness.ts header for the wiring.`,
  );
}
