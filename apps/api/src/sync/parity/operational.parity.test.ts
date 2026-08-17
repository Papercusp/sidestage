/**
 * Operational-surface parity prep (P-005, WI-39617). See harness.ts for what
 * Phase 1 (this file) checks vs. Phase 2 (post-P-004 live data parity).
 *
 * Unlike buyer/seller, NO operational query is synced today —
 * `SYNCED_QUERY_PRINCIPAL_SCOPE` carries zero `'operational'` entries
 * (build.history / judge.latest / rehearsal.preflight are all deliberately
 * unsynced, per UNSYNCED_QUERY_REASONS). The assertions here are written to
 * PASS on that current state and FAIL the moment it changes without this
 * harness being updated — the first operational query to go synced forces
 * whoever ships it to also extend the operational surface's parity checks,
 * rather than silently drifting past them.
 */
import { describe, expect, it } from 'vitest';
import { censusPrincipalMismatches, censusQuerySurfacesFor, operationalDispositionGaps, queryNamesForSurface } from './surfaces';

const SURFACE = 'operational' as const;

describe('operational surface parity', () => {
  it('has at least one operational-audience census query to verify (a guard against an accidental empty surface)', () => {
    expect(censusQuerySurfacesFor(SURFACE).length).toBeGreaterThan(0);
  });

  it('records the current pre-cutover state: zero operational queries are synced yet', () => {
    // Update this expectation (and add the new query's Phase-2 wiring) the
    // day an operational query actually goes synced — this failing is the
    // signal, not a bug.
    expect(queryNamesForSurface(SURFACE)).toEqual([]);
  });

  it('gives every operational-audience query a disposition: synced-and-operational, or explicitly unsynced', () => {
    expect(operationalDispositionGaps()).toEqual([]);
  });

  it('never lets an operational-audience query get scoped to a non-operational principal', () => {
    expect(censusPrincipalMismatches(SURFACE)).toEqual([]);
  });
});
