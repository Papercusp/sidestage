import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { ChatModule } from '../chat/chat.module';
import { DatabaseModule, PG_POOL, demoDataEnabled } from '../db/database.module';
import { PgEventStore } from '../db/pg-event-store';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { rolePrincipal } from '../sync/sync-request-context';
import { EventController } from './event.controller';
import {
  EVENT_STORE,
  EventService,
  InMemoryEventStore,
  UnavailableEventStore,
  type EventStore,
} from './event.service';

@Injectable()
export class EventSyncQueries implements OnModuleInit {
  constructor(
    @Inject(EventService) private readonly events: EventService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('events.guide', () => this.events.listForGuide());
    this.queries.register('events.mine', (_args, context) => {
      const sellerId = rolePrincipal(context.principal, 'seller');
      if (!sellerId) throw new Error('x-demo-principal is required for events.mine');
      return this.events.listForSeller(sellerId);
    });
  }
}

export function eventStoreForPool(
  pool: Pool | null,
  env: NodeJS.ProcessEnv = process.env,
): EventStore {
  if (pool) return new PgEventStore(pool);
  return demoDataEnabled(env) ? new InMemoryEventStore() : new UnavailableEventStore();
}

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
  imports: [DatabaseModule, ChatModule, SyncModule],
  controllers: [EventController],
  providers: [
    EventService,
    EventSyncQueries,
    {
      provide: EVENT_STORE,
      inject: [PG_POOL],
      useFactory: eventStoreForPool,
    },
  ],
  exports: [EventService, EVENT_STORE],
})
export class EventModule {}
