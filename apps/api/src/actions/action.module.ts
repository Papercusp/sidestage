import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { CatalogModule } from '../catalog/catalog.module';
import { CATALOG_SOURCE, type CatalogSource } from '../catalog/catalog.types';
import { EventConfigModule } from '../config/event-config.module';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgActionItemStore } from '../db/pg-action-item-store';
import { PgActionAuditStore } from '../db/pg-action-audit-store';
import { PgTargetedOfferStore } from '../db/pg-targeted-offer-store';
import { EventModule } from '../events/event.module';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { EventVisibilityGuard } from '../events/event-visibility.guard';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderModule } from '../checkout/order.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { ActionController } from './action.controller';
import { ACTION_ITEM_STORE, InMemoryActionItemStore, type ActionItemStore } from './action-item.store';
import { ACTION_AUDIT_STORE, InMemoryActionAuditStore, type ActionAuditStore } from './action-audit.store';
import {
  TARGETED_OFFER_STORE,
  InMemoryTargetedOfferStore,
  type TargetedOfferStore,
} from './targeted-offer.store';
import { GuardedActionService } from './action.service';
import { projectBuyerLineupItems } from './buyer-lineup.dto';

export function actionItemStoreForPool(pool: Pool | null): ActionItemStore {
  return pool ? new PgActionItemStore(pool) : new InMemoryActionItemStore();
}

export function actionAuditStoreForPool(pool: Pool | null): ActionAuditStore {
  return pool ? new PgActionAuditStore(pool) : new InMemoryActionAuditStore();
}

export function targetedOfferStoreForPool(pool: Pool | null): TargetedOfferStore {
  return pool ? new PgTargetedOfferStore(pool) : new InMemoryTargetedOfferStore();
}

@Injectable()
export class ActionSyncQueries implements OnModuleInit {
  constructor(
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
    @Inject(EventVisibilityGuard) private readonly visibility: EventVisibilityGuard,
  ) {}

  onModuleInit(): void {
    this.queries.register('event.actions.items', async (args, context) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      await this.ownership.requireOwned(eventId, context.principal);
      return this.actions.listItems(eventId);
    });
    this.queries.register('event.lineup.items', async (args) => {
      const eventId = typeof args.eventId === 'string' ? args.eventId : '';
      // Visibility must be established before any lineup data is read so draft
      // and unknown ids have the same non-enumerating boundary.
      await this.visibility.assertBuyerVisible(eventId);
      return projectBuyerLineupItems(await this.actions.listItems(eventId));
    });
  }
}

@Module({
  imports: [CatalogModule, DatabaseModule, EventConfigModule, EventModule, InventoryModule, OrderModule, SyncModule],
  controllers: [ActionController],
  providers: [
    GuardedActionService,
    ActionSyncQueries,
    {
      provide: ACTION_ITEM_STORE,
      inject: [PG_POOL],
      useFactory: actionItemStoreForPool,
    },
    {
      provide: ACTION_AUDIT_STORE,
      inject: [PG_POOL],
      useFactory: actionAuditStoreForPool,
    },
    {
      provide: TARGETED_OFFER_STORE,
      inject: [PG_POOL],
      useFactory: targetedOfferStoreForPool,
    },
  ],
  exports: [GuardedActionService, ACTION_ITEM_STORE, ACTION_AUDIT_STORE, TARGETED_OFFER_STORE],
})
export class ActionModule {}
