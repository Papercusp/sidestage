import { forwardRef, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { ChatModule } from '../chat/chat.module';
import { DatabaseModule, PG_POOL, demoDataEnabled } from '../db/database.module';
import { PgEventStore } from '../db/pg-event-store';
import { SyncModule } from '../sync/sync.module';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { rolePrincipal } from '../sync/sync-request-context';
import { EventActivationSweeper } from './event-activation.sweeper';
import { EventController } from './event.controller';
import { EventOwnershipGuard } from './event-ownership.guard';
import { EventVisibilityGuard } from './event-visibility.guard';
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
  imports: [DatabaseModule, forwardRef(() => ChatModule), SyncModule],
  controllers: [EventController],
  providers: [
    EventService,
    EventOwnershipGuard,
    EventVisibilityGuard,
    EventSyncQueries,
    // D-003: keeps a scheduled event's promised start time by taking the room
    // live server-side, with no seller and no buyer tab required.
    //
    // Registered via useFactory — NOT as a bare class provider — for the same
    // reason ChatPresenceSweeper is (chat.module.ts): the constructor's third
    // parameter is a plain `intervalMs: number` with a default. Under `tsc`
    // (emitDecoratorMetadata) Nest reads design:paramtypes as
    // [EventService, SyncInvalidationService, Number], has no provider for
    // `Number`, and the whole app fails to boot with
    // UnknownDependenciesException. Constructing it explicitly here lets the
    // default apply and keeps the token list to the two real dependencies.
    // A bare class provider survives `tsx` only because esbuild emits no
    // decorator metadata, so this breaks in the built app and NOT in dev.
    {
      provide: EventActivationSweeper,
      inject: [EventService, SyncInvalidationService],
      useFactory: (
        events: EventService,
        invalidations: SyncInvalidationService,
      ): EventActivationSweeper => new EventActivationSweeper(events, invalidations),
    },
    {
      provide: EVENT_STORE,
      inject: [PG_POOL],
      useFactory: eventStoreForPool,
    },
  ],
  exports: [EventService, EventOwnershipGuard, EventVisibilityGuard, EVENT_STORE],
})
export class EventModule {}
