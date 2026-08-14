import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { typesenseSearch } = vi.hoisted(() => ({
  typesenseSearch: vi.fn(),
}));

vi.mock('@papercusp/typesense', () => ({
  typesenseService: { search: typesenseSearch },
}));

import { EVENT_DEMO_COLLECTION, FixtureCatalogSource, PgCatalogSource } from './catalog.sources';

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
    expect(poolQuery.mock.calls[0]).toEqual(['SELECT expire_inventory_reservations()', []]);
    const [query, params] = poolQuery.mock.calls[1] as [string, unknown[]];
    expect(query).toContain('v.group_id = ANY($1)');
    expect(query).toContain('v.group_id IS NULL AND v.id = ANY($1)');
    expect(query).not.toContain('COALESCE(v.group_id, v.id) = ANY($1)');
    expect(params).toEqual([['group-1']]);
  });

  it('finds plural product terms inside a natural-language question', async () => {
    const observedParams: unknown[][] = [];
    const responses = [
      { rows: [] },
      { rows: [{ n: '4' }] },
      { rows: [{
        id: 'event-demo-kettle-v1',
        groupId: 'event-demo-kettle',
        title: 'Harbor Kettle',
        brand: 'Harbor',
        productType: 'HOME',
        sku: 'KETTLE-1',
        color: 'Blue',
        size: null,
        condition: 'NEW',
        handlingDays: 1,
        priceCents: 4_500,
        reservedQty: 0,
        availableQty: 3,
        imageUrl: null,
        description: 'A compact stovetop kettle',
        weight: null,
        dimensions: null,
      }] },
    ];
    let responseIndex = 0;
    const poolQuery = vi.fn(async (_query: string, params: unknown[]) => {
      observedParams.push([...params]);
      return responses[responseIndex++];
    });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool);

    const page = await source.search({
      q: 'are there any kettles for sale?',
      availability: 'in-stock',
      pageSize: 6,
    });

    expect(page.rows[0]?.title).toBe('Harbor Kettle');
    const [countSql] = poolQuery.mock.calls[1] as [string, unknown[]];
    const [rowsSql] = poolQuery.mock.calls[2] as [string, unknown[]];
    const expectedTokens = ['are', 'there', 'any', 'kettles', 'for', 'sale'];
    expect(countSql).toContain(
      "c.search_tsv @@ to_tsquery('english', array_to_string($2::text[], ':* | ') || ':*')",
    );
    expect(rowsSql).toContain(
      "ORDER BY ts_rank(c.search_tsv, to_tsquery('english', array_to_string($2::text[], ':* | ') || ':*')) DESC",
    );
    expect(observedParams[1]).toEqual([EVENT_DEMO_COLLECTION, expectedTokens, 10_001]);
    expect(observedParams[2]).toEqual([EVENT_DEMO_COLLECTION, expectedTokens, 6, 0]);
  });

  it('returns no products and issues no unfiltered read for punctuation-only search text', async () => {
    const poolQuery = vi.fn().mockResolvedValue({ rows: [] });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool);

    await expect(source.search({ q: '!!! ???' })).resolves.toEqual({
      rows: [],
      page: 1,
      pageSize: 24,
      total: 0,
      totalIsFloor: false,
    });
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(poolQuery).toHaveBeenCalledWith('SELECT expire_inventory_reservations()', []);
  });

  it('scopes default reads to the curated collection and projects both option axes', async () => {
    const observedParams: unknown[][] = [];
    const responses = [
      { rows: [] },
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
        reservedQty: 4,
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
    expect(page.rows[0]).toMatchObject({ color: 'Midnight', size: 'Medium', reservedQty: 4 });
    expect(poolQuery.mock.calls[0]).toEqual(['SELECT expire_inventory_reservations()', []]);
    const [countSql] = poolQuery.mock.calls[1] as [string, unknown[]];
    const [rowsSql] = poolQuery.mock.calls[2] as [string, unknown[]];
    expect(countSql).toContain(
      "c.properties @> jsonb_build_object('sidestageCollection', $1::text)",
    );
    expect(countSql).not.toContain("properties->>'sidestageCollection'");
    expect(observedParams[0]).toEqual([]);
    expect(observedParams[1]).toEqual([EVENT_DEMO_COLLECTION, 10_001]);
    expect(rowsSql).toContain("axis.slug = 'color'");
    expect(rowsSql).toContain("axis.slug = 'size'");
    expect(rowsSql).toContain('v.reserved_qty AS "reservedQty"');
    expect(observedParams[2]).toEqual([EVENT_DEMO_COLLECTION, 50, 0]);
  });

  it('uses the GIN-compatible collection predicate for every curated read', async () => {
    const poolQuery = vi.fn().mockResolvedValue({ rows: [] });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool);

    await source.productTypes();
    await source.variant('event-demo-36-v2');

    const [typesSql, typesParams] = poolQuery.mock.calls[0] as [string, unknown[]];
    const [variantSql, variantParams] = poolQuery.mock.calls[1] as [string, unknown[]];
    expect(typesSql).toContain(
      "properties @> jsonb_build_object('sidestageCollection', $2::text)",
    );
    expect(typesParams).toEqual([40, EVENT_DEMO_COLLECTION]);
    expect(variantSql).toContain(
      "c.properties @> jsonb_build_object('sidestageCollection', $2::text)",
    );
    expect(variantParams).toEqual(['event-demo-36-v2', EVENT_DEMO_COLLECTION]);
    expect(`${typesSql}\n${variantSql}`).not.toContain("properties->>'sidestageCollection'");
  });

  it('omits the collection predicate and parameter for intentionally unscoped reads', async () => {
    const observedParams: unknown[][] = [];
    const poolQuery = vi.fn(async (_query: string, params: unknown[]) => {
      observedParams.push([...params]);
      return { rows: [] };
    });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool, '');

    await source.search({ page: 1, pageSize: 50 });
    await source.productTypes();
    await source.variant('any-variant');

    const calls = poolQuery.mock.calls as [string, unknown[]][];
    expect(calls).toHaveLength(5);
    for (const [sql] of calls) {
      expect(sql).not.toContain('sidestageCollection');
    }
    expect(observedParams).toEqual([
      [],
      [10_001],
      [50, 0],
      [40],
      ['any-variant'],
    ]);
  });
});

describe('FixtureCatalogSource', () => {
  it('mirrors inventory intake into subsequent catalog reads without mutating the shared fixture', async () => {
    const fixture = [{
      id: 'mug', groupId: 'cups', title: 'Mug', brand: 'Kiln', productType: 'HOME', sku: 'MUG',
      condition: 'NEW', handlingDays: 1, priceCents: 1_200, availableQty: 2,
      reservedQty: 0,
    }];
    const source = new FixtureCatalogSource(fixture);

    await expect(source.restock('mug', 3, 1_500)).resolves.toMatchObject({ availableQty: 5, priceCents: 1_500 });
    await expect(source.variant('mug')).resolves.toMatchObject({ availableQty: 5, priceCents: 1_500 });
    expect(fixture[0]).toMatchObject({ availableQty: 2, priceCents: 1_200 });
  });
});
