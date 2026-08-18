import { describe, expect, it } from 'vitest';
import { createMutators } from '@papercusp/sidestage-zero';
import {
  createSseQueryRunner,
  createZeroQueryRunner,
  diffRows,
  mutatorGuardsOwnPrincipal,
  mutatorLeaves,
  resolveQueryLeaf,
} from './harness';

describe('resolveQueryLeaf', () => {
  it('resolves a nested dot-path to its callable leaf', () => {
    expect(typeof resolveQueryLeaf('event.lineup.items')).toBe('function');
    expect(typeof resolveQueryLeaf('event.chat.messages')).toBe('function');
  });

  it('returns undefined for a path that does not resolve to a function', () => {
    expect(resolveQueryLeaf('event')).toBeUndefined(); // namespace, not a leaf
    expect(resolveQueryLeaf('does.not.exist')).toBeUndefined();
    expect(resolveQueryLeaf('')).toBeUndefined();
  });

  it('returns undefined for a name D-025 demoted to UNSYNCED_QUERY_REASONS', () => {
    // `cart.byId` used to be the second case in the resolves-a-leaf test above.
    // Asserting its ABSENCE is the more useful assertion now: a demoted name
    // that quietly regains a leaf is how the WS rung would start serving a
    // payload-jsonb blob again, and nothing else in the suite would notice.
    expect(resolveQueryLeaf('cart.byId')).toBeUndefined();
    expect(resolveQueryLeaf('event.config')).toBeUndefined();
    expect(resolveQueryLeaf('event.auction.active')).toBeUndefined();
    expect(resolveQueryLeaf('event.replay.chapters')).toBeUndefined();
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

/**
 * The Phase 2 seams no longer throw — they are implemented (WI-39867). What is
 * still worth asserting WITHOUT a database is the failure that would otherwise
 * be silent: asking for a query name the contract does not define. Returning
 * `[]` there would make contract drift look like an empty result set, which is
 * the same "plausible-looking emptiness" trap `zero.controller.ts` refuses.
 */
describe('Phase 2 runners', () => {
  it('createSseQueryRunner delegates to the live registry with the principal in context', async () => {
    const calls: { name: string; args: unknown; context: unknown }[] = [];
    const runner = createSseQueryRunner({
      resolve: async (name, args, context) => {
        calls.push({ name, args, context });
        return [{ id: 'row-1' }];
      },
    });

    const rows = await runner('event.chat.messages', { eventId: 'e1' }, 'buyer-1');

    expect(rows).toEqual([{ id: 'row-1' }]);
    expect(calls).toEqual([
      { name: 'event.chat.messages', args: { eventId: 'e1' }, context: { principal: 'buyer-1' } },
    ]);
  });

  it('createSseQueryRunner passes a null principal through rather than dropping it', async () => {
    // `null` is a real value for public queries; coercing it to undefined would
    // change which branch a handler's principal check takes.
    const seen: unknown[] = [];
    const runner = createSseQueryRunner({
      resolve: async (_name, _args, context) => {
        seen.push(context);
        return [];
      },
    });
    await runner('event.chat.presence', { eventId: 'e1' }, null);
    expect(seen).toEqual([{ principal: null }]);
  });

  it('createZeroQueryRunner refuses an unknown query name instead of returning no rows', async () => {
    // No database is touched: the name is rejected before any query is built,
    // so this runs in the ordinary hermetic suite.
    const runner = createZeroQueryRunner({} as never);
    await expect(runner('event.not.a.real.query', {}, null)).rejects.toThrow(/Unknown Zero query/);
  });
});
