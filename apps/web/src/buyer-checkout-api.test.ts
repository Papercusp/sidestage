import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addHeldProductToCart,
  buyerCartStorageKey,
  createBuyerCheckoutSession,
  fetchBuyerCart,
  fetchBuyerOrder,
  fetchBuyerOrderShippingRates,
  fetchBuyerShippingRates,
  removeBuyerCartItem,
  setBuyerCartQuantity,
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
      items: [{ productId: 'mug', title: 'Aurora mug', priceCents: 2500, quantity: 1, expiresAt: '2026-08-14T06:02:00Z' }],
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
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('x-demo-principal')).toBe('demo buyer');
    expect(cartStorage.setItem).toHaveBeenCalledWith(key, 'cart-existing');
  });

  it('creates a stable cart identity and threads event context plus a request identity into a Watch hold', async () => {
    const cartStorage = storage();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      return response({
        id: body.cartId,
        currency: 'USD',
        subtotalCents: 1_500,
        updatedAt: '2026-08-14T06:00:00Z',
        items: [{
          productId: 'mug', eventId: 'event-1', eventItemId: 'event-1:mug',
          title: 'Event mug', priceCents: 1_500, quantity: 1,
        }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const held = await addHeldProductToCart('buyer-event', {
      id: 'mug', eventId: 'event-1', eventItemId: 'event-1:mug',
      title: 'Event mug', subtitle: 'Live', priceCents: 1_500, availableQty: 2,
    }, 'https://api.example.test', cartStorage);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, string>;
    expect(body).toMatchObject({
      cartId: held.id,
      productId: 'mug',
      eventId: 'event-1',
      eventItemId: 'event-1:mug',
    });
    expect(body.idempotencyKey).toMatch(/^cart-hold:/);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('x-demo-principal')).toBe('buyer-event');
    expect(cartStorage.setItem).toHaveBeenCalledWith(buyerCartStorageKey('buyer-event'), held.id);
  });

  it('sends the selected buyer principal on every cart REST fallback', async () => {
    const cart = {
      id: 'cart-1', currency: 'USD', items: [], subtotalCents: 0, updatedAt: '2026-08-14T06:00:00Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(response(cart));
    vi.stubGlobal('fetch', fetchMock);

    await fetchBuyerCart('cart-1', 'buyer-1', 'https://api.example.test');
    await setBuyerCartQuantity('cart-1', 'mug', 2, 'buyer-1', 'https://api.example.test');
    await removeBuyerCartItem('cart-1', 'mug', 'buyer-1', 'https://api.example.test');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/cart/cart-1',
      'https://api.example.test/cart/cart-1/items/mug',
      'https://api.example.test/cart/cart-1/items/mug',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get('x-demo-principal')).toBe('buyer-1');
    }
  });

  it('requests live rates with cart id plus the normalized address contract', async () => {
    const rates = [{
      id: 'UPS:Ground', carrier: 'UPS', service: 'Ground', totalCents: 1099,
      deliveryDays: 4, parcelCount: 1, quotedAt: '2026-08-14T06:00:00Z',
    }];
    const fetchMock = vi.fn().mockResolvedValue(response(rates));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBuyerShippingRates('cart-1', address, 'buyer-1', 'https://api.example.test')).resolves.toEqual(rates);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/shipping/rates', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ cartId: 'cart-1', address });
  });

  it('starts checkout with server-authoritative shippingRateId and never sends shipping cents', async () => {
    const payload = {
      order: { id: 'order-1' },
      session: { provider: 'stripe', mode: 'test', status: 'ready' },
    } as unknown as BuyerCheckoutSessionResponse;
    const fetchMock = vi.fn().mockResolvedValue(response(payload));
    vi.stubGlobal('fetch', fetchMock);

    await createBuyerCheckoutSession({
      cartId: 'cart-1', eventId: 'event-1', email: 'buyer@example.test',
      shippingAddress: address, shippingRateId: 'UPS:Ground',
    }, 'buyer-1', 'https://api.example.test');

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      cartId: 'cart-1', eventId: 'event-1', email: 'buyer@example.test',
      shippingAddress: address, shippingRateId: 'UPS:Ground',
    });
    expect(body).not.toHaveProperty('shippingCents');
    expect(body).not.toHaveProperty('buyerId');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('x-demo-principal')).toBe('buyer-1');
  });

  it('reads and quotes a canonical order with principal authority', async () => {
    const order = { id: 'order-1', paymentState: 'payment_required' };
    const rates = [{ id: 'UPS:Ground' }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(order))
      .mockResolvedValueOnce(response(rates));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBuyerOrder('order-1', 'buyer-1', 'https://api.example.test')).resolves.toEqual(order);
    await expect(fetchBuyerOrderShippingRates('order-1', address, 'buyer-1', 'https://api.example.test'))
      .resolves.toEqual(rates);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/checkout/orders/order-1',
      'https://api.example.test/checkout/orders/order-1/shipping-rates',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get('x-demo-principal')).toBe('buyer-1');
    }
  });

  it('surfaces the API message instead of reducing a rejected quote to a generic HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ message: 'Shipping rate is unavailable or expired' }, false, 400)));
    await expect(fetchBuyerShippingRates('cart-1', address, 'buyer-1')).rejects.toThrow('Shipping rate is unavailable or expired');
  });
});
