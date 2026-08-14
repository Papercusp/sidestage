import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addHeldProductToCart,
  buyerCartStorageKey,
  createBuyerCheckoutSession,
  fetchBuyerShippingRates,
  type BuyerCart,
  type BuyerCheckoutSessionResponse,
  type BuyerShippingAddress,
  type CartIdStorage,
} from './buyer-checkout-api';

function storage(seed: Record<string, string> = {}): CartIdStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
}

function response(payload: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: vi.fn().mockResolvedValue(payload) };
}

const address: BuyerShippingAddress = {
  name: 'Avi Buyer',
  line1: '99 Main St',
  city: 'New York',
  state: 'NY',
  postalCode: '10001',
  country: 'US',
};

afterEach(() => vi.unstubAllGlobals());

describe('buyer checkout API adapter', () => {
  it('reuses and persists the buyer-scoped durable cart id when adding a held product', async () => {
    const key = buyerCartStorageKey('demo buyer');
    const cartStorage = storage({ [key]: 'cart-existing' });
    const cart: BuyerCart = {
      id: 'cart-existing', currency: 'USD', subtotalCents: 2500, updatedAt: '2026-08-14T06:00:00Z',
      items: [{ productId: 'mug', title: 'Aurora mug', priceCents: 2500, quantity: 1 }],
    };
    const fetchMock = vi.fn().mockResolvedValue(response(cart));
    vi.stubGlobal('fetch', fetchMock);

    await expect(addHeldProductToCart('demo buyer', {
      id: 'mug', title: 'Aurora mug', subtitle: 'Kiln & Coast', priceCents: 2500, availableQty: 2,
    }, 'https://api.example.test/', cartStorage)).resolves.toEqual(cart);

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/cart/items', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({
      cartId: 'cart-existing', productId: 'mug', priceCents: 2500, quantity: 1,
    }));
    expect(cartStorage.setItem).toHaveBeenCalledWith(key, 'cart-existing');
  });

  it('requests live rates with cart id plus the normalized address contract', async () => {
    const rates = [{
      id: 'UPS:Ground', carrier: 'UPS', service: 'Ground', totalCents: 1099,
      deliveryDays: 4, parcelCount: 1, quotedAt: '2026-08-14T06:00:00Z',
    }];
    const fetchMock = vi.fn().mockResolvedValue(response(rates));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBuyerShippingRates('cart-1', address, 'https://api.example.test')).resolves.toEqual(rates);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/shipping/rates', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ cartId: 'cart-1', address });
  });

  it('starts checkout with server-authoritative shippingRateId and never sends shipping cents', async () => {
    const payload = {
      order: { id: 'order-1' },
      session: { provider: 'square', mode: 'sandbox', status: 'ready' },
    } as unknown as BuyerCheckoutSessionResponse;
    const fetchMock = vi.fn().mockResolvedValue(response(payload));
    vi.stubGlobal('fetch', fetchMock);

    await createBuyerCheckoutSession({
      cartId: 'cart-1', buyerId: 'buyer-1', eventId: 'event-1', email: 'buyer@example.test',
      shippingAddress: address, shippingRateId: 'UPS:Ground',
    }, 'https://api.example.test');

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      cartId: 'cart-1', buyerId: 'buyer-1', eventId: 'event-1', email: 'buyer@example.test',
      shippingAddress: address, shippingRateId: 'UPS:Ground',
    });
    expect(body).not.toHaveProperty('shippingCents');
  });

  it('surfaces the API message instead of reducing a rejected quote to a generic HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ message: 'Shipping rate is unavailable or expired' }, false, 400)));
    await expect(fetchBuyerShippingRates('cart-1', address)).rejects.toThrow('Shipping rate is unavailable or expired');
  });
});
