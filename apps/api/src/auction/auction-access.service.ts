import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseCookies } from '../scout/scout-identity';
import { DEMO_PRINCIPAL_HEADER, rolePrincipal } from '../sync/sync-request-context';

export const AUCTION_GUEST_COOKIE = 'ss_auction_guest';

const DEV_SIGNING_SECRET = 'sidestage-local-auction-signing-secret-change-me';
const GUEST_TTL_SEC = 30 * 24 * 60 * 60;

interface SignedPrincipal {
  v: 1;
  role: 'guest';
  sub: string;
  iat: number;
  exp: number;
}

export interface AuctionGuestPrincipal {
  bidderId: string;
  expiresAt: string;
}

export interface AuctionAuditRecord {
  requestId: string;
  action: 'auction.start' | 'auction.bid' | 'auction.close' | 'auction.cancel';
  outcome: 'accepted' | 'rejected';
  actorKind: 'seller' | 'guest' | 'anonymous';
  actorId: string;
  reasonCode: string;
  eventId?: string;
  auctionId?: string;
  ip?: string;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function errorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (response && typeof response === 'object' && 'code' in response && typeof response.code === 'string') {
      return response.code;
    }
    return `HTTP_${error.getStatus()}`;
  }
  return 'INTERNAL_ERROR';
}

@Injectable()
export class AuctionAuditService {
  private readonly logger = new Logger('AuctionWriteAudit');

  record(record: AuctionAuditRecord): void {
    this.logger.log(JSON.stringify({ event: 'sidestage.auction.write.v1', ...record }));
  }

  reasonCode(error: unknown): string {
    return errorCode(error);
  }
}

@Injectable()
export class AuctionAccessService {
  private readonly signingSecret: string | undefined;
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
  ) {
    const production = env.NODE_ENV === 'production';
    this.signingSecret = env.SIDESTAGE_AUCTION_SIGNING_SECRET?.trim() || (production ? undefined : DEV_SIGNING_SECRET);
  }

  requireSellerPrincipal(principal: unknown): { sellerId: string } {
    const sellerId = rolePrincipal(principal, 'seller');
    if (!sellerId) {
      throw new UnauthorizedException({
        code: 'AUCTION_SELLER_PRINCIPAL_REQUIRED',
        message: `${DEMO_PRINCIPAL_HEADER} is required for seller-owned resources.`,
      });
    }
    return { sellerId };
  }

  /**
   * Mint or restore the anonymous bidder principal for this browser.
   *
   * `rotate` exists for P-007's identity boundary. The guest cookie is HttpOnly
   * by design, so the page CANNOT drop it — and without rotation a demo user
   * who switches identity mid-session keeps bidding as the previous demo
   * buyer's `guest_*` principal, which is what decides "You won" and which
   * buyer's orders get invalidated. Clearing the client's cached promise alone
   * would not have fixed that; the cookie is the credential.
   *
   * This does NOT let the page choose an identity, which is the property the
   * signed cookie exists to protect: a rotating caller can only ask for a NEW
   * server-authored anonymous principal, never for a named one, and the id is
   * still minted here. It is also not an escalation — any client may already
   * drop its own non-HttpOnly state or open a fresh profile to the same effect,
   * and the per-IP `guest-session` rate limit bounds the churn either way.
   */
  issueGuest(
    cookieHeader: string | undefined,
    opts: { rotate?: boolean } = {},
  ): { principal: AuctionGuestPrincipal; setCookie?: string } {
    const existing = opts.rotate ? null : this.readGuest(cookieHeader);
    if (existing) return { principal: existing };

    const issuedAt = Math.floor(this.now() / 1_000);
    const payload: SignedPrincipal = {
      v: 1,
      role: 'guest',
      sub: `guest_${randomUUID()}`,
      iat: issuedAt,
      exp: issuedAt + GUEST_TTL_SEC,
    };
    const token = this.sign(payload);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return {
      principal: { bidderId: payload.sub, expiresAt: new Date(payload.exp * 1_000).toISOString() },
      setCookie: `${AUCTION_GUEST_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GUEST_TTL_SEC}${secure}`,
    };
  }

  requireGuest(cookieHeader: string | undefined): AuctionGuestPrincipal {
    const principal = this.readGuest(cookieHeader);
    if (!principal) {
      throw new UnauthorizedException({
        code: 'AUCTION_GUEST_SESSION_REQUIRED',
        message: 'Start a guest auction session before bidding.',
      });
    }
    return principal;
  }

  requireIdempotencyKey(value: string | undefined): string {
    const key = value?.trim() ?? '';
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new HttpException({
        code: 'AUCTION_IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key must be 8–128 URL-safe characters.',
      }, HttpStatus.BAD_REQUEST);
    }
    return key;
  }

  assertPayloadSize(body: unknown, maxBytes = 4_096): void {
    let bytes = maxBytes + 1;
    try {
      bytes = Buffer.byteLength(JSON.stringify(body ?? null));
    } catch {
      // Non-serializable input is rejected by the same bounded-payload path.
    }
    if (bytes > maxBytes) {
      throw new HttpException({
        code: 'AUCTION_PAYLOAD_TOO_LARGE',
        message: `Auction mutation payload must be ${maxBytes} bytes or fewer.`,
      }, HttpStatus.PAYLOAD_TOO_LARGE);
    }
  }

  consumeRateLimit(bucket: string, key: string, limit: number, windowMs: number): void {
    const now = this.now();
    if (this.counters.size > 5_000) {
      for (const [candidate, counter] of this.counters) {
        if (counter.resetAt <= now) this.counters.delete(candidate);
      }
    }
    const id = `${bucket}:${key}`;
    const current = this.counters.get(id);
    if (!current || current.resetAt <= now) {
      this.counters.set(id, { count: 1, resetAt: now + windowMs });
      return;
    }
    if (current.count >= limit) {
      throw new HttpException({
        code: 'AUCTION_RATE_LIMITED',
        message: 'Too many auction write attempts. Try again shortly.',
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
    current.count += 1;
  }

  private readGuest(cookieHeader: string | undefined): AuctionGuestPrincipal | null {
    const token = parseCookies(cookieHeader)[AUCTION_GUEST_COOKIE];
    if (!token) return null;
    const payload = this.verify(token);
    if (!payload || payload.exp <= Math.floor(this.now() / 1_000)) return null;
    return { bidderId: payload.sub, expiresAt: new Date(payload.exp * 1_000).toISOString() };
  }

  private sign(payload: SignedPrincipal): string {
    const secret = this.requireSigningSecret();
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
    return `v1.${encoded}.${signature}`;
  }

  private verify(token: string): SignedPrincipal | null {
    const secret = this.requireSigningSecret();
    const [version, encoded, signature, extra] = token.split('.');
    if (version !== 'v1' || !encoded || !signature || extra) return null;
    const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
    if (!constantTimeEqual(signature, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SignedPrincipal>;
      if (payload.v !== 1 || payload.role !== 'guest' || typeof payload.sub !== 'string'
        || !/^guest_[0-9a-f-]{36}$/.test(payload.sub) || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
        return null;
      }
      return payload as SignedPrincipal;
    } catch {
      return null;
    }
  }

  private requireSigningSecret(): string {
    if (!this.signingSecret || this.signingSecret.length < 32) {
      throw new ServiceUnavailableException({
        code: 'AUCTION_GUEST_AUTH_NOT_CONFIGURED',
        message: 'Guest auction authentication is not configured.',
      });
    }
    return this.signingSecret;
  }
}

export function auctionHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  return singleHeader(headers[name.toLowerCase()]);
}
