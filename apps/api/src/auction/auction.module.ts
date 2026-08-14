import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { AuctionController } from './auction.controller';
import { AuctionService } from './auction.service';

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
  imports: [InventoryModule, SyncModule],
  controllers: [AuctionController],
  providers: [AuctionService, AuctionSyncQueries],
  exports: [AuctionService],
})
export class AuctionModule {}
