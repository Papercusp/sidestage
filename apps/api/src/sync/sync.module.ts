import { Global, Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncInvalidationService } from './sync-invalidation.service';
import { SyncQueryRegistry } from './sync-query.registry';
import { ZeroController } from './zero.controller';

@Global()
@Module({
  // ⚠ Do NOT add `imports: [DatabaseModule]` here to satisfy ZeroController's
  // PG_POOL injection. It looks correct (@Global only makes a provider ambient
  // once its module is already in the graph — it does not pull the module in),
  // but it introduces a temporal-dead-zone circular import: DatabaseModule's
  // subgraph reaches event.module.ts, which reads SyncInvalidationService from
  // THIS still-evaluating module, so 18 test files die with
  // "ReferenceError: SyncInvalidationService is not defined" and
  // app.module.test.ts's circular-import guard fails. Measured 2026-08-17.
  // AppModule already imports DatabaseModule, so the real app resolves PG_POOL;
  // a test that bootstraps SyncModule alone must supply PG_POOL itself (see
  // sync.controller.spec.ts / zero.controller.spec.ts).
  // SyncController serves the SSE-era transport (/sync/*); ZeroController serves
  // the WS-era one (/zero/query, /zero/mutate). Both are registered because the
  // client steps DOWN the ladder WEBSOCKETS→SSE→polling at runtime, so the SSE
  // routes must keep answering after the Zero routes exist (plan D-006).
  controllers: [SyncController, ZeroController],
  providers: [SyncInvalidationService, SyncQueryRegistry],
  exports: [SyncInvalidationService, SyncQueryRegistry],
})
export class SyncModule {}
