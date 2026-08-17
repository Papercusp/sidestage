import { describe, expect, it } from 'vitest';
import { createMutators } from '@papercusp/sidestage-zero';
import { diffRows, mutatorGuardsOwnPrincipal, mutatorLeaves, resolveQueryLeaf, runSseQuery, runZeroQuery } from './harness';

describe('resolveQueryLeaf', () => {
  it('resolves a nested dot-path to its callable leaf', () => {
    expect(typeof resolveQueryLeaf('event.lineup.items')).toBe('function');
    expect(typeof resolveQueryLeaf('cart.byId')).toBe('function');
  });

  it('returns undefined for a path that does not resolve to a function', () => {
    expect(resolveQueryLeaf('event')).toBeUndefined(); // namespace, not a leaf
    expect(resolveQueryLeaf('does.not.exist')).toBeUndefined();
    expect(resolveQueryLeaf('')).toBeUndefined();
  });
});

describe('mutatorLeaves', () => {
  it('flattens the real createMutators() registry into namespace.name pairs', () => {
    const leaves = mutatorLeaves(createMutators());
    const paths = leaves.map((l) => l.path).sort();
    expect(paths).toEqual(['chatPresence.leave', 'chatPresence.touch']);
    for (const leaf of leaves) expect(typeof leaf.fn).toBe('function');
  });
});

describe('mutatorGuardsOwnPrincipal', () => {
  it('recognizes the real chatPresence mutators as guarded', () => {
    const leaves = mutatorLeaves(createMutators());
    for (const { path, fn } of leaves) {
      expect(mutatorGuardsOwnPrincipal(fn), `${path} should carry a principal-ownership guard`).toBe(true);
    }
  });

  it('does not flag a function with no guard marker', () => {
    const unguarded = async (_tx: unknown, args: { userId: string }) => args.userId;
    expect(mutatorGuardsOwnPrincipal(unguarded as never)).toBe(false);
  });

  it('flags a function that references ctx.principal directly', () => {
    const guarded = (_tx: unknown, args: { userId: string }, ctx: { principal: string }) => {
      if (ctx.principal !== args.userId) throw new Error('nope');
    };
    expect(mutatorGuardsOwnPrincipal(guarded as never)).toBe(true);
  });
});

describe('diffRows', () => {
  it('reports no mismatches for identical rows in identical order', () => {
    const rows = [{ id: '1', title: 'a' }, { id: '2', title: 'b' }];
    expect(diffRows(rows, rows)).toEqual([]);
  });

  it('ignores key insertion order within a row', () => {
    const sse = [{ id: '1', title: 'a' }];
    const zero = [{ title: 'a', id: '1' }];
    expect(diffRows(sse, zero)).toEqual([]);
  });

  it('reports a row-count mismatch', () => {
    const mismatches = diffRows([{ id: '1' }], []);
    expect(mismatches).toEqual(['row count: SSE=1 Zero=0']);
  });

  it('reports a value mismatch at the offending row index', () => {
    const mismatches = diffRows([{ id: '1', price: 100 }], [{ id: '1', price: 90 }]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('row[0]');
  });

  it('is order-sensitive — a reorder is a reported mismatch, not silent success', () => {
    const sse = [{ id: '1' }, { id: '2' }];
    const zero = [{ id: '2' }, { id: '1' }];
    expect(diffRows(sse, zero)).not.toEqual([]);
  });
});

describe('Phase 2 seams', () => {
  it('runZeroQuery throws (not implemented until P-004 lands)', async () => {
    await expect(runZeroQuery('event.lineup.items', {})).rejects.toThrow(/Phase 2 seam/);
  });

  it('runSseQuery throws (not implemented until P-004 lands)', async () => {
    await expect(runSseQuery('event.lineup.items', {})).rejects.toThrow(/Phase 2 seam/);
  });
});
