import { createEventRoom } from './streaming';

export type BuyerProduct = {
  id: string;
  /** Present only for products projected from a published event lineup. */
  eventId?: string;
  eventItemId?: string;
  title: string;
  subtitle: string;
  priceCents: number;
  compareAtPriceCents?: number;
  availableQty: number;
  imageUrl?: string;
  badge?: string;
};

export type BuyerChatMessage = {
  id: string;
  author: string;
  body: string;
  timestamp: string;
  accent?: 'cyan' | 'violet' | 'amber';
};

export type BuyerStats = {
  viewers: number;
  itemsSold: number;
  totalRaisedCents: number;
};


export function formatBuyerPrice(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function buildBuyerShareUrl(
  eventId: string,
  origin = getBrowserOrigin(),
): string {
  return createEventRoom(eventId, origin).shareUrl;
}

export function availableBuyerProducts(products: readonly BuyerProduct[]): BuyerProduct[] {
  return products.filter((product) => product.availableQty > 0);
}

function getBrowserOrigin(): string {
  return typeof globalThis.location?.origin === 'string'
    ? globalThis.location.origin
    : 'http://localhost:5173/';
}
