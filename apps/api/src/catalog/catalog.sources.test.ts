import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { typesenseSearch } = vi.hoisted(() => ({
  typesenseSearch: vi.fn(),
}));

vi.mock('@papercusp/typesense', () => ({
  typesenseService: { search: typesenseSearch },
}));

import { PgCatalogSource } from './catalog.sources';

describe('PgCatalogSource', () => {
  beforeEach(() => {
    typesenseSearch.mockReset();
  });

  it('keeps the cold first search on the slim ranking-key response path', async () => {
    typesenseSearch.mockResolvedValue({
      hits: [{ id: 'document-1', groupId: 'group-1' }],
      found: 1,
    });
    const poolQuery = vi.fn().mockResolvedValue({ rows: [] });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool);

    await source.search({
      q: 'a versatile gift for a remote worker who travels and loves music',
      availability: 'in-stock',
      pageSize: 6,
    });

    expect(typesenseSearch).toHaveBeenCalledTimes(1);
    expect(typesenseSearch).toHaveBeenCalledWith({
      q: 'a versatile gift for a remote worker who travels and loves music',
      category: undefined,
      inStockOnly: true,
      limit: 6,
      page: 1,
      includeFields: ['id', 'groupId'],
    });
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('COALESCE(v.group_id, v.id) = ANY($1)'), [
      ['group-1'],
    ]);
  });
});
