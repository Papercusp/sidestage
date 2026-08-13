import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgAuctionInventory } from '../db/pg-auction-inventory';
import { AuctionController } from './auction.controller';
import { AUCTION_INVENTORY, AuctionService, InMemoryAuctionInventory } from './auction.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuctionController],
  providers: [
    AuctionService,
    {
      provide: AUCTION_INVENTORY,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgAuctionInventory(pool) : new InMemoryAuctionInventory()),
    },
  ],
  exports: [AuctionService],
})
export class AuctionModule {}
