import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PolicyModule } from '../policies/policy.module';
import { PolicyService } from '../policies/policy.service';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { EventConfigController, readEventConfigView } from './event-config.controller';
import {
  EVENT_CONFIG_STORE,
  EventConfigService,
  InMemoryEventConfigStore,
  PgEventConfigStore,
} from './event-config.service';

@Injectable()
export class EventConfigSyncQueries implements OnModuleInit {
  constructor(
    @Inject(EventConfigService) private readonly configs: EventConfigService,
    @Inject(PolicyService) private readonly policies: PolicyService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.config', async (args) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      return [await readEventConfigView(this.configs, this.policies, eventId)];
    });
  }
}

@Module({
  imports: [DatabaseModule, PolicyModule, SyncModule],
  controllers: [EventConfigController],
  providers: [
    EventConfigService,
    EventConfigSyncQueries,
    {
      provide: EVENT_CONFIG_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgEventConfigStore(pool) : new InMemoryEventConfigStore()),
    },
  ],
  exports: [EventConfigService],
})
export class EventConfigModule {}
