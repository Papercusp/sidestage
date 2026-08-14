import { Body, Controller, Delete, Get, Headers, Inject, Ip, Logger, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuctionAccessService, auctionHeader } from '../auction/auction-access.service';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { ChatService, type ChatMessageInput, type PresenceInput, type TranscriptMomentInput } from './chat.service';
import { ConfiguredProductFocusClassifier } from './product-focus.classifier';

type HeadersMap = Record<string, string | string[] | undefined>;

@Controller()
export class ChatController {
  private readonly logger = new Logger('ChatBoundary');

  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ConfiguredProductFocusClassifier) private readonly productFocus: ConfiguredProductFocusClassifier,
    @Inject(AuctionAccessService) private readonly access: AuctionAccessService,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  @Get('chat/events/:eventId/messages')
  async messages(@Param('eventId') eventId: string, @Query('limit') rawLimit?: string, @Query('cursor') cursor?: string) {
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    return this.chat.getMessagesPage(eventId, limit, cursor);
  }

  @Post('chat/events/:eventId/messages')
  async sendMessage(@Param('eventId') eventId: string, @Body() body: ChatMessageInput, @Headers() headers: HeadersMap, @Ip() ip: string) {
    const requestId = auctionHeader(headers, 'x-request-id')?.trim() || `req_${randomUUID()}`;
    try {
      this.access.assertPayloadSize(body, 2_048);
      const authorization = auctionHeader(headers, 'authorization');
      const seller = authorization ? this.access.requireSeller(
        authorization,
        auctionHeader(headers, DEMO_PRINCIPAL_HEADER),
      ) : null;
      if (seller) await this.ownership.requireOwnedForSeller(eventId, seller.sellerId);
      const input: ChatMessageInput = seller
        ? { ...body, userId: seller.sellerId, displayName: body?.displayName ?? 'Host', role: 'seller' }
        : { ...body, role: 'buyer' };
      const actorId = seller?.sellerId ?? (typeof input.userId === 'string' ? input.userId : 'anonymous');
      this.access.consumeRateLimit(seller ? 'seller-chat-send' : 'buyer-chat-send', (seller?.sellerId ?? ip) || actorId, seller ? 120 : 30, 60_000);
      const headerKey = auctionHeader(headers, 'idempotency-key')?.trim();
      const message = await this.chat.addMessage(eventId, { ...input, ...(headerKey ? { clientRequestId: headerKey } : {}) });
      this.audit(requestId, 'message.send', 'accepted', actorId, eventId, message.id);
      return message;
    } catch (error) {
      this.chat.recordRejectedWrite(); this.audit(requestId, 'message.send', 'rejected', 'unknown', eventId, undefined, error); throw error;
    }
  }

  @Post('chat/events/:eventId/transcript')
  async addTranscriptMoment(@Param('eventId') eventId: string, @Body() body: TranscriptMomentInput, @Headers() headers: HeadersMap, @Ip() ip: string) {
    const seller = await this.requireSeller(headers, ip, 'seller-chat-transcript', 240, eventId);
    try { return await this.chat.addTranscriptMoment(eventId, body ?? {}); }
    catch (error) { this.chat.recordRejectedWrite(); this.audit('unknown', 'transcript.add', 'rejected', seller.sellerId, eventId, undefined, error); throw error; }
  }

  @Post('chat/events/:eventId/transcript/product-focus')
  async classifyTranscriptProductFocus(@Param('eventId') eventId: string, @Body() body: unknown, @Headers() headers: HeadersMap, @Ip() ip: string) {
    await this.requireSeller(headers, ip, 'seller-chat-classify', 120, eventId);
    return this.productFocus.classify(body);
  }

  @Post('chat/events/:eventId/presence')
  async joinPresence(@Param('eventId') eventId: string, @Body() body: PresenceInput, @Headers() headers: HeadersMap, @Ip() ip: string) {
    this.access.assertPayloadSize(body, 1_024);
    const authorization = auctionHeader(headers, 'authorization');
    const seller = authorization ? this.access.requireSeller(
      authorization,
      auctionHeader(headers, DEMO_PRINCIPAL_HEADER),
    ) : null;
    if (seller) await this.ownership.requireOwnedForSeller(eventId, seller.sellerId);
    const input: PresenceInput = seller
      ? { ...body, userId: seller.sellerId, displayName: body?.displayName ?? 'Host', role: 'seller' }
      : { ...body, role: 'buyer' };
    const actorId = seller?.sellerId ?? (typeof input.userId === 'string' ? input.userId : 'anonymous');
    this.access.consumeRateLimit('chat-presence', ip || actorId, 180, 60_000);
    return this.chat.touchPresence(eventId, input);
  }

  @Delete('chat/events/:eventId/presence/:userId')
  async leavePresence(@Param('eventId') eventId: string, @Param('userId') userId: string) {
    await this.chat.removePresence(eventId, userId);
    return { ok: true as const };
  }

  @Delete('chat/events/:eventId/messages/:messageId')
  async moderateMessage(@Param('eventId') eventId: string, @Param('messageId') messageId: string, @Body() body: { reason?: unknown }, @Headers() headers: HeadersMap, @Ip() ip: string) {
    const seller = await this.requireSeller(headers, ip, 'seller-chat-moderate', 60, eventId);
    const changed = await this.chat.moderateMessage(eventId, messageId, seller.sellerId, body?.reason);
    if (!changed) throw new NotFoundException('Message was not found');
    this.audit('unknown', 'message.moderate', 'accepted', seller.sellerId, eventId, messageId);
    return { ok: true as const };
  }

  @Get('chat/metrics')
  async metrics(@Headers() headers: HeadersMap, @Ip() ip: string) {
    await this.requireSeller(headers, ip, 'seller-chat-metrics', 60);
    return this.chat.getOperationalMetrics();
  }

  @Get('chat/events/:eventId/presence')
  getPresence(@Param('eventId') eventId: string) { return this.chat.getPresence(eventId); }

  private async requireSeller(
    headers: HeadersMap,
    ip: string,
    bucket: string,
    limit: number,
    eventId?: string,
  ) {
    const seller = this.access.requireSeller(
      auctionHeader(headers, 'authorization'),
      auctionHeader(headers, DEMO_PRINCIPAL_HEADER),
    );
    if (eventId) await this.ownership.requireOwnedForSeller(eventId, seller.sellerId);
    this.access.consumeRateLimit(bucket, `${seller.sellerId}:${ip || 'unknown'}`, limit, 60_000);
    return seller;
  }

  private audit(requestId: string, action: string, outcome: 'accepted' | 'rejected', actorId: string, eventId: string, messageId?: string, error?: unknown): void {
    this.logger.log(JSON.stringify({ event: 'sidestage.chat.write.v1', requestId, action, outcome, actorId, eventId, messageId, reasonCode: error instanceof Error ? error.name : outcome === 'accepted' ? 'ACCEPTED' : 'REJECTED' }));
  }
}
