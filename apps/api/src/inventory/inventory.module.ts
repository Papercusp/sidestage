import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { AUCTION_INVENTORY, InMemoryAuctionInventory } from '../auction/auction.service';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgAuctionInventory } from '../db/pg-auction-inventory';
import { InventoryController } from './inventory.controller';

/**
 * The ONE inventory-hold provider (P-103). Auctions, buyer holds, and event
 * quantity limits all share it — a hold is a hold, whoever places it.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [InventoryController],
  providers: [
    {
      provide: AUCTION_INVENTORY,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgAuctionInventory(pool) : new InMemoryAuctionInventory()),
    },
  ],
  exports: [AUCTION_INVENTORY],
})
export class InventoryModule {}
