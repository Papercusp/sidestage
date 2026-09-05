import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { PG_POOL } from '../db/database.module';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { AuctionAccessService, type AuctionAuditRecord } from './auction-access.service';
import { AuctionController } from './auction.controller';
import { AuctionModule } from './auction.module';

const SIGNING_SECRET = 'auction-signing-secret-with-at-least-thirty-two-bytes';

function accessAt(now: () => number = Date.now): AuctionAccessService {
  return new AuctionAccessService({
    NODE_ENV: 'test',
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
  it('boots through AuctionModule without treating its test seams as injectable dependencies', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuctionModule] })
      .overrideProvider(PG_POOL)
      .useValue(null)
      .compile();

    expect(moduleRef.select(AuctionModule).get(AuctionAccessService, { strict: true }))
      .toBeInstanceOf(AuctionAccessService);
    await moduleRef.close();
  });

  it('derives seller auction authority directly from the selected demo principal in production', () => {
    const access = new AuctionAccessService({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);

    expect(access.requireSellerPrincipal('buyer-alpha')).toEqual({ sellerId: 'seller-alpha' });
    expect(access.requireSellerPrincipal('seller-alpha')).toEqual({ sellerId: 'seller-alpha' });
    expect(statusOf(() => access.requireSellerPrincipal(undefined))).toBe(401);
    expect((access as unknown as Record<string, unknown>).requireSeller).toBeUndefined();
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

  it('rotates to a NEW guest principal on request, which is what re-keys a demo-identity switch', () => {
    // P-007. The guest cookie is HttpOnly, so the page cannot drop it: without
    // this branch a demo user who switches identity keeps the previous demo
    // buyer's `guest_*` id, and that id is what decides "You won" and which
    // buyer's orders are invalidated. The client-side cache clear alone is
    // provably insufficient — the assertion on line 2 below is exactly the
    // behaviour that makes it insufficient.
    const access = accessAt(() => Date.parse('2026-08-14T20:00:00.000Z'));
    const first = access.issueGuest(undefined);
    const cookie = first.setCookie?.split(';', 1)[0];

    // Without rotation the SAME principal comes back and no cookie is reissued.
    expect(access.issueGuest(cookie)).toEqual({ principal: first.principal });

    const rotated = access.issueGuest(cookie, { rotate: true });
    expect(rotated.principal.bidderId).toMatch(/^guest_[0-9a-f-]{36}$/);
    expect(rotated.principal.bidderId).not.toBe(first.principal.bidderId);
    // A rotation must REPLACE the credential, not merely return a different id:
    // with no Set-Cookie the browser would keep presenting the old one.
    expect(rotated.setCookie).toContain('HttpOnly');

    const rotatedCookie = rotated.setCookie?.split(';', 1)[0];
    expect(access.requireGuest(rotatedCookie)).toEqual(rotated.principal);
    // The page still cannot NAME an identity — rotation only asks for a fresh
    // server-authored one, so the signed-cookie authority is unchanged.
    expect(rotated.principal.bidderId).not.toBe('guest_forged');
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
    const controller = new AuctionController(
      auctions as never,
      access as never,
      audit as never,
      { requireOwnedForSeller: vi.fn() } as never,
    );

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

  it('requires the selected demo principal before starting an auction and audits rejection', async () => {
    const unauthorized = new HttpException({ code: 'AUCTION_SELLER_PRINCIPAL_REQUIRED' }, 401);
    const auctions = { startAuction: vi.fn() };
    const access = {
      requireSellerPrincipal: vi.fn(() => { throw unauthorized; }),
      consumeRateLimit: vi.fn(),
      assertPayloadSize: vi.fn(),
    };
    const records: AuctionAuditRecord[] = [];
    const audit = {
      record: (record: AuctionAuditRecord) => records.push(record),
      reasonCode: vi.fn().mockReturnValue('AUCTION_SELLER_PRINCIPAL_REQUIRED'),
    };
    const controller = new AuctionController(
      auctions as never,
      access as never,
      audit as never,
      { requireOwnedForSeller: vi.fn() } as never,
    );
    const input = {
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 1_000,
    };

    await expect(controller.start(input, {}, '127.0.0.1')).rejects.toBe(unauthorized);
    expect(auctions.startAuction).not.toHaveBeenCalled();
    expect(records).toContainEqual(expect.objectContaining({
      action: 'auction.start',
      outcome: 'rejected',
      actorKind: 'anonymous',
      reasonCode: 'AUCTION_SELLER_PRINCIPAL_REQUIRED',
    }));
  });

  it('starts an owned auction from the demo principal without reading a bearer credential', async () => {
    const input = {
      eventId: 'event-1',
      eventItemId: 'item-1',
      productId: 'product-1',
      quantity: 1,
      startingPriceCents: 1_000,
    };
    const auction = { id: 'auction-1', ...input };
    const auctions = { startAuction: vi.fn().mockResolvedValue(auction) };
    const access = {
      requireSellerPrincipal: vi.fn().mockReturnValue({ sellerId: 'seller-alpha' }),
      consumeRateLimit: vi.fn(),
      assertPayloadSize: vi.fn(),
    };
    const ownership = { requireOwnedForSeller: vi.fn().mockResolvedValue(undefined) };
    const audit = { record: vi.fn(), reasonCode: vi.fn() };
    const controller = new AuctionController(
      auctions as never,
      access as never,
      audit as never,
      ownership as never,
    );

    await expect(controller.start(input, {
      [DEMO_PRINCIPAL_HEADER]: 'buyer-alpha',
      authorization: 'Bearer ignored',
    }, '127.0.0.1')).resolves.toBe(auction);

    expect(access.requireSellerPrincipal).toHaveBeenCalledWith('buyer-alpha');
    expect(ownership.requireOwnedForSeller).toHaveBeenCalledWith('event-1', 'seller-alpha');
    expect(access.consumeRateLimit).toHaveBeenCalledWith('seller-start', 'seller-alpha', 10, 60_000);
  });
});
