import { Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { CartModule } from '../cart/cart.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CATALOG_SOURCE, type CatalogSource } from '../catalog/catalog.types';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgScoutSessionStore } from '../db/pg-scout-session-store';
import { scoutCatalogFrom } from './scout-catalog.adapter';
import { InMemoryScoutSessionStore } from './scout-session.store';
import { ScoutTurnBusService } from './scout-turn-bus.service';
import { DeterministicScoutReplyModel, ScoutService } from './scout.service';
import { SCOUT_CATALOG, SCOUT_REPLY_MODEL, SCOUT_SESSION_STORE } from './scout.types';
import { ScoutController } from './scout.controller';

@Module({
  imports: [CartModule, CatalogModule, DatabaseModule],
  controllers: [ScoutController],
  providers: [
    ScoutService,
    ScoutTurnBusService,
    DeterministicScoutReplyModel,
    {
      provide: SCOUT_CATALOG,
      inject: [CATALOG_SOURCE],
      useFactory: (source: CatalogSource) => scoutCatalogFrom(source),
    },
    { provide: SCOUT_REPLY_MODEL, useExisting: DeterministicScoutReplyModel },
    {
      // Same seam as every other SideStage store: durable when the pool is
      // reachable, in-memory otherwise, so a clone without Postgres still boots
      // (transcripts simply do not survive a restart).
      provide: SCOUT_SESSION_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) =>
        pool ? new PgScoutSessionStore(pool) : new InMemoryScoutSessionStore(),
    },
  ],
})
export class ScoutModule {}
