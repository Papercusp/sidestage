import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../db/database.module';
import { PgJudgeStore } from '../db/pg-judge-store';
import { createVertexAdapter } from '../llm/vertex-adapter';
import { SyncModule } from '../sync/sync.module';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { JudgeController } from './judge.controller';
import { DeterministicReplyJudgeModel, AutoResponderJudgeService } from './judge.service';
import { InMemoryJudgeStore, JUDGE_STORE, type JudgeStore } from './judge.store';
import { VertexReplyJudgeModel } from './judge-vertex.model';
import { JUDGE_MODEL, type ReplyJudgeModel } from './judge.types';

/**
 * Postgres is the authority whenever a pool exists. The in-memory store is a
 * development fallback only — it is process-local, so a deployment that lands
 * on it silently loses the durability this lane exists to provide.
 */
export function judgeStoreForPool(pool: Pool | null): JudgeStore {
  return pool ? new PgJudgeStore(pool) : new InMemoryJudgeStore();
}

@Injectable()
export class JudgeSyncQueries implements OnModuleInit {
  constructor(
    @Inject(AutoResponderJudgeService) private readonly judge: AutoResponderJudgeService,
    @Inject(SyncQueryRegistry) private readonly queries: SyncQueryRegistry,
  ) {}

  onModuleInit(): void {
    // Reads Postgres now, so the answer survives a restart and is identical on
    // every replica — it used to read one process's own last run.
    this.queries.register('judge.latest', async () => {
      const report = await this.judge.latest();
      return report ? [report] : [];
    });
  }
}

@Module({
  imports: [SyncModule, DatabaseModule],
  controllers: [JudgeController],
  providers: [
    AutoResponderJudgeService,
    DeterministicReplyJudgeModel,
    JudgeSyncQueries,
    {
      provide: JUDGE_STORE,
      inject: [PG_POOL],
      useFactory: judgeStoreForPool,
    },
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
