import { Module } from '@nestjs/common';
import { ActionModule } from './actions/action.module';
import { AuctionModule } from './auction/auction.module';
import { CartModule } from './cart/cart.module';
import { ChatModule } from './chat/chat.module';
import { CheckoutModule } from './checkout/checkout.module';
import { HealthController } from './health.controller';
import { JudgeModule } from './judge/judge.module';
import { ScoutModule } from './scout/scout.module';
import { ShippingModule } from './shipping/shipping.module';

@Module({
  imports: [ActionModule, AuctionModule, CartModule, ChatModule, CheckoutModule, JudgeModule, ScoutModule, ShippingModule],
  controllers: [HealthController],
})
export class AppModule {}
