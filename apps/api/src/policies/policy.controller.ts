import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SELLER_ID, PolicyService, type RequestContext } from './policy.service';

/**
 * Seller policy routes (docs/config-policies.md §API contract).
 *
 * Success envelope: { data, requestId }. Errors: { error: { code, message,
 * fields? }, requestId } — PolicyError carries the body; the filter in
 * main.ts merges requestId. The seller principal comes from the x-seller-id
 * header in this demo build; a client-supplied id cannot widen access beyond
 * its own scope because every read/write is keyed by that principal.
 */
@Controller('v1/seller/policies')
export class PolicyController {
  constructor(@Inject(PolicyService) private readonly policies: PolicyService) {}

  private ctx(headers: Record<string, string | undefined>): RequestContext & { sellerId: string } {
    const requestId = headers['x-request-id']?.trim() || `req_${randomUUID()}`;
    return {
      sellerId: headers['x-seller-id']?.trim() || DEFAULT_SELLER_ID,
      requestId,
      correlationId: headers['x-correlation-id']?.trim() || requestId,
      actorType: 'seller',
      actorId: headers['x-seller-id']?.trim() || DEFAULT_SELLER_ID,
    };
  }

  @Get('effective')
  async effective(@Query('eventId') eventId: string | undefined, @Headers() headers: Record<string, string>) {
    const ctx = this.ctx(headers);
    const data = await this.policies.effective(ctx.sellerId, eventId ?? null);
    return { data, requestId: ctx.requestId };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Headers() headers: Record<string, string>) {
    const ctx = this.ctx(headers);
    const data = await this.policies.getRevision(ctx.sellerId, id);
    return { data, requestId: ctx.requestId };
  }

  @Post()
  async create(
    @Body() body: { eventId?: string | null; policy: unknown },
    @Headers() headers: Record<string, string>,
  ) {
    const ctx = this.ctx(headers);
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
    const ifMatch = headers['if-match'];
    const expected = body?.expectedRevision ?? (ifMatch !== undefined ? Number(ifMatch) : undefined);
    const data = await this.policies.updateDraft(ctx.sellerId, id, { body: body?.policy }, expected, ctx);
    return { data, requestId: ctx.requestId };
  }

  @Post(':id/validate')
  async validate(@Param('id') id: string, @Headers() headers: Record<string, string>) {
    const ctx = this.ctx(headers);
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
    const ifMatch = headers['if-match'];
    const expected = body?.expectedRevision ?? (ifMatch !== undefined ? Number(ifMatch) : undefined);
    const data = await this.policies.publish(ctx.sellerId, id, expected, ctx, headers['idempotency-key']);
    return { data, requestId: ctx.requestId };
  }

  @Get(':id/audit')
  async audit(@Param('id') id: string, @Headers() headers: Record<string, string>) {
    const ctx = this.ctx(headers);
    const data = await this.policies.audit(ctx.sellerId, id);
    return { data, requestId: ctx.requestId };
  }
}
