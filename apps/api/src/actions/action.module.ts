import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { EventConfigModule } from '../config/event-config.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { ActionController } from './action.controller';
import { GuardedActionService } from './action.service';

@Injectable()
export class ActionSyncQueries implements OnModuleInit {
  constructor(
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.actions.items', (args) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      return this.actions.listItems(eventId);
    });
  }
}

@Module({
  imports: [EventConfigModule, SyncModule],
  controllers: [ActionController],
  providers: [GuardedActionService, ActionSyncQueries],
  exports: [GuardedActionService],
})
export class ActionModule {}
