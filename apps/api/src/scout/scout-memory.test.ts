import { describe, expect, it } from 'vitest';
import {
  DisabledScoutMemoryStore,
  InMemoryScoutMemoryStore,
  memoryScopes,
  memoryRelevanceTokens,
  memoryScore,
  memoryTokens,
  STORE_SCOPE,
} from './scout-memory';

describe('memoryScopes', () => {
  it('gives an identified buyer their own scope plus the shared one', () => {
    expect(memoryScopes('buyer-1')).toEqual({
      scopes: ['user:buyer-1', STORE_SCOPE],
      writeScope: 'user:buyer-1',
    });
  });

  it('lets a guest READ the store scope but write nowhere', () => {
    // The write asymmetry is the isolation rule: if guests could write to
    // `store`, every anonymous visitor's turns would land in the one bucket
    // every other visitor recalls from.
    expect(memoryScopes(undefined)).toEqual({ scopes: [STORE_SCOPE], writeScope: null });
    expect(memoryScopes(null)).toEqual({ scopes: [STORE_SCOPE], writeScope: null });
  });

  it('treats a blank or whitespace buyer id as a guest, not as scope "user:"', () => {
    // A `user:` scope with an empty id would be a shared bucket wearing a
    // per-user name — the worst of both, and silent.
    expect(memoryScopes('')).toEqual({ scopes: [STORE_SCOPE], writeScope: null });
    expect(memoryScopes('   ')).toEqual({ scopes: [STORE_SCOPE], writeScope: null });
  });
});

describe('memoryScore', () => {
  it('scores by the fraction of QUERY tokens present, so length does not win', () => {
    const short = 'red running shoes';
    const long = `red running shoes ${'and other things '.repeat(20)}`;
    // Both contain every query token, so neither out-ranks the other on length.
    expect(memoryScore(short, 'red shoes')).toBe(1);
    expect(memoryScore(long, 'red shoes')).toBe(1);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(memoryScore('Red Shoes!', 'red shoes')).toBe(1);
  });

  it('scores a partial match proportionally and a miss at zero', () => {
    expect(memoryScore('red shoes', 'red boots')).toBe(0.5);
    expect(memoryScore('red shoes', 'blue hat')).toBe(0);
  });

  it('scores an empty query at zero rather than dividing by nothing', () => {
    expect(memoryScore('anything', '')).toBe(0);
    expect(memoryScore('anything', '!!!')).toBe(0);
  });

  it('does not treat conversational filler as evidence that two turns are related', () => {
    expect(memoryScore('find me kettles', 'find me computers')).toBe(0);
    expect(memoryScore('show me wireless headphones', 'find wireless headphones')).toBe(1);
  });
});

describe('memoryRelevanceTokens', () => {
  it('drops filler while preserving the product subject', () => {
    expect(memoryRelevanceTokens('Please find me some computers')).toEqual(['computers']);
  });
});

describe('memoryTokens', () => {
  it('lowercases and keeps only alphanumeric runs', () => {
    expect(memoryTokens("Red Shoes, size 10!")).toEqual(['red', 'shoes', 'size', '10']);
  });

  it('yields nothing for punctuation-only text', () => {
    // Load-bearing: the Postgres store checks this to avoid handing
    // `to_tsquery` an empty string.
    expect(memoryTokens('!!! ???')).toEqual([]);
  });
});

describe('InMemoryScoutMemoryStore', () => {
  it('recalls only within the requested scopes', async () => {
    const store = new InMemoryScoutMemoryStore();
    await store.remember('user:a', 'looking for red shoes');
    await store.remember('user:b', 'looking for red shoes');

    const mine = await store.recall(['user:a'], 'red shoes');
    expect(mine.map((m) => m.scope)).toEqual(['user:a']);
  });

  it('does not leak one buyer’s memories into another’s recall', async () => {
    const store = new InMemoryScoutMemoryStore();
    await store.remember('user:a', 'my shipping address is 10 Elm Street');

    const other = await store.recall(memoryScopes('b').scopes, 'shipping address');
    expect(other).toEqual([]);
  });

  it('reads across every requested scope at once', async () => {
    const store = new InMemoryScoutMemoryStore();
    await store.remember('user:a', 'I want red shoes');
    await store.remember(STORE_SCOPE, 'shoes ship free this week');

    const hits = await store.recall(memoryScopes('a').scopes, 'shoes');
    expect(hits.map((m) => m.scope).sort()).toEqual(['store', 'user:a']);
  });

  it('ranks better matches first and breaks ties by recency', async () => {
    const store = new InMemoryScoutMemoryStore();
    await store.remember('s', 'shoes');
    await store.remember('s', 'red shoes');
    await store.remember('s', 'red shoes'); // newest of the two equal-scoring

    const [first, second] = await store.recall(['s'], 'red shoes');
    expect(first.text).toBe('red shoes');
    expect(second.text).toBe('red shoes');
  });

  it('returns nothing rather than everything for an unmatched query', async () => {
    // A store that fell back to "return all" would quietly feed unrelated
    // memories into the prompt.
    const store = new InMemoryScoutMemoryStore();
    await store.remember('s', 'red shoes');
    expect(await store.recall(['s'], 'kitchen blender')).toEqual([]);
  });

  it('honours the k limit', async () => {
    const store = new InMemoryScoutMemoryStore();
    for (let i = 0; i < 10; i += 1) await store.remember('s', `red shoes ${i}`);
    expect(await store.recall(['s'], 'red shoes', 3)).toHaveLength(3);
  });

  it('ignores a blank write and a blank/scopeless recall', async () => {
    const store = new InMemoryScoutMemoryStore();
    await store.remember('s', '   ');
    await store.remember('', 'orphan');
    expect(await store.recall(['s'], 'orphan')).toEqual([]);
    expect(await store.recall([], 'anything')).toEqual([]);
    expect(await store.recall(['s'], '  ')).toEqual([]);
  });

  it('trims stored text so recall echoes a clean memory', async () => {
    const store = new InMemoryScoutMemoryStore();
    await store.remember('s', '  red shoes  ');
    expect((await store.recall(['s'], 'red shoes'))[0]?.text).toBe('red shoes');
  });
});

describe('DisabledScoutMemoryStore', () => {
  it('is a silent null object on both halves of the contract', async () => {
    const store = new DisabledScoutMemoryStore();
    await expect(store.remember()).resolves.toBeUndefined();
    await expect(store.recall()).resolves.toEqual([]);
  });
});
