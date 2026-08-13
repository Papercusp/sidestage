import { Controller, Get, Inject, Module, Param } from '@nestjs/common';
import type { Pool } from 'pg';
import { ChatService } from '../chat/chat.service';
import { ChatModule } from '../chat/chat.module';
import { DatabaseModule, PG_POOL } from '../db/database.module';

export interface EventStats {
  eventId: string;
  /** Live room presence (chat presence for the event). */
  viewers: number;
  /** Paid checkout orders — the settled truth (auction wins settle here too). */
  itemsSold: number;
  totalRaisedCents: number;
}

/**
 * Live event stats (P-111 — no dummy data): viewers from real chat presence,
 * sold/raised from PAID checkout orders in Postgres. With no database (memory
 * mode) sold/raised are honestly zero rather than invented.
 */
@Controller('events')
export class StatsController {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(PG_POOL) private readonly pool: Pool | null,
  ) {}

  @Get(':eventId/stats')
  async stats(@Param('eventId') eventId: string): Promise<EventStats> {
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

@Module({
  imports: [ChatModule, DatabaseModule],
  controllers: [StatsController],
})
export class StatsModule {}
