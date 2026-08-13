import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CheckoutController } from './checkout.controller';
import { CHECKOUT_PAYMENT_PROVIDER, CheckoutService, SquareSandboxProvider } from './checkout.service';

@Module({
  imports: [CartModule],
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    { provide: CHECKOUT_PAYMENT_PROVIDER, useFactory: () => new SquareSandboxProvider() },
  ],
})
export class CheckoutModule {}
