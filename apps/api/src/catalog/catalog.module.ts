import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry, type SyncQueryArgs } from '../sync/sync-query.registry';
import { CatalogController } from './catalog.controller';
import { FixtureCatalogSource, PgCatalogSource } from './catalog.sources';
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
  }
}

@Module({
  imports: [DatabaseModule, SyncModule],
  controllers: [CatalogController],
  providers: [
    CatalogSyncQueries,
    {
      provide: CATALOG_SOURCE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgCatalogSource(pool) : new FixtureCatalogSource()),
    },
  ],
  exports: [CATALOG_SOURCE],
})
export class CatalogModule {}
