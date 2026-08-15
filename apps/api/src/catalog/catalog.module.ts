import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL, demoDataEnabled } from '../db/database.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry, type SyncQueryArgs } from '../sync/sync-query.registry';
import { rolePrincipal } from '../sync/sync-request-context';
import { CatalogController } from './catalog.controller';
import {
  EVENT_DEMO_COLLECTION,
  FixtureCatalogSource,
  PgCatalogSource,
  UnavailableCatalogSource,
} from './catalog.sources';
import { CATALOG_SOURCE, type CatalogQuery, type CatalogSource } from './catalog.types';

function optionalString(args: SyncQueryArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value ? value : undefined;
}

function optionalNumber(args: SyncQueryArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

@Injectable()
export class CatalogSyncQueries implements OnModuleInit {
  constructor(
    @Inject(CATALOG_SOURCE) private readonly catalog: CatalogSource,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('catalog.page', async (args) => {
      const productType = optionalString(args, 'productType');
      const query: CatalogQuery = {
        q: optionalString(args, 'q'),
        productType: productType === 'all' ? undefined : productType,
        availability: args.availability === 'in-stock' ? 'in-stock' : 'all',
        page: optionalNumber(args, 'page'),
        pageSize: optionalNumber(args, 'pageSize'),
      };
      return [await this.catalog.search(query)];
    });
    this.queries.register('catalog.types', () => this.catalog.productTypes());
    this.queries.register('inventory.page', async (args, context) => {
      const sellerId = rolePrincipal(context.principal, 'seller');
      if (!sellerId) throw new Error('x-demo-principal is required for inventory.page');
      const productType = optionalString(args, 'productType');
      const query: CatalogQuery = {
        q: optionalString(args, 'q'),
        productType: productType === 'all' ? undefined : productType,
        availability: args.availability === 'in-stock' ? 'in-stock' : 'all',
        page: optionalNumber(args, 'page'),
        pageSize: optionalNumber(args, 'pageSize'),
      };
      return [await this.catalog.searchOwned(query, sellerId)];
    });
  }
}

export function catalogSourceForPool(
  pool: Pool | null,
  env: NodeJS.ProcessEnv = process.env,
): CatalogSource {
  if (pool) {
    const collection = env.NODE_ENV === 'production' ? '' : EVENT_DEMO_COLLECTION;
    return new PgCatalogSource(pool, collection);
  }
  return demoDataEnabled(env) ? new FixtureCatalogSource() : new UnavailableCatalogSource();
}

@Module({
  imports: [DatabaseModule, SyncModule],
  controllers: [CatalogController],
  providers: [
    CatalogSyncQueries,
    {
      provide: CATALOG_SOURCE,
      inject: [PG_POOL],
      useFactory: catalogSourceForPool,
    },
  ],
  exports: [CATALOG_SOURCE],
})
export class CatalogModule {}
