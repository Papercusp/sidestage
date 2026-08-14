import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventService } from '../events/event.service';
import {
  DEMO_PRINCIPAL_HEADER,
  rolePrincipal,
} from '../sync/sync-request-context';
import { PolicyService, type RequestContext } from './policy.service';

/**
 * Seller policy routes (docs/config-policies.md §API contract).
 *
 * Success envelope: { data, requestId }. Errors: { error: { code, message,
 * fields? }, requestId } — PolicyError carries the body; the filter in
 * main.ts merges requestId. The seller authority is derived from the one
 * canonical x-demo-principal header; x-seller-id and body ids are never an
 * authorization source.
 */
@Controller('v1/seller/policies')
export class PolicyController {
  constructor(
    @Inject(PolicyService) private readonly policies: PolicyService,
    @Inject(EventService) private readonly events: EventService,
  ) {}

  private ctx(headers: Record<string, string | undefined>): RequestContext & { sellerId: string } {
    const requestId = headers['x-request-id']?.trim() || `req_${randomUUID()}`;
    const sellerId = rolePrincipal(headers[DEMO_PRINCIPAL_HEADER], 'seller');
    if (!sellerId) {
      throw new UnauthorizedException(`${DEMO_PRINCIPAL_HEADER} is required for seller-owned resources.`);
    }
    return {
      sellerId,
      requestId,
      correlationId: headers['x-correlation-id']?.trim() || requestId,
      actorType: 'seller',
      actorId: sellerId,
    };
  }

  private async requireOwnedEvent(sellerId: string, eventId: string | null | undefined): Promise<void> {
    if (!eventId) return;
    if (!await this.events.findOwned(eventId, sellerId)) {
      throw new NotFoundException('Event not found for this seller.');
    }
  }

  private async requireRevisionEvent(sellerId: string, id: string): Promise<void> {
    const revision = await this.policies.getRevision(sellerId, id);
    await this.requireOwnedEvent(sellerId, revision.eventId);
  }

  @Get('effective')
  async effective(@Query('eventId') eventId: string | undefined, @Headers() headers: Record<string, string>) {
    const ctx = this.ctx(headers);
    await this.requireOwnedEvent(ctx.sellerId, eventId);
    const data = await this.policies.effective(ctx.sellerId, eventId ?? null);
    return { data, requestId: ctx.requestId };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Headers() headers: Record<string, string>) {
    const ctx = this.ctx(headers);
    await this.requireRevisionEvent(ctx.sellerId, id);
    const data = await this.policies.getRevision(ctx.sellerId, id);
    return { data, requestId: ctx.requestId };
  }

  @Post()
  async create(
    @Body() body: { eventId?: string | null; policy: unknown },
    @Headers() headers: Record<string, string>,
  ) {
    const ctx = this.ctx(headers);
    await this.requireOwnedEvent(ctx.sellerId, body?.eventId);
    const data = await this.policies.createDraft(
      ctx.sellerId,
      { eventId: body?.eventId ?? null, body: body?.policy },
      ctx,
      headers['idempotency-key'],
    );
    return { data, requestId: ctx.requestId };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { policy: unknown; expectedRevision?: number },
    @Headers() headers: Record<string, string>,
  ) {
    const ctx = this.ctx(headers);
    await this.requireRevisionEvent(ctx.sellerId, id);
    const ifMatch = headers['if-match'];
    const expected = body?.expectedRevision ?? (ifMatch !== undefined ? Number(ifMatch) : undefined);
    const data = await this.policies.updateDraft(ctx.sellerId, id, { body: body?.policy }, expected, ctx);
    return { data, requestId: ctx.requestId };
  }

  @Post(':id/validate')
  async validate(@Param('id') id: string, @Headers() headers: Record<string, string>) {
    const ctx = this.ctx(headers);
    await this.requireRevisionEvent(ctx.sellerId, id);
    const data = await this.policies.validate(ctx.sellerId, id, ctx);
    return { data, requestId: ctx.requestId };
  }

  @Post(':id/publish')
  async publish(
    @Param('id') id: string,
    @Body() body: { expectedRevision?: number },
    @Headers() headers: Record<string, string>,
  ) {
    const ctx = this.ctx(headers);
    await this.requireRevisionEvent(ctx.sellerId, id);
    const ifMatch = headers['if-match'];
    const expected = body?.expectedRevision ?? (ifMatch !== undefined ? Number(ifMatch) : undefined);
    const data = await this.policies.publish(ctx.sellerId, id, expected, ctx, headers['idempotency-key']);
    return { data, requestId: ctx.requestId };
  }

  @Get(':id/audit')
  async audit(@Param('id') id: string, @Headers() headers: Record<string, string>) {
    const ctx = this.ctx(headers);
    await this.requireRevisionEvent(ctx.sellerId, id);
    const data = await this.policies.audit(ctx.sellerId, id);
    return { data, requestId: ctx.requestId };
  }
}
