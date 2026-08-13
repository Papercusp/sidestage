import { Inject, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { GuardedActionService } from './action.service';
import type { ApplyActionInput, RegisterActionEventInput } from './action.types';

@Controller('actions')
export class ActionController {
  constructor(@Inject(GuardedActionService) private readonly actions: GuardedActionService) {}

  @Post('events/:eventId/register')
  register(@Param('eventId') eventId: string, @Body() body: RegisterActionEventInput) {
    return { items: this.actions.registerEvent(eventId, body) };
  }

  @Get('events/:eventId/items')
  items(@Param('eventId') eventId: string) {
    return { items: this.actions.listItems(eventId) };
  }

  @Get('events/:eventId/audit')
  audit(@Param('eventId') eventId: string) {
    return { audits: this.actions.listAudit(eventId) };
  }

  @Post('events/:eventId/execute')
  execute(@Param('eventId') eventId: string, @Body() body: Omit<ApplyActionInput, 'eventId'>) {
    return this.actions.apply({ eventId, actorId: body.actorId, action: body.action });
  }

  @Post('audit/:auditId/rollback')
  rollback(@Param('auditId') auditId: string, @Body() body: { actorId: string; reason?: string }) {
    return this.actions.rollback(auditId, body.actorId, body.reason);
  }
}
