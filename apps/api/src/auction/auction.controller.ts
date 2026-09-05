import { Inject, Body, Controller, Get, Headers, Ip, Param, Post, Query, Res, Sse, type MessageEvent } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { from, interval, merge, type Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { AuctionAccessService, AuctionAuditService, auctionHeader, type AuctionAuditRecord } from './auction-access.service';
import { AuctionService, type AuctionSseEvent, type PlaceBidInput, type StartAuctionInput } from './auction.service';

type HeadersMap = Record<string, string | string[] | undefined>;
type PassthroughResponse = { setHeader(name: string, value: string): void };
type JsonResponse = { json(body: unknown): void };
type AuditContext = Omit<AuctionAuditRecord, 'outcome' | 'reasonCode'>;

@Controller('auctions')
export class AuctionController {
  constructor(
    @Inject(AuctionService) private readonly auctions: AuctionService,
    @Inject(AuctionAccessService) private readonly access: AuctionAccessService,
    @Inject(AuctionAuditService) private readonly audit: AuctionAuditService,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  @Post('access/guest')
  guestAccess(
    @Headers() headers: HeadersMap,
    @Ip() ip: string,
    @Res({ passthrough: true }) response: PassthroughResponse,
    // P-007: `?rotate=1` asks for a FRESH anonymous principal instead of
    // restoring the cookie's. The demo identity boundary needs it because the
    // guest cookie is HttpOnly and the page cannot drop it, so without this a
    // demo user who switches identity keeps bidding as the previous buyer.
    // Still rate-limited on the same bucket, and still server-authored — the
    // caller can ask for a new id, never for a particular one.
    @Query('rotate') rotate?: string,
  ) {
    this.access.consumeRateLimit('guest-session', ip || 'unknown', 30, 60 * 60_000);
    const issued = this.access.issueGuest(auctionHeader(headers, 'cookie'), {
      rotate: rotate === '1' || rotate === 'true',
    });
    if (issued.setCookie) response.setHeader('Set-Cookie', issued.setCookie);
    return issued.principal;
  }

  @Post('start')
  async start(@Body() body: StartAuctionInput, @Headers() headers: HeadersMap, @Ip() ip: string) {
    const ctx = this.context('auction.start', headers, ip, { eventId: body?.eventId });
    try {
      const seller = this.access.requireSellerPrincipal(auctionHeader(headers, DEMO_PRINCIPAL_HEADER));
      ctx.actorKind = 'seller';
      ctx.actorId = seller.sellerId;
      await this.ownership.requireOwnedForSeller(body?.eventId, seller.sellerId);
      this.access.consumeRateLimit('seller-start', seller.sellerId, 10, 60_000);
      this.access.assertPayloadSize(body);
      const auction = await this.auctions.startAuction(body);
      ctx.auctionId = auction.id;
      this.audit.record({ ...ctx, outcome: 'accepted', reasonCode: 'AUCTION_STARTED' });
      return auction;
    } catch (error) {
      this.audit.record({ ...ctx, outcome: 'rejected', reasonCode: this.audit.reasonCode(error) });
      throw error;
    }
  }

  @Get('events/:eventId/active')
  async active(@Param('eventId') eventId: string, @Res() response: JsonResponse) {
    // Nest's Express adapter treats a returned null as an absent response body.
    // Write through the response explicitly so the public API always returns
    // valid JSON and clients can safely call response.json() when no auction
    // has started yet.
    response.json(await this.auctions.getCurrentAuction(eventId));
  }

  @Sse('events/:eventId/stream')
  stream(@Param('eventId') eventId: string): Observable<MessageEvent> {
    const initial = from(this.auctions.snapshotEvent(eventId)).pipe(
      map((event): MessageEvent => event as AuctionSseEvent as MessageEvent),
    );
    const updates = this.auctions.updates(eventId).pipe(
      map((event): MessageEvent => event as AuctionSseEvent as MessageEvent),
    );
    const heartbeat = interval(15_000).pipe(
      map((): MessageEvent => {
        const now = Date.now();
        return {
          id: `auction-heartbeat-${now}`,
          type: 'heartbeat',
          data: JSON.stringify({ tsMs: now }),
        };
      }),
    );
    return merge(initial, updates, heartbeat);
  }

  @Get('inventory/:productId')
  inventory(@Param('productId') productId: string) {
    return this.auctions.inventorySnapshot(productId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.auctions.getAuction(id);
  }

  @Post(':id/bids')
  async bid(
    @Param('id') id: string,
    @Body() body: Omit<PlaceBidInput, 'bidderId' | 'idempotencyKey'> & { bidderId?: unknown },
    @Headers() headers: HeadersMap,
    @Ip() ip: string,
  ) {
    const ctx = this.context('auction.bid', headers, ip, { auctionId: id });
    try {
      const guest = this.access.requireGuest(auctionHeader(headers, 'cookie'));
      ctx.actorKind = 'guest';
      ctx.actorId = guest.bidderId;
      this.access.consumeRateLimit('guest-bid', guest.bidderId, 20, 60_000);
      this.access.consumeRateLimit('ip-bid', ip || 'unknown', 80, 60_000);
      this.access.assertPayloadSize(body, 2_048);
      const idempotencyKey = this.access.requireIdempotencyKey(auctionHeader(headers, 'idempotency-key'));
      const auction = await this.auctions.placeBid(id, {
        bidderId: guest.bidderId,
        displayName: body?.displayName,
        amountCents: body?.amountCents,
        idempotencyKey,
      });
      this.audit.record({ ...ctx, outcome: 'accepted', reasonCode: 'BID_ACCEPTED' });
      return { ...auction, viewerBidderId: guest.bidderId };
    } catch (error) {
      this.audit.record({ ...ctx, outcome: 'rejected', reasonCode: this.audit.reasonCode(error) });
      throw error;
    }
  }

  @Post(':id/close')
  async close(@Param('id') id: string, @Headers() headers: HeadersMap, @Ip() ip: string) {
    const ctx = this.context('auction.close', headers, ip, { auctionId: id });
    try {
      const seller = this.access.requireSellerPrincipal(auctionHeader(headers, DEMO_PRINCIPAL_HEADER));
      ctx.actorKind = 'seller';
      ctx.actorId = seller.sellerId;
      this.access.consumeRateLimit('seller-close', seller.sellerId, 20, 60_000);
      const existing = await this.auctions.getAuction(id);
      await this.ownership.requireOwnedForSeller(existing?.eventId, seller.sellerId);
      const auction = await this.auctions.closeAuction(id);
      ctx.eventId = auction.eventId;
      this.audit.record({ ...ctx, outcome: 'accepted', reasonCode: 'AUCTION_CLOSED' });
      return auction;
    } catch (error) {
      this.audit.record({ ...ctx, outcome: 'rejected', reasonCode: this.audit.reasonCode(error) });
      throw error;
    }
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Headers() headers: HeadersMap, @Ip() ip: string) {
    const ctx = this.context('auction.cancel', headers, ip, { auctionId: id });
    try {
      const seller = this.access.requireSellerPrincipal(auctionHeader(headers, DEMO_PRINCIPAL_HEADER));
      ctx.actorKind = 'seller';
      ctx.actorId = seller.sellerId;
      this.access.consumeRateLimit('seller-cancel', seller.sellerId, 20, 60_000);
      const existing = await this.auctions.getAuction(id);
      await this.ownership.requireOwnedForSeller(existing?.eventId, seller.sellerId);
      const auction = await this.auctions.cancelAuction(id);
      ctx.eventId = auction.eventId;
      this.audit.record({ ...ctx, outcome: 'accepted', reasonCode: 'AUCTION_CANCELLED' });
      return auction;
    } catch (error) {
      this.audit.record({ ...ctx, outcome: 'rejected', reasonCode: this.audit.reasonCode(error) });
      throw error;
    }
  }

  private context(
    action: AuditContext['action'],
    headers: HeadersMap,
    ip: string,
    scope: Pick<AuditContext, 'eventId' | 'auctionId'> = {},
  ): AuditContext {
    return {
      requestId: auctionHeader(headers, 'x-request-id')?.trim() || `req_${randomUUID()}`,
      action,
      actorKind: 'anonymous',
      actorId: 'anonymous',
      ip: ip || undefined,
      ...scope,
    };
  }
}
