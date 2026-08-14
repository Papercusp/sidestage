import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { CopilotProposalService } from './copilot.service';
import type {
  ConfirmCopilotActionInput,
  CreateCopilotTurnInput,
  ReviewCopilotReplyInput,
} from './copilot.runtime.types';

@Controller('copilot')
export class CopilotController {
  constructor(
    @Inject(CopilotProposalService) private readonly copilot: CopilotProposalService,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  @Get('events/:eventId/proposals')
  async list(
    @Param('eventId') eventId: string,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    await this.ownership.requireOwned(eventId, principalHeader);
    return this.copilot.list(eventId);
  }

  @Post('events/:eventId/turns')
  async create(
    @Param('eventId') eventId: string,
    @Body() body: CreateCopilotTurnInput,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    await this.ownership.requireOwned(eventId, principalHeader);
    return this.copilot.createManual(eventId, body ?? { message: '' });
  }

  @Post('proposals/:proposalId/approve')
  async approve(
    @Param('proposalId') proposalId: string,
    @Body() body: ReviewCopilotReplyInput,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    const sellerId = await this.requireOwnedProposal(proposalId, principalHeader);
    return this.copilot.approve(proposalId, { ...(body ?? {}), actorId: sellerId });
  }

  @Post('proposals/:proposalId/skip')
  async skip(
    @Param('proposalId') proposalId: string,
    @Body() body: ReviewCopilotReplyInput,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    const sellerId = await this.requireOwnedProposal(proposalId, principalHeader);
    return this.copilot.skip(proposalId, { ...(body ?? {}), actorId: sellerId });
  }

  @Post('proposals/:proposalId/confirm-action')
  async confirmAction(
    @Param('proposalId') proposalId: string,
    @Body() body: ConfirmCopilotActionInput,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    const sellerId = await this.requireOwnedProposal(proposalId, principalHeader);
    return this.copilot.confirmAction(proposalId, { ...(body ?? {}), actorId: sellerId });
  }

  private async requireOwnedProposal(
    proposalId: string,
    principalHeader: string | undefined,
  ): Promise<string> {
    const sellerId = this.ownership.sellerId(principalHeader);
    const proposal = await this.copilot.find(proposalId);
    await this.ownership.requireOwnedForSeller(proposal?.eventId, sellerId);
    return sellerId;
  }
}
