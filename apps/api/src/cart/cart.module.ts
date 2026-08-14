import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PgCartStore } from '../db/pg-cart-store';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { CartController } from './cart.controller';
import { CART_STORE, CartService, InMemoryCartStore } from './cart.service';

@Injectable()
export class CartSyncQueries implements OnModuleInit {
  constructor(
    @Inject(CartService) private readonly carts: CartService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('cart.byId', async (args) => {
      const cartId = typeof args.cartId === 'string' ? args.cartId.trim() : '';
      if (!cartId) return [];
      const cart = await this.carts.findCart(cartId);
      return cart ? [cart] : [];
    });
  }
}

@Module({
  imports: [DatabaseModule, InventoryModule, SyncModule],
  controllers: [CartController],
  providers: [
    CartService,
    CartSyncQueries,
    {
      provide: CART_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgCartStore(pool) : new InMemoryCartStore()),
    },
  ],
  exports: [CartService],
})
export class CartModule {}
