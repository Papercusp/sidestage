import type { BuyerProduct } from './buyer';
import { resolveApiBaseUrl } from './catalog';

export interface BuyerCartItem {
  productId: string;
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
  provider: 'square';
  mode: 'sandbox';
  status: 'ready' | 'needs-configuration';
  appId: string | null;
  locationId: string | null;
  orderId: string;
  amountCents: number;
  currency: 'USD';
}

export interface BuyerCheckoutOrder {
  id: string;
  cartId: string;
  buyerId: string;
  eventId: string;
  email?: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: 'USD';
  status: 'pending' | 'paid' | 'failed';
  createdAt: string;
  items: BuyerCartItem[];
  shippingAddress?: BuyerShippingAddress;
  selectedShippingRate?: BuyerShippingRate;
  paymentSession: BuyerPaymentSession;
}

export interface BuyerCheckoutSessionResponse {
  order: BuyerCheckoutOrder;
  session: BuyerPaymentSession;
}

export interface BuyerPaymentResult {
  order: BuyerCheckoutOrder;
  payment: {
    status: 'paid' | 'failed' | 'needs-configuration';
    transactionId?: string;
    errorMessage?: string;
  };
}

export interface BuyerCheckoutSessionInput {
  cartId: string;
  buyerId: string;
  eventId: string;
  email: string;
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

async function requestJson<T>(path: string, init: RequestInit = {}, apiBaseUrl?: string): Promise<T> {
  const response = await fetch(`${resolveApiBaseUrl(apiBaseUrl)}${path}`, init);
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
  const cart = await requestJson<BuyerCart>('/cart/items', jsonPost({
    cartId: readBuyerCartId(buyerId, storage),
    productId: product.id,
    title: product.title,
    priceCents: product.priceCents,
    quantity: 1,
    imageUrl: product.imageUrl,
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
  apiBaseUrl?: string,
): Promise<BuyerShippingRate[]> {
  return requestJson<BuyerShippingRate[]>('/shipping/rates', jsonPost({ cartId, address }), apiBaseUrl);
}

export function createBuyerCheckoutSession(
  input: BuyerCheckoutSessionInput,
  apiBaseUrl?: string,
): Promise<BuyerCheckoutSessionResponse> {
  return requestJson<BuyerCheckoutSessionResponse>('/checkout/sessions', jsonPost(input), apiBaseUrl);
}

export function confirmBuyerSquarePayment(
  orderId: string,
  sourceId: string,
  apiBaseUrl?: string,
): Promise<BuyerPaymentResult> {
  return requestJson<BuyerPaymentResult>('/checkout/confirm', jsonPost({ orderId, sourceId }), apiBaseUrl);
}
