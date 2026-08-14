export type AuctionStatus = 'active' | 'closed';

export interface BuyerAuctionBid {
  id: string;
  bidderId: string;
  displayName?: string;
  amountCents: number;
  createdAt: string;
}

export interface BuyerAuction {
  id: string;
  eventId: string;
  eventItemId: string;
  productId: string;
  quantity: number;
  startingPriceCents: number;
  currentPriceCents: number;
  status: AuctionStatus;
  startedAt: string;
  endsAt: string;
  closedAt?: string;
  bids: BuyerAuctionBid[];
  winnerOrder?: {
    bidderId: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    status: 'pending';
  };
  /** Server-derived identity for the viewer making this request. */
  viewerBidderId?: string;
}

export interface AuctionGuestSession {
  bidderId: string;
  expiresAt: string;
}

export interface AuctionEventPayload {
  name: 'event.auction.active';
  args: { eventId: string };
  auction: BuyerAuction | null;
  tsMs: number;
}

const DEFAULT_API_ORIGIN = 'http://localhost:3100';

export function resolveAuctionApiOrigin(apiBaseUrl?: string): string {
  return (apiBaseUrl ?? import.meta.env.VITE_API_URL ?? DEFAULT_API_ORIGIN).replace(/\/+$/, '');
}

export function activeAuctionUrl(eventId: string, apiBaseUrl?: string): string {
  return `${resolveAuctionApiOrigin(apiBaseUrl)}/auctions/events/${encodeURIComponent(eventId)}/active`;
}

export function auctionStreamUrl(eventId: string, apiBaseUrl?: string): string {
  return `${resolveAuctionApiOrigin(apiBaseUrl)}/auctions/events/${encodeURIComponent(eventId)}/stream`;
}

export function auctionBidUrl(auctionId: string, apiBaseUrl?: string): string {
  return `${resolveAuctionApiOrigin(apiBaseUrl)}/auctions/${encodeURIComponent(auctionId)}/bids`;
}

export function auctionGuestAccessUrl(apiBaseUrl?: string): string {
  return `${resolveAuctionApiOrigin(apiBaseUrl)}/auctions/access/guest`;
}

export function parseBidDollars(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amountCents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(amountCents) && amountCents > 0 ? amountCents : null;
}

export function suggestedBidCents(currentPriceCents: number): number {
  const fivePercentInWholeDollars = Math.ceil((currentPriceCents * 0.05) / 100) * 100;
  return currentPriceCents + Math.max(100, fivePercentInWholeDollars);
}

export function secondsRemaining(endsAt: string, nowMs = Date.now()): number {
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.ceil((endMs - nowMs) / 1_000));
}

export function parseAuctionEvent(data: string): BuyerAuction | null | undefined {
  try {
    const payload = JSON.parse(data) as Partial<AuctionEventPayload>;
    if (payload.name !== 'event.auction.active' || !('auction' in payload)) return undefined;
    return payload.auction ?? null;
  } catch {
    return undefined;
  }
}

export class AuctionRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AuctionRequestError';
  }
}

function responseErrorMessage(raw: string, status: number): string {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
    } catch {
      return raw;
    }
  }
  return `Auction request failed (${status})`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      // Keep the status when an intermediary closes before sending a body.
    }
    throw new AuctionRequestError(response.status, responseErrorMessage(detail, response.status));
  }
  return response.json() as Promise<T>;
}

let guestSessionCache: { origin: string; promise: Promise<AuctionGuestSession> } | null = null;

function clearGuestSession(apiBaseUrl?: string): void {
  const origin = resolveAuctionApiOrigin(apiBaseUrl);
  if (guestSessionCache?.origin === origin) guestSessionCache = null;
}

/**
 * Establishes anonymous continuity without accepting identity from the page.
 * The API authors a signed HttpOnly cookie; JavaScript receives only the
 * public bidder id needed to render "You won" correctly.
 */
export function getAuctionGuestSession(apiBaseUrl?: string): Promise<AuctionGuestSession> {
  const origin = resolveAuctionApiOrigin(apiBaseUrl);
  if (guestSessionCache?.origin !== origin) {
    const promise = requestJson<AuctionGuestSession>(auctionGuestAccessUrl(apiBaseUrl), {
      method: 'POST',
      credentials: 'include',
    }).catch((error) => {
      clearGuestSession(apiBaseUrl);
      throw error;
    });
    guestSessionCache = { origin, promise };
  }
  return guestSessionCache.promise;
}

export function fetchActiveAuction(eventId: string, apiBaseUrl?: string): Promise<BuyerAuction | null> {
  return requestJson<BuyerAuction | null>(activeAuctionUrl(eventId, apiBaseUrl));
}

export async function placeAuctionBid(
  auctionId: string,
  input: { bidderId?: string; displayName?: string; amountCents: number; idempotencyKey: string },
  apiBaseUrl?: string,
): Promise<BuyerAuction> {
  const submit = () => requestJson<BuyerAuction>(auctionBidUrl(auctionId, apiBaseUrl), {
      method: 'POST',
      credentials: 'include',
      headers: { 'idempotency-key': input.idempotencyKey },
      // bidderId is intentionally omitted: the server derives it from the
      // signed guest cookie and cannot be widened by a forged request body.
      body: JSON.stringify({ displayName: input.displayName, amountCents: input.amountCents }),
    });

  await getAuctionGuestSession(apiBaseUrl);
  try {
    return await submit();
  } catch (error) {
    // A long-lived tab can retain a resolved session promise after its signed
    // cookie expires. Mint a fresh server-authored guest principal once and
    // replay the SAME idempotency key; the write is safe whether the first
    // response was a genuine 401 or was lost after the server accepted it.
    if (!(error instanceof AuctionRequestError) || error.status !== 401) throw error;
    clearGuestSession(apiBaseUrl);
    await getAuctionGuestSession(apiBaseUrl);
    return submit();
  }
}

export function auctionBidErrorMessage(error: unknown): string {
  if (!(error instanceof AuctionRequestError)) {
    return error instanceof Error ? error.message : 'Your bid could not be placed.';
  }
  if (error.status === 409) {
    return /closed/i.test(error.message)
      ? 'Bidding has closed. Confirming the result from the server.'
      : 'Another buyer moved the auction. The current price is refreshing—review your bid and try again.';
  }
  if (error.status === 429) return 'Bidding is moving quickly. Wait a moment, then try again.';
  if (error.status === 401 || error.status === 403) {
    return 'Your buyer session could not be restored. Refresh the page before bidding again.';
  }
  return error.message;
}
