import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { EventModule } from '../events/event.module';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { RunOfShowController } from './run-of-show.controller';
import {
  InMemoryRunOfShowStore,
  PgRunOfShowStore,
  RUN_OF_SHOW_STORE,
  RunOfShowService,
} from './run-of-show.service';

@Injectable()
export class RunOfShowSyncQueries implements OnModuleInit {
  constructor(
    @Inject(RunOfShowService) private readonly runOfShow: RunOfShowService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.runOfShow', async (args, context) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      await this.ownership.requireOwned(eventId, context.principal);
      return [await this.runOfShow.get(eventId)];
    });
  }
}

@Module({
  imports: [DatabaseModule, EventModule, SyncModule],
  controllers: [RunOfShowController],
  providers: [
    RunOfShowService,
    RunOfShowSyncQueries,
    {
      provide: RUN_OF_SHOW_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgRunOfShowStore(pool) : new InMemoryRunOfShowStore()),
    },
  ],
  exports: [RunOfShowService],
})
export class RunOfShowModule {}
