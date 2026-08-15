import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgOrderStore } from '../db/pg-order-store';
import { InMemoryOrderStore, ORDER_STORE } from './order-store';

@Module({
  imports: [DatabaseModule],
  providers: [{
    provide: ORDER_STORE,
    inject: [PG_POOL],
    useFactory: (pool: Pool | null) => (pool ? new PgOrderStore(pool) : new InMemoryOrderStore()),
  }],
  exports: [ORDER_STORE],
})
export class OrderModule {}
