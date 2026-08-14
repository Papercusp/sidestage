import { Inject, Body, Controller, Get, Param, Post, Sse, type MessageEvent } from '@nestjs/common';
import { from, interval, merge, type Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AuctionService, type AuctionSseEvent, type PlaceBidInput, type StartAuctionInput } from './auction.service';

@Controller('auctions')
export class AuctionController {
  constructor(@Inject(AuctionService) private readonly auctions: AuctionService) {}

  @Post('start')
  start(@Body() body: StartAuctionInput) {
    return this.auctions.startAuction(body);
  }

  @Get('events/:eventId/active')
  active(@Param('eventId') eventId: string) {
    return this.auctions.getCurrentAuction(eventId);
  }

  @Sse('events/:eventId/stream')
  stream(@Param('eventId') eventId: string): Observable<MessageEvent> {
    const initial = from(this.auctions.snapshotEvent(eventId)).pipe(
      map((event): MessageEvent => event as AuctionSseEvent as MessageEvent),
    );
    const updates = this.auctions.updates(eventId).pipe(
      map((event): MessageEvent => event as AuctionSseEvent as MessageEvent),
    );
    const heartbeat = interval(15_000).pipe(
      map((): MessageEvent => {
        const now = Date.now();
        return {
          id: `auction-heartbeat-${now}`,
          type: 'heartbeat',
          data: JSON.stringify({ tsMs: now }),
        };
      }),
    );
    return merge(initial, updates, heartbeat);
  }

  @Get('inventory/:productId')
  inventory(@Param('productId') productId: string) {
    return this.auctions.inventorySnapshot(productId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.auctions.getAuction(id);
  }

  @Post(':id/bids')
  bid(@Param('id') id: string, @Body() body: PlaceBidInput) {
    return this.auctions.placeBid(id, body);
  }

  @Post(':id/close')
  close(@Param('id') id: string) {
    return this.auctions.closeAuction(id);
  }
}
