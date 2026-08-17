import { Global, Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncInvalidationService } from './sync-invalidation.service';
import { SyncQueryRegistry } from './sync-query.registry';
import { ZeroController } from './zero.controller';

@Global()
@Module({
  // SyncController serves the SSE-era transport (/sync/*); ZeroController serves
  // the WS-era one (/zero/query, /zero/mutate). Both are registered because the
  // client steps DOWN the ladder WEBSOCKETS→SSE→polling at runtime, so the SSE
  // routes must keep answering after the Zero routes exist (plan D-006).
  controllers: [SyncController, ZeroController],
  providers: [SyncInvalidationService, SyncQueryRegistry],
  exports: [SyncInvalidationService, SyncQueryRegistry],
})
export class SyncModule {}
