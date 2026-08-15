import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { AUCTION_INVENTORY, InMemoryAuctionInventory } from '../auction/auction.service';
import { CatalogModule } from '../catalog/catalog.module';
import { CATALOG_SOURCE, type CatalogSource } from '../catalog/catalog.types';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgAuctionInventory } from '../db/pg-auction-inventory';
import { EventModule } from '../events/event.module';
import { SyncModule } from '../sync/sync.module';
import { InventoryController } from './inventory.controller';

/**
 * The ONE inventory-hold provider (P-103). Auctions, buyer holds, and event
 * quantity limits all share it — a hold is a hold, whoever places it.
 */
@Module({
  imports: [DatabaseModule, SyncModule, CatalogModule, EventModule],
  controllers: [InventoryController],
  providers: [
    {
      provide: AUCTION_INVENTORY,
      inject: [PG_POOL, CATALOG_SOURCE],
      useFactory: (pool: Pool | null, catalog: CatalogSource) => (
        pool ? new PgAuctionInventory(pool) : new InMemoryAuctionInventory(catalog)
      ),
    },
  ],
  exports: [AUCTION_INVENTORY],
})
export class InventoryModule {}
