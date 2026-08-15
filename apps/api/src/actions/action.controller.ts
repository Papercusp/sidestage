import { Inject, Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { GuardedActionService } from './action.service';
import type { ApplyActionInput, RegisterActionEventInput } from './action.types';

@Controller('actions')
export class ActionController {
  constructor(
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  @Post('events/:eventId/register')
  async register(
    @Param('eventId') eventId: string,
    @Body() body: RegisterActionEventInput,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    await this.ownership.requireOwned(eventId, principalHeader);
    return { items: await this.actions.registerEvent(eventId, body) };
  }

  @Get('events/:eventId/items')
  async items(
    @Param('eventId') eventId: string,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    await this.ownership.requireOwned(eventId, principalHeader);
    return { items: await this.actions.listItems(eventId) };
  }

  @Get('events/:eventId/audit')
  async audit(
    @Param('eventId') eventId: string,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    await this.ownership.requireOwned(eventId, principalHeader);
    return { audits: this.actions.listAudit(eventId) };
  }

  @Post('events/:eventId/execute')
  async execute(
    @Param('eventId') eventId: string,
    @Body() body: Omit<ApplyActionInput, 'eventId'>,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    const { sellerId } = await this.ownership.requireOwned(eventId, principalHeader);
    return this.actions.apply({
      eventId,
      actorId: sellerId,
      action: body.action,
      clientRequestId: body.clientRequestId,
    });
  }

  @Post('audit/:auditId/rollback')
  async rollback(
    @Param('auditId') auditId: string,
    @Body() body: { actorId?: string; reason?: string },
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    const sellerId = this.ownership.sellerId(principalHeader);
    await this.ownership.requireOwnedForSeller(
      this.actions.findAudit(auditId)?.eventId,
      sellerId,
    );
    return this.actions.rollback(auditId, sellerId, body?.reason);
  }
}
