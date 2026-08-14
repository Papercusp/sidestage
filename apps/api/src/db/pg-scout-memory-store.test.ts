import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgScoutMemoryStore } from './pg-scout-memory-store';

/**
 * Guards for the Postgres memory store (P-012, D-008).
 *
 * The SQL itself is verified against a real database; what these pin are the
 * properties a mocked pool CAN prove and that a refactor could silently break:
 * the query is parameterized the way injection-safety depends on, the empty
 * case issues no query at all, and both methods honour the degrade contract.
 */
const poolWith = (rows: unknown[] = []) => {
  const query = vi.fn().mockResolvedValue({ rows });
  return { pool: { query } as unknown as Pool, query };
};

describe('PgScoutMemoryStore.recall', () => {
  it('passes the query as ALPHANUMERIC TOKENS, never as raw text', async () => {
    // to_tsquery parses its input as query SYNTAX, so raw user text there is
    // both a crash risk and an injection surface. Tokens cannot express syntax.
    const { pool, query } = poolWith();
    await new PgScoutMemoryStore(pool).recall(['user:a'], 'red shoes & ! ( :* boom');

    const [, params] = query.mock.calls[0];
    expect(params[1]).toEqual(['red', 'shoes', 'boom']);
    expect(params[1].join('')).not.toMatch(/[&!():*]/);
  });

  it('ORs the tokens rather than ANDing them', async () => {
    // plainto_tsquery ANDs every term, so a multi-word question would recall
    // only a memory containing ALL of them — which silently returns nothing.
    const { pool, query } = poolWith();
    await new PgScoutMemoryStore(pool).recall(['user:a'], 'red shoes');
    expect(query.mock.calls[0][0]).toContain("' | '");
  });

  it('scopes the read to the requested scopes and honours k', async () => {
    const { pool, query } = poolWith();
    await new PgScoutMemoryStore(pool).recall(['user:a', 'store'], 'shoes', 3);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.scope = ANY($1::text[])');
    expect(params[0]).toEqual(['user:a', 'store']);
    expect(params[3]).toBe(3);
  });

  it('issues NO query when the text has no usable tokens', async () => {
    // to_tsquery on an empty string is a pointless round-trip at best.
    const { pool, query } = poolWith();
    expect(await new PgScoutMemoryStore(pool).recall(['user:a'], '!!! ???')).toEqual([]);
    expect(await new PgScoutMemoryStore(pool).recall([], 'red shoes')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('degrades to [] and reports, rather than throwing, when the pool fails', async () => {
    const query = vi.fn().mockRejectedValue(new Error('pool exploded'));
    const warnings: string[] = [];
    const store = new PgScoutMemoryStore({ query } as unknown as Pool, (m) => warnings.push(m));

    expect(await store.recall(['user:a'], 'red shoes')).toEqual([]);
    expect(warnings[0]).toContain('pool exploded');
  });

  it('maps rows onto the memory shape', async () => {
    const { pool } = poolWith([{ id: '1', scope: 'user:a', kind: 'turn', text: 'red shoes' }]);
    expect(await new PgScoutMemoryStore(pool).recall(['user:a'], 'red shoes')).toEqual([
      { id: '1', scope: 'user:a', kind: 'turn', text: 'red shoes' },
    ]);
  });
});

describe('PgScoutMemoryStore.remember', () => {
  it('inserts the trimmed text under the given scope and kind', async () => {
    const { pool, query } = poolWith();
    await new PgScoutMemoryStore(pool).remember('user:a', '  red shoes  ', 'turn');

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO scout_memory');
    expect(params[1]).toBe('user:a');
    expect(params[2]).toBe('turn');
    expect(params[3]).toBe('red shoes');
  });

  it('writes nothing for blank text or a blank scope', async () => {
    const { pool, query } = poolWith();
    const store = new PgScoutMemoryStore(pool);
    await store.remember('user:a', '   ');
    await store.remember('', 'orphan');
    expect(query).not.toHaveBeenCalled();
  });

  it('drops the write rather than throwing when the pool fails', async () => {
    // A memory write must never break the turn that triggered it.
    const query = vi.fn().mockRejectedValue(new Error('pool exploded'));
    const warnings: string[] = [];
    const store = new PgScoutMemoryStore({ query } as unknown as Pool, (m) => warnings.push(m));

    await expect(store.remember('user:a', 'red shoes')).resolves.toBeUndefined();
    expect(warnings[0]).toContain('pool exploded');
  });
});
