import { Inject, Body, Controller, Post } from '@nestjs/common';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { AutoResponderJudgeService } from './judge.service';
import type { JudgeReport, JudgeRunRequest } from './judge.types';

@Controller('judge')
export class JudgeController {
  constructor(
    @Inject(AutoResponderJudgeService) private readonly judge: AutoResponderJudgeService,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
  ) {}

  @Post('run')
  async run(@Body() body: JudgeRunRequest): Promise<JudgeReport> {
    const report = await this.judge.run(body);
    this.invalidations.invalidate('judge.latest');
    return report;
  }
}
