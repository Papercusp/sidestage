import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { ActionModule } from '../actions/action.module';
import { EventConfigModule } from '../config/event-config.module';
import { DatabaseModule } from '../db/database.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { RehearsalPreflightService } from './rehearsal-preflight.service';
import { RehearsalController } from './rehearsal.controller';
import { RehearsalService } from './rehearsal.service';

@Injectable()
export class RehearsalSyncQueries implements OnModuleInit {
  constructor(
    @Inject(RehearsalPreflightService) private readonly preflights: RehearsalPreflightService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('rehearsal.preflight', async (args) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId.trim() : '';
      return eventId ? [await this.preflights.read(eventId)] : [];
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
  imports: [ActionModule, DatabaseModule, EventConfigModule, SyncModule],
  controllers: [RehearsalController],
  providers: [RehearsalService, RehearsalPreflightService, RehearsalSyncQueries],
  exports: [RehearsalService],
})
export class RehearsalModule {}
