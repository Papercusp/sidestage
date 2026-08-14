import { Controller, Get, Inject, Injectable, Module, Param, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { ChatService } from '../chat/chat.service';
import { ChatModule } from '../chat/chat.module';
import { ActionModule } from '../actions/action.module';
import { GuardedActionService } from '../actions/action.service';
import { AuctionModule } from '../auction/auction.module';
import { AuctionService } from '../auction/auction.service';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';

export interface EventStats {
  eventId: string;
  /** Live room presence (chat presence for the event). */
  viewers: number;
  /** Paid checkout orders — the settled truth (auction wins settle here too). */
  itemsSold: number;
  totalRaisedCents: number;
}

export interface PricingHistory {
  productId: string;
  prices: Array<{ priceCents: number; soldQty: number; rejectedQty: number }>;
  offers: Array<{
    id: string;
    buyerId: string;
    priceCents: number;
    quantity: number;
    outcome: 'pending' | 'accepted' | 'rejected';
  }>;
  auctions: Array<{
    id: string;
    priceCents: number;
    quantity: number;
    outcome: 'active' | 'sold' | 'no-sale';
    bidderId?: string;
    closedAt?: string;
  }>;
}

/**
 * Live event stats (P-111 — no dummy data): viewers from real chat presence,
 * sold/raised from PAID checkout orders in Postgres. With no database (memory
 * mode) sold/raised are honestly zero rather than invented.
 */
@Injectable()
export class EventStatsService {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(PG_POOL) private readonly pool: Pool | null,
  ) {}

  async read(eventId: string): Promise<EventStats> {
    const viewers = this.chat.getStats(eventId).activeUsers;
    let itemsSold = 0;
    let totalRaisedCents = 0;
    if (this.pool) {
      const result = await this.pool.query<{ items: string; raised: string }>(
        `SELECT COALESCE(SUM(jsonb_array_length(payload->'items')), 0) AS items,
                COALESCE(SUM((payload->>'totalCents')::bigint), 0) AS raised
         FROM checkout_order WHERE status = 'paid'`,
      );
      itemsSold = Number(result.rows[0]?.items ?? 0);
      totalRaisedCents = Number(result.rows[0]?.raised ?? 0);
    }
    return { eventId, viewers, itemsSold, totalRaisedCents };
  }
}

@Controller('events')
export class StatsController {
  constructor(
    @Inject(EventStatsService) private readonly eventStats: EventStatsService,
    @Inject(PG_POOL) private readonly pool: Pool | null,
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(AuctionService) private readonly auctions: AuctionService,
  ) {}

  @Get(':eventId/stats')
  async stats(@Param('eventId') eventId: string): Promise<EventStats> {
    return this.eventStats.read(eventId);
  }


  /** Real seller history for the active product; no fixture rows are invented. */
  @Get(':eventId/products/:productId/pricing-history')
  async pricingHistory(
    @Param('eventId') eventId: string,
    @Param('productId') productId: string,
  ): Promise<PricingHistory> {
    const priceRows = new Map<number, { priceCents: number; soldQty: number; rejectedQty: number }>();
    if (this.pool) {
      const result = await this.pool.query<{ price_cents: string; sold_qty: string; rejected_qty: string }>(
        `SELECT (item->>'priceCents')::integer AS price_cents,
                COALESCE(SUM((item->>'quantity')::integer) FILTER (WHERE status = 'paid'), 0) AS sold_qty,
                COALESCE(SUM((item->>'quantity')::integer) FILTER (WHERE status = 'failed'), 0) AS rejected_qty
         FROM checkout_order
         CROSS JOIN LATERAL jsonb_array_elements(payload->'items') AS item
         WHERE item->>'productId' = $1 AND status IN ('paid', 'failed')
         GROUP BY (item->>'priceCents')::integer
         ORDER BY price_cents DESC`,
        [productId],
      );
      for (const row of result.rows) {
        const priceCents = Number(row.price_cents);
        priceRows.set(priceCents, {
          priceCents,
          soldQty: Number(row.sold_qty),
          rejectedQty: Number(row.rejected_qty),
        });
      }
    }

    const offerById = new Map<string, PricingHistory['offers'][number]>();
    for (const audit of this.actions.listAudit(eventId)) {
      for (const offer of audit.after.offers) {
        if (offer.productId !== productId) continue;
        offerById.set(offer.id, {
          id: offer.id,
          buyerId: offer.buyerId,
          priceCents: offer.priceCents,
          quantity: offer.quantity,
          outcome: offer.status === 'accepted'
            ? 'accepted'
            : offer.status === 'pending' ? 'pending' : 'rejected',
        });
      }
    }

    const auctionRows = await this.auctions.listByProduct(productId);
    return {
      productId,
      prices: [...priceRows.values()],
      offers: [...offerById.values()].reverse(),
      auctions: auctionRows.map((auction) => ({
        id: auction.id,
        priceCents: auction.currentPriceCents,
        quantity: auction.quantity,
        outcome: auction.status === 'active' ? 'active' : auction.winnerOrder ? 'sold' : 'no-sale',
        bidderId: auction.winnerOrder?.bidderId,
        closedAt: auction.closedAt,
      })),
    };
  }
}

@Injectable()
export class StatsSyncQueries implements OnModuleInit {
  constructor(
    @Inject(EventStatsService) private readonly stats: EventStatsService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.stats', async (args) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      return [await this.stats.read(eventId)];
    });
  }
}

@Module({
  imports: [ActionModule, AuctionModule, ChatModule, DatabaseModule, SyncModule],
  controllers: [StatsController],
  providers: [EventStatsService, StatsSyncQueries],
})
export class StatsModule {}
