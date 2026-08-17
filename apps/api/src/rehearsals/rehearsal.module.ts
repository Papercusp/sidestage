import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { ActionModule } from '../actions/action.module';
import { EventConfigModule } from '../config/event-config.module';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgRehearsalStore } from '../db/pg-rehearsal-store';
import { EventModule } from '../events/event.module';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { RehearsalPreflightService } from './rehearsal-preflight.service';
import { RehearsalController } from './rehearsal.controller';
import { RehearsalService } from './rehearsal.service';
import { InMemoryRehearsalStore, REHEARSAL_STORE, type RehearsalStore } from './rehearsal.store';

/**
 * Postgres is the authority whenever a pool exists. The in-memory store is a
 * development fallback only — it is process-local, so a deployment that lands
 * on it silently loses the durability this lane exists to provide.
 */
export function rehearsalStoreForPool(pool: Pool | null): RehearsalStore {
  return pool ? new PgRehearsalStore(pool) : new InMemoryRehearsalStore();
}

@Injectable()
export class RehearsalSyncQueries implements OnModuleInit {
  constructor(
    @Inject(RehearsalPreflightService) private readonly preflights: RehearsalPreflightService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  onModuleInit(): void {
    this.queries.register('rehearsal.preflight', async (args, context) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId.trim() : '';
      await this.ownership.requireOwned(eventId, context.principal);
      return [await this.preflights.read(eventId)];
    });
  }
}

/**
 * The rehearsals deliberately construct their own service instances rather than
 * injecting the live singletons, so a run cannot touch a real event. This
 * module therefore imports only what the PREFLIGHT needs: the saved event
 * config, the policy resolver + the live action service it READS (registered
 * items, for the enforced-policy lint (WI-38673) — never mutated), the database
 * handle it reports the durability of, and the global sync invalidation stream
 * used by the measured client round-trip probe.
 */
@Module({
  imports: [ActionModule, DatabaseModule, EventConfigModule, EventModule, SyncModule],
  controllers: [RehearsalController],
  providers: [
    RehearsalService,
    RehearsalPreflightService,
    RehearsalSyncQueries,
    {
      provide: REHEARSAL_STORE,
      inject: [PG_POOL],
      useFactory: rehearsalStoreForPool,
    },
  ],
  exports: [RehearsalService],
})
export class RehearsalModule {}
