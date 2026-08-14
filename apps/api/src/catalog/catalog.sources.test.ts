import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { typesenseSearch } = vi.hoisted(() => ({
  typesenseSearch: vi.fn(),
}));

vi.mock('@papercusp/typesense', () => ({
  typesenseService: { search: typesenseSearch },
}));

import { EVENT_DEMO_COLLECTION, PgCatalogSource } from './catalog.sources';

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
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool, '');

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
    const [query, params] = poolQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('v.group_id = ANY($1)');
    expect(query).toContain('v.group_id IS NULL AND v.id = ANY($1)');
    expect(query).not.toContain('COALESCE(v.group_id, v.id) = ANY($1)');
    expect(params).toEqual([['group-1']]);
  });

  it('scopes default reads to the curated collection and projects both option axes', async () => {
    const observedParams: unknown[][] = [];
    const responses = [
      { rows: [{ n: '200' }] },
      { rows: [{
        id: 'event-demo-36-v2',
        groupId: 'event-demo-36',
        title: 'Coastal Wrap Dress',
        brand: 'Atelier June',
        productType: 'APPAREL',
        sku: 'SS-DEMO-36-V2',
        color: 'Midnight',
        size: 'Medium',
        condition: 'NEW',
        handlingDays: 2,
        priceCents: 15_000,
        availableQty: 9,
        imageUrl: null,
        description: null,
        weight: null,
        dimensions: null,
      }] },
    ];
    let responseIndex = 0;
    const poolQuery = vi.fn(async (_query: string, params: unknown[]) => {
      // PgCatalogSource awaits the count before reusing its local params array.
      // Snapshot here because a spy's call record intentionally retains the
      // array reference and would otherwise observe the later push/pop state.
      observedParams.push([...params]);
      return responses[responseIndex++];
    });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool);

    const page = await source.search({ page: 1, pageSize: 50 });

    expect(page.total).toBe(200);
    expect(page.rows[0]).toMatchObject({ color: 'Midnight', size: 'Medium' });
    const [countSql] = poolQuery.mock.calls[0] as [string, unknown[]];
    const [rowsSql] = poolQuery.mock.calls[1] as [string, unknown[]];
    expect(countSql).toContain("properties->>'sidestageCollection' = $1");
    expect(observedParams[0]).toEqual([EVENT_DEMO_COLLECTION, 10_001]);
    expect(rowsSql).toContain("axis.slug = 'color'");
    expect(rowsSql).toContain("axis.slug = 'size'");
    expect(observedParams[1]).toEqual([EVENT_DEMO_COLLECTION, 50, 0]);
  });
});
