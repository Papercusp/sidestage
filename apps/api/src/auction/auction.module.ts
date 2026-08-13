import { Module } from '@nestjs/common';
import { AuctionController } from './auction.controller';
import { AUCTION_INVENTORY, AuctionService, InMemoryAuctionInventory } from './auction.service';

@Module({
  controllers: [AuctionController],
  providers: [
    AuctionService,
    InMemoryAuctionInventory,
    { provide: AUCTION_INVENTORY, useExisting: InMemoryAuctionInventory },
  ],
  exports: [AuctionService],
})
export class AuctionModule {}
