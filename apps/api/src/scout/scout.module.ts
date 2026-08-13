import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { DeterministicScoutReplyModel, InMemoryScoutCatalog, ScoutService } from './scout.service';
import { SCOUT_CATALOG, SCOUT_REPLY_MODEL } from './scout.types';
import { ScoutController } from './scout.controller';

@Module({
  imports: [CartModule],
  controllers: [ScoutController],
  providers: [
    ScoutService,
    InMemoryScoutCatalog,
    DeterministicScoutReplyModel,
    { provide: SCOUT_CATALOG, useExisting: InMemoryScoutCatalog },
    { provide: SCOUT_REPLY_MODEL, useExisting: DeterministicScoutReplyModel },
  ],
})
export class ScoutModule {}
