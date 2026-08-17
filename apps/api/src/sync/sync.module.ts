import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { SyncController } from './sync.controller';
import { SyncInvalidationService } from './sync-invalidation.service';
import { SyncQueryRegistry } from './sync-query.registry';
import { ZeroController } from './zero.controller';

@Global()
@Module({
  // DatabaseModule is imported EXPLICITLY even though it is @Global, because
  // @Global only makes a provider ambient once the module is already in the
  // graph — it does not pull the module in. AppModule happens to import both,
  // so the real app resolves PG_POOL either way; but bootstrapping SyncModule
  // ALONE (as sync.controller.spec.ts does) leaves ZeroController's PG_POOL
  // injection unresolvable, and Nest's bootstrap rejection then kills the
  // whole vitest worker rather than failing one test. Importing it here makes
  // this module self-sufficient. Nest dedupes the module, so this is free.
  imports: [DatabaseModule],
  // SyncController serves the SSE-era transport (/sync/*); ZeroController serves
  // the WS-era one (/zero/query, /zero/mutate). Both are registered because the
  // client steps DOWN the ladder WEBSOCKETS→SSE→polling at runtime, so the SSE
  // routes must keep answering after the Zero routes exist (plan D-006).
  controllers: [SyncController, ZeroController],
  providers: [SyncInvalidationService, SyncQueryRegistry],
  exports: [SyncInvalidationService, SyncQueryRegistry],
})
export class SyncModule {}
