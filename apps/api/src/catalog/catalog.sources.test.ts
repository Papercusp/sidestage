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
      categories: undefined,
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

  it('prepends an exact Postgres title that has not reached Typesense yet', async () => {
    typesenseSearch.mockResolvedValue({
      hits: [{ id: 'indexed-kettle-v1', groupId: 'indexed-kettle' }],
      found: 190,
    });
    const otherKettle = {
      id: 'indexed-kettle-v1', groupId: 'indexed-kettle', title: 'Stainless Tea Kettle', brand: 'Indexed',
      productType: 'KITCHEN', sku: 'INDEXED-1', color: null, size: null, condition: 'NEW', handlingDays: 1,
      priceCents: 5_000, qty: 4, reservedQty: 0, availableQty: 4, imageUrl: null, description: null,
      weight: null, dimensions: null,
    };
    const harborKettle = {
      ...otherKettle,
      id: 'sidestage-onboarding-harbor-kettle-v1',
      groupId: 'sidestage-onboarding-harbor-kettle',
      title: 'Harbor Kettle',
      brand: 'Hearthline',
      sku: 'SS-ONBOARD-HARBOR-KETTLE',
      priceCents: 7_400,
    };
    const observedParams: unknown[][] = [];
    const responses = [
      { rows: [] },
      { rows: [otherKettle] },
      { rows: [{ n: '1' }] },
      { rows: [harborKettle] },
    ];
    let responseIndex = 0;
    const poolQuery = vi.fn(async (_query: string, params: unknown[]) => {
      observedParams.push([...params]);
      return responses[responseIndex++];
    });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool, '');

    const page = await source.search({ q: 'Harbor Kettle', pageSize: 6 });

    expect(page.rows.map((row) => row.title)).toEqual(['Harbor Kettle', 'Stainless Tea Kettle']);
    expect(page.total).toBe(191);
    const [exactCountSql] = poolQuery.mock.calls[2] as [string, unknown[]];
    expect(exactCountSql).toContain('c.search_tsv @@');
    expect(exactCountSql).toContain('lower(c.title) = lower($2)');
    expect(observedParams[2]).toEqual([['harbor', 'kettle'], 'Harbor Kettle', 10_001]);
  });

  it('passes typed multi-category intent to Typesense as an OR filter', async () => {
    typesenseSearch.mockResolvedValue({
      hits: [{ id: 'notebook-1', groupId: 'notebook-group' }],
      found: 1,
    });
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool, '');

    await source.search({
      q: 'Dell',
      productTypes: ['NOTEBOOK_COMPUTER', 'PERSONAL_COMPUTER'],
      availability: 'in-stock',
      pageSize: 6,
    });

    expect(typesenseSearch).toHaveBeenCalledWith(expect.objectContaining({
      q: 'Dell',
      categories: ['NOTEBOOK_COMPUTER', 'PERSONAL_COMPUTER'],
      inStockOnly: true,
    }));
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
    const expectedTokens = ['kettles', 'sale'];
    expect(countSql).toContain(
      "c.search_tsv @@ to_tsquery('english', array_to_string($2::text[], ':* | ') || ':*')",
    );
    expect(rowsSql).toContain(
      "ORDER BY ts_rank(c.search_tsv, to_tsquery('english', array_to_string($2::text[], ':* | ') || ':*')) DESC",
    );
    expect(observedParams[1]).toEqual([EVENT_DEMO_COLLECTION, expectedTokens, 10_001]);
    expect(observedParams[2]).toEqual([EVENT_DEMO_COLLECTION, expectedTokens, 6, 0]);
  });

  it('keeps only product terms from the exact Scout in-stock request', async () => {
    const observedParams: unknown[][] = [];
    const responses = [
      { rows: [] },
      { rows: [{ n: '1' }] },
      { rows: [{
        id: 'hp-tape-drive-v1',
        groupId: 'hp-tape-drive',
        title: 'HP StoreEver Tape Drive',
        brand: 'HP',
        productType: 'DATA_STORAGE',
        sku: 'HP-TAPE-1',
        color: null,
        size: null,
        condition: 'NEW',
        handlingDays: 1,
        priceCents: 39_900,
        reservedQty: 0,
        availableQty: 2,
        imageUrl: null,
        description: 'External LTO tape backup drive',
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
      q: 'Find an in-stock HP tape drive.',
      availability: 'in-stock',
      pageSize: 6,
    });

    expect(page.rows[0]?.title).toBe('HP StoreEver Tape Drive');
    expect(observedParams[1]).toEqual([
      EVENT_DEMO_COLLECTION,
      ['hp', 'tape', 'drive'],
      10_001,
    ]);
    expect(observedParams[2]).toEqual([
      EVENT_DEMO_COLLECTION,
      ['hp', 'tape', 'drive'],
      6,
      0,
    ]);
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

  it('scopes a typo-tolerant Typesense hit to the requesting seller (searchOwned parity with search)', async () => {
    typesenseSearch.mockResolvedValue({
      hits: [{ id: 'nortel-phone-v1', groupId: 'nortel-phone' }, { id: 'other-sellers-phone-v1', groupId: 'other-sellers-phone' }],
      found: 2,
    });
    const ownedRow = {
      id: 'nortel-phone-v1', groupId: 'nortel-phone', title: 'Nortel Phone', brand: 'Nortel',
      productType: 'ELECTRONICS', sku: 'NORTEL-1', color: null, size: null, condition: 'NEW', handlingDays: 1,
      priceCents: 4_200, qty: 3, reservedQty: 0, availableQty: 3, imageUrl: null, description: null,
      weight: null, dimensions: null,
    };
    const observedParams: unknown[][] = [];
    const poolQuery = vi.fn(async (_query: string, params: unknown[]) => {
      observedParams.push([...params]);
      // Only the hydration query runs (rows.length > 0 short-circuits before
      // any SQL tsvector fallback call).
      return { rows: [ownedRow] };
    });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool, '');

    const page = await source.searchOwned({ q: 'nortl', pageSize: 6 }, 'seller-JHGLDS');

    expect(typesenseSearch).toHaveBeenCalledWith({
      q: 'nortl',
      categories: undefined,
      inStockOnly: false,
      limit: 6,
      page: 1,
      includeFields: ['id', 'groupId'],
    });
    expect(poolQuery.mock.calls[0]).toEqual(['SELECT expire_inventory_reservations()', []]);
    const [hydrationSql, hydrationParams] = poolQuery.mock.calls[1] as [string, unknown[]];
    expect(hydrationSql).toContain('v.seller_id = $2');
    expect(hydrationParams).toEqual([['nortel-phone', 'other-sellers-phone'], 'seller-JHGLDS']);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.title).toBe('Nortel Phone');
    // `found` is Typesense's corpus-wide count, intentionally not re-derived
    // per-seller (see the settled-design note on searchOwned).
    expect(page.total).toBe(2);
  });

  it('falls through to the SQL tsvector path when a seller-scoped Typesense hydration returns zero rows', async () => {
    typesenseSearch.mockResolvedValue({
      hits: [{ id: 'other-sellers-item-v1', groupId: 'other-sellers-item' }],
      found: 1,
    });
    const observedParams: unknown[][] = [];
    const responses = [
      { rows: [] }, // SELECT expire_inventory_reservations() (unused)
      { rows: [] }, // hydration: seller owns none of the indexed hits
      { rows: [{ n: '1' }] }, // SQL fallback count
      { rows: [{
        id: 'seller-owned-kettle-v1', groupId: 'seller-owned-kettle', title: 'Harbor Kettle', brand: 'Hearthline',
        productType: 'HOME', sku: 'SELLER-KETTLE-1', color: null, size: null, condition: 'NEW', handlingDays: 1,
        priceCents: 7_400, qty: 2, reservedQty: 0, availableQty: 2, imageUrl: null, description: null,
        weight: null, dimensions: null,
      }] }, // SQL fallback rows
    ];
    let responseIndex = 0;
    const poolQuery = vi.fn(async (_query: string, params: unknown[]) => {
      observedParams.push([...params]);
      return responses[responseIndex++];
    });
    const source = new PgCatalogSource({ query: poolQuery } as unknown as Pool, '');

    const page = await source.searchOwned({ q: 'kettle', pageSize: 6 }, 'seller-JHGLDS');

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.title).toBe('Harbor Kettle');
    const [fallbackSql, fallbackParams] = poolQuery.mock.calls[3] as [string, unknown[]];
    expect(fallbackSql).toContain('v.seller_id = $1');
    expect(fallbackParams).toEqual(['seller-JHGLDS', ['kettle'], 6, 0]);
  });
});

describe('FixtureCatalogSource', () => {
  it('matches any requested product type while excluding lexical accessory matches', async () => {
    const base = {
      groupId: null, brand: 'Restart', sku: 'SKU', condition: 'NEW', handlingDays: 1,
      priceCents: 100_00, qty: 2, reservedQty: 0, availableQty: 2,
    };
    const source = new FixtureCatalogSource([
      { ...base, id: 'laptop', title: 'Latitude laptop', productType: 'NOTEBOOK_COMPUTER' },
      { ...base, id: 'desktop', title: 'OptiPlex desktop', productType: 'PERSONAL_COMPUTER' },
      { ...base, id: 'bag', title: 'Computer carrying bag', productType: 'CARRYING_CASE_OR_BAG' },
    ]);

    const page = await source.search({
      productTypes: ['NOTEBOOK_COMPUTER', 'PERSONAL_COMPUTER'],
      pageSize: 10,
    });

    expect(page.rows.map((row) => row.id)).toEqual(['laptop', 'desktop']);
  });

  it('mirrors absolute inventory saves into subsequent reads without mutating the shared fixture', async () => {
    const fixture = [{
      id: 'mug', groupId: 'cups', title: 'Mug', brand: 'Kiln', productType: 'HOME', sku: 'MUG',
      condition: 'NEW', handlingDays: 1, priceCents: 1_200, qty: 5, availableQty: 3,
      reservedQty: 2,
    }];
    const source = new FixtureCatalogSource(fixture);

    await expect(source.saveInventory('mug', 7, 1_500)).resolves.toMatchObject({ qty: 7, reservedQty: 2, availableQty: 5, priceCents: 1_500 });
    await expect(source.variant('mug')).resolves.toMatchObject({ qty: 7, reservedQty: 2, availableQty: 5, priceCents: 1_500 });
    await expect(source.saveInventory('mug', 1, 1_500)).rejects.toThrow('Quantity cannot be lower than 2 reserved units');
    expect(fixture[0]).toMatchObject({ qty: 5, availableQty: 3, priceCents: 1_200 });
  });

  it('clones a fixture listing into seller-owned search without reassigning the source', async () => {
    const source = new FixtureCatalogSource([{
      id: 'kettle', groupId: 'kettles', title: 'Harbor Kettle', brand: 'Harbor', productType: 'KITCHEN', sku: 'HK-1',
      condition: 'NEW', handlingDays: 1, priceCents: 3_000, qty: 9, reservedQty: 1, availableQty: 8,
    }]);

    await expect(source.onboardInventory('kettle', 'seller-kettle', 'seller-alpha', 2, 2_500)).resolves.toMatchObject({
      id: 'seller-kettle', qty: 2, reservedQty: 0, availableQty: 2, priceCents: 2_500,
    });
    await expect(source.searchOwned({}, 'seller-alpha')).resolves.toMatchObject({
      total: 1,
      rows: [expect.objectContaining({ id: 'seller-kettle' })],
    });
    await expect(source.searchOwned({}, 'demo-seller')).resolves.toMatchObject({
      total: 1,
      rows: [expect.objectContaining({ id: 'kettle', qty: 9, reservedQty: 1 })],
    });
  });
});
