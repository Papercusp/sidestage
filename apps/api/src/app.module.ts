import { Module } from '@nestjs/common';
import { ActionModule } from './actions/action.module';
import { AuctionModule } from './auction/auction.module';
import { BuildHistoryModule } from './build-history/build-history.module';
import { CatalogModule } from './catalog/catalog.module';
import { DatabaseModule } from './db/database.module';
import { CartModule } from './cart/cart.module';
import { ChatModule } from './chat/chat.module';
import { CheckoutModule } from './checkout/checkout.module';
import { CopilotModule } from './copilot/copilot.module';
import { EventConfigModule } from './config/event-config.module';
import { EventModule } from './events/event.module';
import { HealthController } from './health.controller';
import { InventoryModule } from './inventory/inventory.module';
import { JudgeModule } from './judge/judge.module';
import { PolicyModule } from './policies/policy.module';
import { RehearsalModule } from './rehearsals/rehearsal.module';
import { RunOfShowModule } from './run-of-show/run-of-show.module';
import { ScoutModule } from './scout/scout.module';
import { ShippingModule } from './shipping/shipping.module';
import { StatsModule } from './stats/stats.module';
import { SyncModule } from './sync/sync.module';
import { TranscriptionModule } from './transcription/transcription.module';

@Module({
  imports: [DatabaseModule, SyncModule, ActionModule, AuctionModule, BuildHistoryModule, CartModule, CatalogModule, ChatModule, CheckoutModule, CopilotModule, EventConfigModule, EventModule, InventoryModule, JudgeModule, PolicyModule, RehearsalModule, RunOfShowModule, ScoutModule, ShippingModule, StatsModule, TranscriptionModule],
  controllers: [HealthController],
})
export class AppModule {}
