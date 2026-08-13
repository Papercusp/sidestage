import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { CatalogController } from './catalog.controller';
import { FixtureCatalogSource, PgCatalogSource } from './catalog.sources';
import { CATALOG_SOURCE } from './catalog.types';

@Module({
  imports: [DatabaseModule],
  controllers: [CatalogController],
  providers: [
    {
      provide: CATALOG_SOURCE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgCatalogSource(pool) : new FixtureCatalogSource()),
    },
  ],
  exports: [CATALOG_SOURCE],
})
export class CatalogModule {}
