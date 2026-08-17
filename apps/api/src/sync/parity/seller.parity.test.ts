/**
 * Seller-surface parity prep (P-005, WI-39617). See harness.ts for what
 * Phase 1 (this file) checks vs. Phase 2 (post-P-004 live data parity).
 */
import { describe, expect, it } from 'vitest';
import { resolveQueryLeaf } from './harness';
import { censusPrincipalMismatches, queryNamesForSurface, unaccountedSurfaceQueries } from './surfaces';

const SURFACE = 'seller' as const;

describe('seller surface parity', () => {
  const sellerQueries = queryNamesForSurface(SURFACE);

  it('has at least one seller-scoped synced query to verify (a guard against an accidental empty surface)', () => {
    expect(sellerQueries.length).toBeGreaterThan(0);
  });

  it.each(sellerQueries)('%s resolves to a real registry leaf', (name) => {
    expect(typeof resolveQueryLeaf(name)).toBe('function');
  });

  it('agrees with the census on every seller-owned query it classifies as synced', () => {
    expect(censusPrincipalMismatches(SURFACE)).toEqual([]);
  });

  it('accounts for every seller-scoped query as a live registration or explicit forward scope', () => {
    expect(unaccountedSurfaceQueries(SURFACE)).toEqual([]);
  });
});
