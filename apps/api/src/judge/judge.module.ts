import { Module } from '@nestjs/common';
import { JudgeController } from './judge.controller';
import { DeterministicReplyJudgeModel, AutoResponderJudgeService } from './judge.service';
import { JUDGE_MODEL } from './judge.types';

@Module({
  controllers: [JudgeController],
  providers: [
    AutoResponderJudgeService,
    DeterministicReplyJudgeModel,
    { provide: JUDGE_MODEL, useExisting: DeterministicReplyJudgeModel },
  ],
  exports: [AutoResponderJudgeService],
})
export class JudgeModule {}
