import type { BuyerProduct } from './buyer';
import { resolveApiBaseUrl } from './catalog';
import { DEMO_PRINCIPAL_HEADER } from '@papercusp/sync';

export interface BuyerCartItem {
  productId: string;
  eventId?: string;
  eventItemId?: string;
  title: string;
  priceCents: number;
  quantity: number;
  imageUrl?: string;
  expiresAt?: string;
}

export interface BuyerCart {
  id: string;
  currency: 'USD';
  items: BuyerCartItem[];
  subtotalCents: number;
  updatedAt: string;
}

export interface BuyerShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
}

export interface BuyerShippingRate {
  id: string;
  carrier: string;
  service: string;
  totalCents: number;
  deliveryDays: number | null;
  parcelCount: number;
  quotedAt: string;
}

export interface BuyerPaymentSession {
  provider: 'stripe';
  mode: 'test' | 'live' | null;
  status: 'ready' | 'needs-configuration';
  publishableKey: string | null;
  clientSecret: string | null;
  paymentIntentId: string | null;
  orderId: string;
  amountCents: number;
  currency: 'USD';
}

export interface BuyerCheckoutOrder {
  id: string;
  cartId?: string;
  buyerId: string;
  sourceKind: 'cart' | 'auction' | 'offer';
  sourceId: string;
  eventId: string;
  email?: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: 'USD';
  status: 'pending' | 'paid' | 'failed';
  paymentState: 'payment_required' | 'payment_processing' | 'paid' | 'payment_failed' | 'cancelled' | 'expired';
  paymentError?: string;
  stripePaymentIntentId?: string;
  createdAt: string;
  items: BuyerCartItem[];
  shippingAddress?: BuyerShippingAddress;
  selectedShippingRate?: BuyerShippingRate;
}

export interface BuyerCheckoutSessionResponse {
  order: BuyerCheckoutOrder;
  session: BuyerPaymentSession;
}

export interface BuyerCheckoutSessionInput {
  orderId?: string;
  cartId?: string;
  eventId?: string;
  email: string;
  name?: string;
  shippingAddress: BuyerShippingAddress;
  shippingRateId: string;
}

export type CartIdStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): CartIdStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function buyerCartStorageKey(buyerId: string): string {
  return `sidestage.buyer-cart.v1:${encodeURIComponent(buyerId.trim())}`;
}

export function readBuyerCartId(buyerId: string, storage = browserStorage()): string | undefined {
  const value = storage?.getItem(buyerCartStorageKey(buyerId))?.trim();
  return value || undefined;
}

export function persistBuyerCartId(buyerId: string, cartId: string, storage = browserStorage()): void {
  const value = cartId.trim();
  if (!storage || !value) return;
  storage.setItem(buyerCartStorageKey(buyerId), value);
}

interface ApiErrorPayload {
  message?: string | string[];
  error?: string;
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  apiBaseUrl?: string,
  principal?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (principal?.trim()) headers.set(DEMO_PRINCIPAL_HEADER, principal.trim());
  const response = await fetch(`${resolveApiBaseUrl(apiBaseUrl)}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({})) as T & ApiErrorPayload;
  if (!response.ok) {
    const message = Array.isArray(payload.message) ? payload.message.join(', ') : payload.message;
    throw new Error(message ?? payload.error ?? `Request failed: HTTP ${response.status}`);
  }
  return payload;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function addHeldProductToCart(
  buyerId: string,
  product: BuyerProduct,
  apiBaseUrl?: string,
  storage = browserStorage(),
): Promise<BuyerCart> {
  const eventScoped = Boolean(product.eventId || product.eventItemId);
  let cartId = readBuyerCartId(buyerId, storage);
  if (eventScoped && !cartId) {
    // Event holds require a stable aggregate identity before the first request
    // so a lost response can be retried against the same locked cart row.
    cartId = globalThis.crypto.randomUUID();
    persistBuyerCartId(buyerId, cartId, storage);
  }
  const cart = await requestJson<BuyerCart>('/cart/items', jsonPost({
    cartId,
    productId: product.id,
    title: product.title,
    priceCents: product.priceCents,
    quantity: 1,
    imageUrl: product.imageUrl,
    ...(eventScoped ? {
      eventId: product.eventId,
      eventItemId: product.eventItemId,
      idempotencyKey: `cart-hold:${globalThis.crypto.randomUUID()}`,
    } : {}),
  }), apiBaseUrl);
  persistBuyerCartId(buyerId, cart.id, storage);
  return cart;
}

export function fetchBuyerCart(cartId: string, apiBaseUrl?: string): Promise<BuyerCart> {
  return requestJson<BuyerCart>(`/cart/${encodeURIComponent(cartId)}`, {}, apiBaseUrl);
}

export function setBuyerCartQuantity(
  cartId: string,
  productId: string,
  quantity: number,
  apiBaseUrl?: string,
): Promise<BuyerCart> {
  return requestJson<BuyerCart>(
    `/cart/${encodeURIComponent(cartId)}/items/${encodeURIComponent(productId)}`,
    { ...jsonPost({ quantity }), method: 'PATCH' },
    apiBaseUrl,
  );
}

export function removeBuyerCartItem(cartId: string, productId: string, apiBaseUrl?: string): Promise<BuyerCart> {
  return requestJson<BuyerCart>(
    `/cart/${encodeURIComponent(cartId)}/items/${encodeURIComponent(productId)}`,
    { method: 'DELETE' },
    apiBaseUrl,
  );
}

export function fetchBuyerShippingRates(
  cartId: string,
  address: BuyerShippingAddress,
  buyerId: string,
  apiBaseUrl?: string,
): Promise<BuyerShippingRate[]> {
  return requestJson<BuyerShippingRate[]>('/shipping/rates', jsonPost({ cartId, address }), apiBaseUrl, buyerId);
}

export function fetchBuyerOrder(
  orderId: string,
  buyerId: string,
  apiBaseUrl?: string,
): Promise<BuyerCheckoutOrder> {
  return requestJson<BuyerCheckoutOrder>(
    `/checkout/orders/${encodeURIComponent(orderId)}`,
    {},
    apiBaseUrl,
    buyerId,
  );
}

export function fetchBuyerOrderShippingRates(
  orderId: string,
  address: BuyerShippingAddress,
  buyerId: string,
  apiBaseUrl?: string,
): Promise<BuyerShippingRate[]> {
  return requestJson<BuyerShippingRate[]>(
    `/checkout/orders/${encodeURIComponent(orderId)}/shipping-rates`,
    jsonPost({ address }),
    apiBaseUrl,
    buyerId,
  );
}

export function createBuyerCheckoutSession(
  input: BuyerCheckoutSessionInput,
  buyerId: string,
  apiBaseUrl?: string,
): Promise<BuyerCheckoutSessionResponse> {
  return requestJson<BuyerCheckoutSessionResponse>('/checkout/sessions', jsonPost(input), apiBaseUrl, buyerId);
}
