import { Inject, Body, Controller, Post } from '@nestjs/common';
import { ScoutService } from './scout.service';
import type { ScoutChatRequest } from './scout.types';

@Controller('scout')
export class ScoutController {
  constructor(@Inject(ScoutService) private readonly scout: ScoutService) {}

  @Post('chat')
  chat(@Body() body: ScoutChatRequest) {
    return this.scout.chat(body);
  }
}
