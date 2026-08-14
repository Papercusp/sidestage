import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { CartModule } from '../cart/cart.module';
import { ActionModule } from '../actions/action.module';
import { AuctionModule } from '../auction/auction.module';
import { ChatModule } from '../chat/chat.module';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { EventModule } from '../events/event.module';
import { PgOrderStore } from '../db/pg-order-store';
import { ShippingModule } from '../shipping/shipping.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { BuyerOrdersService } from './buyer-orders.service';
import { CheckoutController } from './checkout.controller';
import {
  CHECKOUT_PAYMENT_PROVIDER,
  CheckoutService,
  InMemoryOrderStore,
  ORDER_STORE,
  SquareSandboxProvider,
} from './checkout.service';

@Injectable()
export class BuyerOrdersSyncQueries implements OnModuleInit {
  constructor(
    @Inject(BuyerOrdersService) private readonly buyerOrders: BuyerOrdersService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('orders.byBuyer', (args) => {
      const buyerId = typeof args.buyerId === 'string' ? args.buyerId : '';
      return this.buyerOrders.listForBuyer(buyerId);
    });
  }
}

@Module({
  imports: [DatabaseModule, CartModule, ActionModule, AuctionModule, ChatModule, EventModule, ShippingModule, SyncModule],
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    BuyerOrdersService,
    BuyerOrdersSyncQueries,
    { provide: CHECKOUT_PAYMENT_PROVIDER, useFactory: () => new SquareSandboxProvider() },
    {
      provide: ORDER_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => (pool ? new PgOrderStore(pool) : new InMemoryOrderStore()),
    },
  ],
})
export class CheckoutModule {}
