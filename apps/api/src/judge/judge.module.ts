import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { createVertexAdapter } from '../llm/vertex-adapter';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { JudgeController } from './judge.controller';
import { DeterministicReplyJudgeModel, AutoResponderJudgeService } from './judge.service';
import { VertexReplyJudgeModel } from './judge-vertex.model';
import { JUDGE_MODEL, type ReplyJudgeModel } from './judge.types';

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
    {
      provide: JUDGE_MODEL,
      inject: [DeterministicReplyJudgeModel],
      useFactory: (deterministic: DeterministicReplyJudgeModel): ReplyJudgeModel => {
        // Gemini grades when Google credentials are present; the deterministic
        // judge remains the fallback inside the Vertex model and the whole
        // model when credentials are absent. Lazy construction only — an
        // adapter built at import time without credentials breaks boot.
        const adapter = createVertexAdapter(process.env.SIDESTAGE_JUDGE_VERTEX_MODEL);
        return adapter ? new VertexReplyJudgeModel(adapter, deterministic) : deterministic;
      },
    },
  ],
  exports: [AutoResponderJudgeService],
})
export class JudgeModule {}
