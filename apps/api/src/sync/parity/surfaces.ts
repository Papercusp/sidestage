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
import { SYNCED_QUERY_PRINCIPAL_SCOPE, type SyncedQueryName } from '@papercusp/sidestage-zero';

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
