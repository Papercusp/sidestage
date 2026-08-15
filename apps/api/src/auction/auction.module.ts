import { forwardRef, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { OrderModule } from '../checkout/order.module';
import { PgAuctionStore } from '../db/pg-auction-store';
import { EventModule } from '../events/event.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { AuctionAccessService, AuctionAuditService } from './auction-access.service';
import { AuctionController } from './auction.controller';
import { AUCTION_STORE, AuctionService } from './auction.service';

@Injectable()
export class AuctionSyncQueries implements OnModuleInit {
  constructor(
    @Inject(AuctionService) private readonly auctions: AuctionService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.auction.active', async (args) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      const auction = await this.auctions.getCurrentAuction(eventId);
      return auction ? [auction] : [];
    });
  }
}

@Module({
  imports: [DatabaseModule, forwardRef(() => EventModule), InventoryModule, OrderModule, SyncModule],
  controllers: [AuctionController],
  providers: [
    {
      provide: AUCTION_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgAuctionStore(pool) : null),
    },
    {
      provide: AuctionAccessService,
      useFactory: () => new AuctionAccessService(),
    },
    AuctionAuditService,
    AuctionService,
    AuctionSyncQueries,
  ],
  exports: [AuctionService, AuctionAccessService],
})
export class AuctionModule {}
