import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { CartModule } from '../cart/cart.module';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgOrderStore } from '../db/pg-order-store';
import { CheckoutController } from './checkout.controller';
import {
  CHECKOUT_PAYMENT_PROVIDER,
  CheckoutService,
  InMemoryOrderStore,
  ORDER_STORE,
  SquareSandboxProvider,
} from './checkout.service';

@Module({
  imports: [DatabaseModule, CartModule],
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    { provide: CHECKOUT_PAYMENT_PROVIDER, useFactory: () => new SquareSandboxProvider() },
    {
      provide: ORDER_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgOrderStore(pool) : new InMemoryOrderStore()),
    },
  ],
})
export class CheckoutModule {}
