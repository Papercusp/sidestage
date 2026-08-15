import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { EventConfigModule } from '../config/event-config.module';
import { EventModule } from '../events/event.module';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { OrderModule } from '../checkout/order.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { ActionController } from './action.controller';
import { GuardedActionService } from './action.service';

@Injectable()
export class ActionSyncQueries implements OnModuleInit {
  constructor(
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.actions.items', async (args, context) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      await this.ownership.requireOwned(eventId, context.principal);
      return this.actions.listItems(eventId);
    });
  }
}

@Module({
  imports: [EventConfigModule, EventModule, OrderModule, SyncModule],
  controllers: [ActionController],
  providers: [GuardedActionService, ActionSyncQueries],
  exports: [GuardedActionService],
})
export class ActionModule {}
