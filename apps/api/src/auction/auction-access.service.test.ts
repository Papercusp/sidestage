import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuctionAccessService, type AuctionAuditRecord } from './auction-access.service';
import { AuctionController } from './auction.controller';

const SELLER_TOKEN = 'seller-token-with-enough-entropy-for-tests';
const SIGNING_SECRET = 'auction-signing-secret-with-at-least-thirty-two-bytes';

function accessAt(now: () => number = Date.now): AuctionAccessService {
  return new AuctionAccessService({
    NODE_ENV: 'test',
    SIDESTAGE_AUCTION_SELLER_TOKEN: SELLER_TOKEN,
    SIDESTAGE_AUCTION_SIGNING_SECRET: SIGNING_SECRET,
  } as NodeJS.ProcessEnv, now);
}

function statusOf(run: () => unknown): number {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('Expected an HttpException');
}

describe('AuctionAccessService', () => {
  it('fails closed in production and accepts only the configured seller bearer', () => {
    const production = new AuctionAccessService({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(statusOf(() => production.requireSeller(`Bearer ${SELLER_TOKEN}`))).toBe(503);

    const access = accessAt();
    expect(access.requireSeller(`Bearer ${SELLER_TOKEN}`)).toEqual({ sellerId: 'sidestage-seller' });
    expect(statusOf(() => access.requireSeller('Bearer forged-token'))).toBe(401);
    expect(statusOf(() => access.requireSeller(undefined))).toBe(401);
  });

  it('mints, verifies, reuses, expires, and rejects tampered HttpOnly guest identity', () => {
    let nowMs = Date.parse('2026-08-14T20:00:00.000Z');
    const access = accessAt(() => nowMs);
    const issued = access.issueGuest(undefined);
    const cookie = issued.setCookie?.split(';', 1)[0];

    expect(issued.principal.bidderId).toMatch(/^guest_[0-9a-f-]{36}$/);
    expect(issued.setCookie).toContain('HttpOnly');
    expect(issued.setCookie).toContain('SameSite=Lax');
    expect(cookie).toBeTruthy();
    expect(access.requireGuest(cookie)).toEqual(issued.principal);
    expect(access.issueGuest(cookie)).toEqual({ principal: issued.principal });
    expect(statusOf(() => access.requireGuest(`${cookie}tampered`))).toBe(401);

    nowMs += 31 * 24 * 60 * 60 * 1_000;
    expect(statusOf(() => access.requireGuest(cookie))).toBe(401);
  });

  it('bounds idempotency keys, payloads, and per-bucket write rates', () => {
    const access = accessAt(() => 1_000);
    expect(access.requireIdempotencyKey('bid:req-1234')).toBe('bid:req-1234');
    expect(statusOf(() => access.requireIdempotencyKey('short'))).toBe(400);
    expect(statusOf(() => access.assertPayloadSize({ value: 'x'.repeat(80) }, 32))).toBe(413);

    access.consumeRateLimit('guest-bid', 'guest-1', 2, 60_000);
    access.consumeRateLimit('guest-bid', 'guest-1', 2, 60_000);
    expect(statusOf(() => access.consumeRateLimit('guest-bid', 'guest-1', 2, 60_000))).toBe(429);
  });
});

describe('AuctionController write boundary', () => {
  it('ignores a forged bidderId and submits the verified guest plus idempotency key', async () => {
    const auctions = {
      placeBid: vi.fn().mockResolvedValue({ id: 'auction-1', eventId: 'event-1', bids: [] }),
    };
    const access = {
      requireGuest: vi.fn().mockReturnValue({ bidderId: 'guest_verified', expiresAt: '2099-01-01T00:00:00.000Z' }),
      requireIdempotencyKey: vi.fn().mockReturnValue('bid:req-1234'),
      consumeRateLimit: vi.fn(),
      assertPayloadSize: vi.fn(),
    };
    const records: AuctionAuditRecord[] = [];
    const audit = {
      record: (record: AuctionAuditRecord) => records.push(record),
      reasonCode: vi.fn().mockReturnValue('UNEXPECTED'),
    };
    const controller = new AuctionController(auctions as never, access as never, audit as never);

    await expect(controller.bid(
      'auction-1',
      { bidderId: 'guest_forged', displayName: 'Ava', amountCents: 2_500 },
      { cookie: 'ss_auction_guest=signed', 'idempotency-key': 'bid:req-1234', 'x-request-id': 'request-1' },
      '127.0.0.1',
    )).resolves.toMatchObject({ id: 'auction-1', viewerBidderId: 'guest_verified' });

    expect(auctions.placeBid).toHaveBeenCalledWith('auction-1', {
      bidderId: 'guest_verified',
      displayName: 'Ava',
      amountCents: 2_500,
      idempotencyKey: 'bid:req-1234',
    });
    expect(records).toContainEqual(expect.objectContaining({
      requestId: 'request-1',
      action: 'auction.bid',
      outcome: 'accepted',
      actorKind: 'guest',
      actorId: 'guest_verified',
      reasonCode: 'BID_ACCEPTED',
    }));
  });

  it('checks seller authorization before starting an auction and audits rejection', async () => {
    const unauthorized = new HttpException({ code: 'AUCTION_SELLER_AUTH_REQUIRED' }, 401);
    const auctions = { startAuction: vi.fn() };
    const access = {
      requireSeller: vi.fn(() => { throw unauthorized; }),
      consumeRateLimit: vi.fn(),
      assertPayloadSize: vi.fn(),
    };
    const records: AuctionAuditRecord[] = [];
    const audit = {
      record: (record: AuctionAuditRecord) => records.push(record),
      reasonCode: vi.fn().mockReturnValue('AUCTION_SELLER_AUTH_REQUIRED'),
    };
    const controller = new AuctionController(auctions as never, access as never, audit as never);
    const input = {
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 1_000,
    };

    await expect(controller.start(input, { authorization: 'Bearer forged' }, '127.0.0.1')).rejects.toBe(unauthorized);
    expect(auctions.startAuction).not.toHaveBeenCalled();
    expect(records).toContainEqual(expect.objectContaining({
      action: 'auction.start',
      outcome: 'rejected',
      actorKind: 'anonymous',
      reasonCode: 'AUCTION_SELLER_AUTH_REQUIRED',
    }));
  });
});
