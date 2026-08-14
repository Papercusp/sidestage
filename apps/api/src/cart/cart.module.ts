import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PgCartStore } from '../db/pg-cart-store';
import { CartController } from './cart.controller';
import { CART_STORE, CartService, InMemoryCartStore } from './cart.service';

@Module({
  imports: [DatabaseModule, InventoryModule],
  controllers: [CartController],
  providers: [
    CartService,
    {
      provide: CART_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgCartStore(pool) : new InMemoryCartStore()),
    },
  ],
  exports: [CartService],
})
export class CartModule {}
