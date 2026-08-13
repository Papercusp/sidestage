import { Body, Controller, Post } from '@nestjs/common';
import { AutoResponderJudgeService } from './judge.service';
import type { JudgeReport, JudgeRunRequest } from './judge.types';

@Controller('judge')
export class JudgeController {
  constructor(private readonly judge: AutoResponderJudgeService) {}

  @Post('run')
  run(@Body() body: JudgeRunRequest): Promise<JudgeReport> {
    return this.judge.run(body);
  }
}
