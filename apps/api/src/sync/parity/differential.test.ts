/**
 * Always-on half of the per-query differential parity harness (WI-39867).
 *
 * The differential RUN needs a seeded Postgres and so is gated behind
 * `SIDESTAGE_PG_INTEGRATION=1` (`differential.integration.test.ts`). This file
 * is everything that can be proven WITHOUT a database, and it runs on every
 * `npm test` on purpose:
 *
 *   - **Coverage totality.** The realistic future regression is not a subtle row
 *     mismatch — it is a new synced query landing with no fixture, so the
 *     differential quietly stops covering it. That must fail in the ordinary
 *     suite, not in an opt-in run nobody armed.
 *   - **The comparison logic itself**, including a CONTROL that reproduces the
 *     exact WI-39839 signature. A guard that has never failed is a guard nobody
 *     has tested, so the shipped `events.guide` bug is replayed here as data and
 *     the harness must report it.
 *
 * Registered REST names come from `data-surface-census.ts`, the same authority
 * `zero-contract.parity.test.ts` uses, and for the same reason: the census is
 * itself fail-closed against the real tree (`data-surface-census.test.ts` walks
 * the source and rejects any registration it does not classify). Reading it here
 * keeps "which names exist on REST" a single guarded fact instead of a second
 * hand-kept list that could drift from the first.
 */
import { describe, expect, it } from 'vitest';

import { SYNC_QUERY_SURFACES } from '../data-surface-census';
import {
  PARITY_FIXTURES,
  comparableQueryNames,
  diffQueryShape,
  formatShapeDiff,
  missingFixtures,
  staleFixtures,
  type ParitySeedRefs,
} from './differential';

const registeredNames = SYNC_QUERY_SURFACES.map((surface) => surface.name);

const refs: ParitySeedRefs = {
  eventId: 'parity-event-1',
  eventItemId: 'parity-item-1',
  productId: 'parity-product-1',
  sellerId: 'seller-parity',
  cartId: 'parity-cart-1',
};

describe('differential parity coverage', () => {
  it('has a fixture for every query that exists on BOTH transports', () => {
    // The whole point of the harness: a name on both rungs whose rows could
    // disagree. One with no fixture is a hole in the differential.
    expect(missingFixtures(registeredNames)).toEqual([]);
  });

  it('has no fixture for a query that left the contract', () => {
    // A stale fixture reads as coverage while testing nothing.
    expect(staleFixtures(registeredNames)).toEqual([]);
  });

  it('actually compares a non-trivial number of queries', () => {
    // Guards the guard: if `comparableQueryNames` silently resolved to [] (a
    // renamed census field, a broken import), every assertion above would pass
    // vacuously. A floor turns that into a failure.
    expect(comparableQueryNames(registeredNames).length).toBeGreaterThanOrEqual(8);
  });

  it('excludes synced queries that have no REST registration to diff against', () => {
    // CONTRACT_AHEAD_OF_REGISTRY names are deliberate forward scope: there is no
    // second implementation, so there is nothing to compare and demanding a
    // fixture for them would be noise.
    expect(comparableQueryNames(registeredNames)).not.toContain('orders.byId');
  });

  it('every fixture builds args and a principal without throwing', () => {
    for (const [name, fixture] of Object.entries(PARITY_FIXTURES)) {
      const args = fixture.args(refs);
      expect(Object.keys(args).length, `${name} produced empty args`).toBeGreaterThan(0);
      // `null` is a legitimate principal (public queries) — assert the call
      // works, not that it returns a value.
      expect(() => fixture.principal(refs)).not.toThrow();
      expect(fixture.minRows, `${name} must guarantee at least one row`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('diffQueryShape', () => {
  const base = { queryName: 'q', minRows: 1 };

  it('reports parity when both rungs agree', () => {
    const rows = [{ id: 'a', title: 'One' }, { id: 'b', title: 'Two' }];
    const diff = diffQueryShape({ ...base, restRows: rows, zeroResult: [...rows], minRows: 2 });
    expect(diff.findings).toEqual([]);
    expect(diff.comparedRows).toBe(2);
    expect(diff.vacuous).toBe(false);
  });

  it('CONTROL — replays the shipped WI-39839 bug: a server-computed key the Zero rung drops', () => {
    // This is the real `events.guide` failure as data. REST decorates each row
    // with `viewers` + `playbackUrl`; the Zero leaf has no column for either, so
    // it served rows without them and the UI rendered a confident "0 watching".
    // Name-set parity saw nothing wrong. This harness must see it.
    const restRows = [{ eventId: 'e1', title: 'Live', viewers: 2, playbackUrl: '/whep/e1' }];
    const zeroRows = [{ eventId: 'e1', title: 'Live' }];

    const diff = diffQueryShape({ ...base, restRows, zeroResult: zeroRows });

    expect(diff.keysMissingOnZero).toEqual(['playbackUrl', 'viewers']);
    expect(diff.findings.join('\n')).toContain('SERVER-COMPUTED FIELD DROPPED');
    expect(diff.findings.length).toBeGreaterThan(0);
  });

  it('does not double-report a dropped key as a value mismatch', () => {
    // The dropped key must surface ONCE, as a key-set finding. Reporting it
    // again per row would bury the signal in noise on a wide result set.
    const restRows = [{ id: 'a', viewers: 2 }, { id: 'b', viewers: 3 }];
    const zeroRows = [{ id: 'a' }, { id: 'b' }];
    const diff = diffQueryShape({ ...base, restRows, zeroResult: zeroRows, minRows: 2 });
    expect(diff.findings.filter((f) => f.includes('viewers'))).toHaveLength(1);
  });

  it('flags a key the Zero rung serves and REST does not', () => {
    const diff = diffQueryShape({
      ...base,
      restRows: [{ id: 'a' }],
      zeroResult: [{ id: 'a', internalRank: 7 }],
    });
    expect(diff.keysMissingOnRest).toEqual(['internalRank']);
  });

  it('REFUSES to call two empty result sets parity', () => {
    // The failure mode this harness would otherwise have: a green verdict built
    // from no evidence. 0 == 0 is a consistency check, not a discriminating one.
    const diff = diffQueryShape({ ...base, restRows: [], zeroResult: [] });
    expect(diff.vacuous).toBe(true);
    expect(diff.findings.join('\n')).toContain('VACUOUS');
  });

  it('flags a singular Zero leaf standing in for a multi-row REST result', () => {
    // WI-39855 leg c: `.one()` silently shows the client one of several rows.
    const diff = diffQueryShape({
      ...base,
      restRows: [{ id: 'a' }, { id: 'b' }],
      zeroResult: { id: 'a' },
      minRows: 2,
    });
    expect(diff.zeroWasSingular).toBe(true);
    expect(diff.findings.join('\n')).toContain('cardinality');
  });

  it('treats an undefined .one() result as zero rows, not one empty row', () => {
    const diff = diffQueryShape({ ...base, restRows: [{ id: 'a' }], zeroResult: undefined });
    expect(diff.zeroRowCount).toBe(0);
    expect(diff.findings.join('\n')).toContain('row count: REST=1 Zero=0');
  });

  it('accepts a singular Zero result against a single REST row', () => {
    const row = { id: 'a', title: 'One' };
    const diff = diffQueryShape({
      ...base,
      restRows: [row],
      zeroResult: { ...row },
      zeroReturnsOne: true,
    });
    expect(diff.findings).toEqual([]);
  });

  it('compares by id rather than position, so ordering alone is not drift', () => {
    const restRows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
    const zeroRows = [{ id: 'b', n: 2 }, { id: 'a', n: 1 }];
    const diff = diffQueryShape({ ...base, restRows, zeroResult: zeroRows, minRows: 2 });
    expect(diff.findings).toEqual([]);
  });

  it('reports a genuine value mismatch on a shared key', () => {
    const diff = diffQueryShape({
      ...base,
      restRows: [{ id: 'a', priceCents: 1500 }],
      zeroResult: [{ id: 'a', priceCents: 1200 }],
    });
    expect(diff.findings.join('\n')).toContain('priceCents');
  });

  it('ignores key ORDER within a row', () => {
    const diff = diffQueryShape({
      ...base,
      restRows: [{ id: 'a', x: 1, y: 2 }],
      zeroResult: [{ y: 2, id: 'a', x: 1 }],
    });
    expect(diff.findings).toEqual([]);
  });

  it('flags a rung that returned fewer rows than the seed guarantees', () => {
    const diff = diffQueryShape({
      ...base,
      restRows: [{ id: 'a' }, { id: 'b' }],
      zeroResult: [{ id: 'a' }],
      minRows: 2,
    });
    expect(diff.findings.join('\n')).toContain('Zero returned 1 row(s)');
  });

  it('formats a readable report naming the query', () => {
    const clean = diffQueryShape({ ...base, queryName: 'event.config', restRows: [{ id: 'a' }], zeroResult: [{ id: 'a' }] });
    expect(formatShapeDiff(clean)).toContain('event.config');
    expect(formatShapeDiff(clean)).toContain('parity');
  });
});
