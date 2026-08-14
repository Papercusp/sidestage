import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { JudgeController } from './judge.controller';
import { DeterministicReplyJudgeModel, AutoResponderJudgeService } from './judge.service';
import { JUDGE_MODEL } from './judge.types';

@Injectable()
export class JudgeSyncQueries implements OnModuleInit {
  constructor(
    @Inject(AutoResponderJudgeService) private readonly judge: AutoResponderJudgeService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    this.queries.register('judge.latest', () => {
      const report = this.judge.latest();
      return report ? [report] : [];
    });
  }
}

@Module({
  imports: [SyncModule],
  controllers: [JudgeController],
  providers: [
    AutoResponderJudgeService,
    DeterministicReplyJudgeModel,
    JudgeSyncQueries,
    { provide: JUDGE_MODEL, useExisting: DeterministicReplyJudgeModel },
  ],
  exports: [AutoResponderJudgeService],
})
export class JudgeModule {}
