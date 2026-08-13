import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CATALOG_SOURCE, type CatalogSource } from '../catalog/catalog.types';
import { scoutCatalogFrom } from './scout-catalog.adapter';
import { DeterministicScoutReplyModel, ScoutService } from './scout.service';
import { SCOUT_CATALOG, SCOUT_REPLY_MODEL } from './scout.types';
import { ScoutController } from './scout.controller';

@Module({
  imports: [CartModule, CatalogModule],
  controllers: [ScoutController],
  providers: [
    ScoutService,
    DeterministicScoutReplyModel,
    {
      provide: SCOUT_CATALOG,
      inject: [CATALOG_SOURCE],
      useFactory: (source: CatalogSource) => scoutCatalogFrom(source),
    },
    { provide: SCOUT_REPLY_MODEL, useExisting: DeterministicScoutReplyModel },
  ],
})
export class ScoutModule {}
