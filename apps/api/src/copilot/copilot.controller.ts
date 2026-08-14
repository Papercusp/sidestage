import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { CopilotProposalService } from './copilot.service';
import type {
  ConfirmCopilotActionInput,
  CreateCopilotTurnInput,
  ReviewCopilotReplyInput,
} from './copilot.runtime.types';

@Controller('copilot')
export class CopilotController {
  constructor(@Inject(CopilotProposalService) private readonly copilot: CopilotProposalService) {}

  @Get('events/:eventId/proposals')
  list(@Param('eventId') eventId: string) {
    return this.copilot.list(eventId);
  }

  @Post('events/:eventId/turns')
  create(@Param('eventId') eventId: string, @Body() body: CreateCopilotTurnInput) {
    return this.copilot.createManual(eventId, body ?? { message: '' });
  }

  @Post('proposals/:proposalId/approve')
  approve(@Param('proposalId') proposalId: string, @Body() body: ReviewCopilotReplyInput) {
    return this.copilot.approve(proposalId, body ?? {});
  }

  @Post('proposals/:proposalId/skip')
  skip(@Param('proposalId') proposalId: string, @Body() body: ReviewCopilotReplyInput) {
    return this.copilot.skip(proposalId, body ?? {});
  }

  @Post('proposals/:proposalId/confirm-action')
  confirmAction(@Param('proposalId') proposalId: string, @Body() body: ConfirmCopilotActionInput) {
    return this.copilot.confirmAction(proposalId, body ?? {});
  }
}
