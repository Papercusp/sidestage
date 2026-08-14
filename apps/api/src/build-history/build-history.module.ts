import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { BuildHistoryService } from './build-history.service';

@Injectable()
export class BuildHistorySyncQueries implements OnModuleInit {
  constructor(
    @Inject(BuildHistoryService) private readonly history: BuildHistoryService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('build.history', () => this.history.list());
  }
}

@Module({ imports: [SyncModule], providers: [BuildHistoryService, BuildHistorySyncQueries] })
export class BuildHistoryModule {}
