import { Logger, Module } from '@nestjs/common';
import { VertexGeminiAdapter } from '@papercusp/scout-runtime/vertex';
import type { Pool } from 'pg';
import { CartModule } from '../cart/cart.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CATALOG_SOURCE, type CatalogSource } from '../catalog/catalog.types';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgScoutMemoryStore } from '../db/pg-scout-memory-store';
import { PgScoutSessionStore } from '../db/pg-scout-session-store';
import { scoutCatalogFrom } from './scout-catalog.adapter';
import { CookieScoutIdentityResolver } from './scout-identity';
import { InMemoryScoutMemoryStore } from './scout-memory';
import { InMemoryScoutSessionStore } from './scout-session.store';
import { ScoutTurnBusService } from './scout-turn-bus.service';
import { DeterministicScoutReplyModel, ScoutService } from './scout.service';
import {
  SCOUT_CATALOG,
  SCOUT_IDENTITY_RESOLVER,
  SCOUT_MEMORY_STORE,
  SCOUT_REPLY_MODEL,
  SCOUT_RUNTIME_MODEL,
  SCOUT_SESSION_STORE,
} from './scout.types';
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
      provide: SCOUT_RUNTIME_MODEL,
      useFactory: () => new VertexGeminiAdapter({
        model: process.env.SCOUT_VERTEX_MODEL?.trim()
          || 'gemini-3.1-pro-preview-customtools',
        project: process.env.GOOGLE_CLOUD_PROJECT?.trim() || undefined,
        location: process.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
      }),
    },
    {
      // Same seam as every other SideStage store: durable when the pool is
      // reachable, in-memory otherwise, so a clone without Postgres still boots
      // (transcripts simply do not survive a restart).
      provide: SCOUT_SESSION_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) =>
        pool ? new PgScoutSessionStore(pool) : new InMemoryScoutSessionStore(),
    },
    {
      // Long-term memory, same seam again (D-008). Postgres full-text when the
      // pool is reachable, in-memory otherwise — the Restart CONTRACT on the
      // retrieval machinery this schema already has, since this database has no
      // `vector` extension and no embedding provider to build one from.
      provide: SCOUT_MEMORY_STORE,
      inject: [PG_POOL],
      useFactory: (pool: Pool | null) => {
        if (!pool) return new InMemoryScoutMemoryStore();
        const log = new Logger('ScoutMemory');
        return new PgScoutMemoryStore(pool, (message) => log.warn(message));
      },
    },
    {
      // The D-009 trust boundary. Swapping THIS provider for one that reads a
      // verified session is the entire future auth change; until then the
      // resolved id is guest continuity, explicitly not authentication.
      provide: SCOUT_IDENTITY_RESOLVER,
      useClass: CookieScoutIdentityResolver,
    },
  ],
})
export class ScoutModule {}
