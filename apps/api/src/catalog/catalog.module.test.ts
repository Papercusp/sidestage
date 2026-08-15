import { describe, expect, it, vi } from 'vitest';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { CatalogSyncQueries } from './catalog.module';

const EMPTY_PAGE = {
  rows: [],
  page: 1,
  pageSize: 50,
  total: 0,
  totalIsFloor: false,
};

describe('CatalogSyncQueries inventory ownership', () => {
  it('partitions inventory reads by the request seller and never silently defaults', async () => {
    const searchOwned = vi.fn().mockResolvedValue(EMPTY_PAGE);
    const catalog = {
      search: vi.fn().mockResolvedValue(EMPTY_PAGE),
      searchOwned,
      productTypes: vi.fn().mockResolvedValue([]),
    };
    const registry = new SyncQueryRegistry();
    new CatalogSyncQueries(catalog as never, registry).onModuleInit();

    await expect(registry.resolve(
      'inventory.page',
      { page: 1, pageSize: 50 },
      { principal: null },
    )).rejects.toThrow('x-demo-principal is required for inventory.page');
    expect(searchOwned).not.toHaveBeenCalled();

    await registry.resolve(
      'inventory.page',
      { page: 1, pageSize: 50 },
      { principal: 'seller-alpha' },
    );
    expect(searchOwned).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 50 }),
      'seller-alpha',
    );

    await registry.resolve(
      'inventory.page',
      { page: 2, pageSize: 25 },
      { principal: 'seller-beta' },
    );
    expect(searchOwned).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2, pageSize: 25 }),
      'seller-beta',
    );
  });
});
