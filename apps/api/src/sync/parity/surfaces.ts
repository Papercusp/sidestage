/**
 * Per-surface groupings for the P-005 parity verification harness
 * (plan sidestage-websocket-sync-cutover-2026-08-17, WI-39617).
 *
 * Bucketing lives HERE, once, so the three surface suites
 * (buyer.parity.test.ts / seller.parity.test.ts / operational.parity.test.ts)
 * never hand-duplicate a classification the contract or the census already
 * states. A query that moves to a different principal scope, or gets
 * reclassified in the census, is picked up automatically by whichever suite
 * it now belongs to — nobody has to remember to update a second list.
 *
 * This file is intentionally derivation-only: it reads
 * `SYNCED_QUERY_PRINCIPAL_SCOPE` (the contract's own authority on who a
 * query is scoped to) and the census's `DataAudience` tags (an independently
 * authored classification), and exposes both bucketed by surface so a suite
 * can cross-check them against each other.
 */
import {
  CONTRACT_AHEAD_OF_REGISTRY,
  SYNCED_QUERY_PRINCIPAL_SCOPE,
  UNSYNCED_QUERY_REASONS,
  type SyncedQueryName,
} from '@papercusp/sidestage-zero';

import {
  POSTGRES_SURFACES,
  SYNC_MUTATOR_SURFACES,
  SYNC_QUERY_SURFACES,
  type DataAudience,
  type NamedSurface,
} from '../data-surface-census';

/**
 * The three principal-scoped surfaces P-005 verifies, plus `public` (no
 * principal to isolate, but still worth carrying so a surface lookup is
 * total over every contract entry rather than silently dropping rows).
 */
export type ParitySurface = 'buyer' | 'seller' | 'operational' | 'public';

export const PARITY_SURFACES: readonly ParitySurface[] = ['buyer', 'seller', 'operational', 'public'];

/**
 * `SYNCED_QUERY_PRINCIPAL_SCOPE`'s value type is exactly
 * `'public' | 'buyer' | 'seller' | 'operational'` (see queries.ts's
 * `satisfies` clause) — i.e. already a `ParitySurface`. No translation table
 * needed; the principal string IS the surface name.
 */
export function queryNamesForSurface(surface: ParitySurface): SyncedQueryName[] {
  return (Object.keys(SYNCED_QUERY_PRINCIPAL_SCOPE) as SyncedQueryName[]).filter(
    (name) => SYNCED_QUERY_PRINCIPAL_SCOPE[name] === surface,
  );
}

/**
 * The census's `DataAudience` vocabulary is richer than `ParitySurface`
 * (`streaming`, `device-local` have no principal to isolate). This is the
 * one place that narrows one to the other.
 */
const AUDIENCE_TO_SURFACE: Partial<Record<DataAudience, ParitySurface>> = {
  'buyer-owned': 'buyer',
  'seller-owned': 'seller',
  operational: 'operational',
  public: 'public',
};

export function audienceSurfaces(audiences: readonly DataAudience[]): ParitySurface[] {
  return [...new Set(audiences.map((a) => AUDIENCE_TO_SURFACE[a]).filter((s): s is ParitySurface => !!s))];
}

/** Every census-registered live sync query whose audiences touch `surface`. */
export function censusQuerySurfacesFor(surface: ParitySurface): NamedSurface[] {
  return SYNC_QUERY_SURFACES.filter((s) => audienceSurfaces(s.audiences).includes(surface));
}

/** Every census-registered mutator call site whose audiences touch `surface`. */
export function censusMutatorSurfacesFor(surface: ParitySurface): NamedSurface[] {
  return SYNC_MUTATOR_SURFACES.filter((s) => audienceSurfaces(s.audiences).includes(surface));
}

/** The census's own identity-scope prose for a Postgres table (e.g. "selected buyer/cart owner"). */
export function identityScopeForTable(table: string): string | undefined {
  return (POSTGRES_SURFACES as Record<string, { identityScope: string } | undefined>)[table]?.identityScope;
}

/**
 * For every census query surface touching `surface` that IS synced, the
 * contract's chosen principal must be ONE OF the surfaces the census tags it
 * under — not necessarily equal to `surface` alone, because a query can
 * legitimately carry multiple census audiences (e.g. `event.auction.active`
 * is `['public', 'seller-owned']`: publicly readable, but the seller holds
 * exclusive command/write authority over it) while the contract records only
 * the READ principal actually enforced. A mismatch here means the census's
 * audience tags and the contract's principal share NO surface at all — that
 * is real drift, not a dual-audience false positive — exactly the class of
 * bug two independently maintained classification lists can develop without
 * either one alone noticing (P-002's contract test only checks
 * synced-vs-unsynced, never WHICH surface). Empty = consistent.
 */
export function censusPrincipalMismatches(surface: ParitySurface): string[] {
  return censusQuerySurfacesFor(surface)
    .filter((s) => s.name in SYNCED_QUERY_PRINCIPAL_SCOPE)
    .filter((s) => !audienceSurfaces(s.audiences).includes(SYNCED_QUERY_PRINCIPAL_SCOPE[s.name as SyncedQueryName]))
    .map(
      (s) =>
        `${s.name}: census audiences (${s.audiences.join(', ')}) do not include the contract's principal '${SYNCED_QUERY_PRINCIPAL_SCOPE[s.name as SyncedQueryName]}'`,
    );
}

/**
 * Every query the contract scopes to `surface` must be either a live census
 * registration (an actual `SyncQueryRegistry` entry today) or explicit
 * forward scope (`CONTRACT_AHEAD_OF_REGISTRY`) — never neither, which would
 * mean a client call site using it 404s at `/zero/query` once P-004 flips
 * the transport. Empty = consistent.
 */
export function unaccountedSurfaceQueries(surface: ParitySurface): string[] {
  const liveNames = new Set(censusQuerySurfacesFor(surface).map((s) => s.name));
  return queryNamesForSurface(surface).filter((name) => !liveNames.has(name) && !(name in CONTRACT_AHEAD_OF_REGISTRY));
}

/**
 * Every operational-audience census query that IS synced must be scoped
 * principal `'operational'` (never silently `'public'`/`'buyer'`/`'seller'`),
 * and every one that is NOT synced must carry a documented
 * `UNSYNCED_QUERY_REASONS` entry. Empty = consistent. (Only meaningful for
 * `surface: 'operational'` — the other three surfaces are fully covered by
 * `censusPrincipalMismatches` + `unaccountedSurfaceQueries` above.)
 */
export function operationalDispositionGaps(): string[] {
  return censusQuerySurfacesFor('operational')
    .filter((s) => !(s.name in SYNCED_QUERY_PRINCIPAL_SCOPE) && !(s.name in UNSYNCED_QUERY_REASONS))
    .map((s) => `${s.name}: operational-audience census query with neither a synced principal nor an UNSYNCED_QUERY_REASONS entry`);
}
