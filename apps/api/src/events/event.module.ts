import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { ChatModule } from '../chat/chat.module';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgEventStore } from '../db/pg-event-store';
import { EventController } from './event.controller';
import { EVENT_STORE, EventService, InMemoryEventStore } from './event.service';

/**
 * Event directory for the buyer Channel Guide (P-118 / D-019).
 *
 * Same store seam as cart/orders/auction-inventory: Postgres when a pool is
 * reachable, the in-memory demo set otherwise, chosen once at wiring time so
 * no request path has to branch on backend.
 *
 * ChatModule is imported for live viewer counts — the guide reads presence at
 * request time rather than persisting a counter that would outlive its viewers.
 */
@Module({
  imports: [DatabaseModule, ChatModule],
  controllers: [EventController],
  providers: [
    EventService,
    {
      provide: EVENT_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgEventStore(pool) : new InMemoryEventStore()),
    },
  ],
  exports: [EventService],
})
export class EventModule {}
