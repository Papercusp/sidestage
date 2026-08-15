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
  it('reads seeded inventory for generated demo sessions and isolates named sellers', async () => {
    const searchOwned = vi.fn().mockResolvedValue(EMPTY_PAGE);
    const catalog = {
      search: vi.fn().mockResolvedValue(EMPTY_PAGE),
      searchOwned,
      productTypes: vi.fn().mockResolvedValue([]),
    };
    const registry = new SyncQueryRegistry();
    new CatalogSyncQueries(catalog as never, registry).onModuleInit();

    await registry.resolve(
      'inventory.page',
      { page: 1, pageSize: 50 },
      { principal: 'demo-54598e91' },
    );
    expect(searchOwned).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 50 }),
      'demo-seller',
    );

    await registry.resolve(
      'inventory.page',
      { page: 1, pageSize: 50 },
      { principal: 'demo-avi' },
    );
    expect(searchOwned).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 50 }),
      'seller-demo-avi',
    );
  });
});
