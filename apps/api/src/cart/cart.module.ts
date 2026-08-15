import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { ActionModule } from '../actions/action.module';
import { ACTION_ITEM_STORE, type ActionItemStore } from '../actions/action-item.store';
import { AUCTION_INVENTORY, type AuctionInventory } from '../auction/auction.service';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PgCartStore } from '../db/pg-cart-store';
import { EventModule } from '../events/event.module';
import { EVENT_STORE, type EventStore } from '../events/event.service';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { rolePrincipal } from '../sync/sync-request-context';
import { CartController } from './cart.controller';
import { CART_STORE, CartService, InMemoryCartStore } from './cart.service';

@Injectable()
export class CartSyncQueries implements OnModuleInit {
  constructor(
    @Inject(CartService) private readonly carts: CartService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('cart.byId', async (args, context) => {
      const cartId = typeof args.cartId === 'string' ? args.cartId.trim() : '';
      if (!cartId) return [];
      const buyerId = rolePrincipal(context.principal, 'buyer');
      if (!buyerId) throw new Error('x-demo-principal is required for cart.byId');
      const cart = await this.carts.findCartForBuyer(cartId, buyerId);
      return cart ? [cart] : [];
    });
  }
}

@Module({
  imports: [ActionModule, DatabaseModule, EventModule, InventoryModule, SyncModule],
  controllers: [CartController],
  providers: [
    CartService,
    CartSyncQueries,
    {
      provide: CART_STORE,
      inject: [PG_POOL, ACTION_ITEM_STORE, EVENT_STORE, AUCTION_INVENTORY],
      useFactory: (
        pool: Pool | null,
        eventItems: ActionItemStore,
        events: EventStore,
        inventory: AuctionInventory,
      ) => (pool ? new PgCartStore(pool) : new InMemoryCartStore(eventItems, events, inventory)),
    },
  ],
  exports: [CartService],
})
export class CartModule {}
