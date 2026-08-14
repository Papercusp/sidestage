import { Global, Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncInvalidationService } from './sync-invalidation.service';
import { SyncQueryRegistry } from './sync-query.registry';

@Global()
@Module({
  controllers: [SyncController],
  providers: [SyncInvalidationService, SyncQueryRegistry],
  exports: [SyncInvalidationService, SyncQueryRegistry],
})
export class SyncModule {}
