import { Module } from '@nestjs/common';
import { ActionModule } from './actions/action.module';
import { AuctionModule } from './auction/auction.module';
import { CatalogModule } from './catalog/catalog.module';
import { DatabaseModule } from './db/database.module';
import { CartModule } from './cart/cart.module';
import { ChatModule } from './chat/chat.module';
import { CheckoutModule } from './checkout/checkout.module';
import { EventConfigModule } from './config/event-config.module';
import { HealthController } from './health.controller';
import { InventoryModule } from './inventory/inventory.module';
import { JudgeModule } from './judge/judge.module';
import { PolicyModule } from './policies/policy.module';
import { RehearsalModule } from './rehearsals/rehearsal.module';
import { ScoutModule } from './scout/scout.module';
import { ShippingModule } from './shipping/shipping.module';
import { StatsModule } from './stats/stats.module';

@Module({
  imports: [DatabaseModule, ActionModule, AuctionModule, CartModule, CatalogModule, ChatModule, CheckoutModule, EventConfigModule, InventoryModule, JudgeModule, PolicyModule, RehearsalModule, ScoutModule, ShippingModule, StatsModule],
  controllers: [HealthController],
})
export class AppModule {}
