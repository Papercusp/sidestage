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
    throw new Error(`Auction request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return response.json() as Promise<T>;
}

export function fetchActiveAuction(eventId: string, apiBaseUrl?: string): Promise<BuyerAuction | null> {
  return requestJson<BuyerAuction | null>(activeAuctionUrl(eventId, apiBaseUrl));
}

export function placeAuctionBid(
  auctionId: string,
  input: { bidderId: string; displayName?: string; amountCents: number },
  apiBaseUrl?: string,
): Promise<BuyerAuction> {
  return requestJson<BuyerAuction>(auctionBidUrl(auctionId, apiBaseUrl), {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
