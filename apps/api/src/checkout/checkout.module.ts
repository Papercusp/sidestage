import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { ActionModule } from '../actions/action.module';
import { AuctionModule } from '../auction/auction.module';
import { ChatModule } from '../chat/chat.module';
import { EventModule } from '../events/event.module';
import { ShippingModule } from '../shipping/shipping.module';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { rolePrincipal } from '../sync/sync-request-context';
import { BuyerOrdersService } from './buyer-orders.service';
import { CheckoutController } from './checkout.controller';
import { CheckoutSourceService } from './checkout-source.service';
import { CHECKOUT_PAYMENT_PROVIDER, CheckoutService } from './checkout.service';
import { OrderModule } from './order.module';
import { StripePaymentProvider } from './stripe-payment.provider';

@Injectable()
export class BuyerOrdersSyncQueries implements OnModuleInit {
  constructor(
    @Inject(BuyerOrdersService) private readonly buyerOrders: BuyerOrdersService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('orders.byBuyer', (_args, context) => {
      const buyerId = rolePrincipal(context.principal, 'buyer') ?? '';
      return this.buyerOrders.listForBuyer(buyerId);
    });
  }
}

@Module({
  imports: [CartModule, ActionModule, AuctionModule, ChatModule, EventModule, OrderModule, ShippingModule, SyncModule],
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    CheckoutSourceService,
    BuyerOrdersService,
    BuyerOrdersSyncQueries,
    { provide: CHECKOUT_PAYMENT_PROVIDER, useFactory: () => new StripePaymentProvider() },
  ],
})
export class CheckoutModule {}
