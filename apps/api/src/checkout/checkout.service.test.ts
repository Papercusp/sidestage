import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
import {
  ShippingService,
  type AggregatedRate,
  type ShippingAddressInput,
  type ShippingRateInput,
} from '../shipping/shipping.service';
import { SyncInvalidationService, type SyncInvalidation } from '../sync/sync-invalidation.service';
import {
  CheckoutService,
  InMemoryOrderStore,
  SquareSandboxProvider,
  verifySquareWebhookSignature,
  type CheckoutSessionInput,
  type PaymentProvider,
} from './checkout.service';

const provider = (result: 'paid' | 'failed' = 'paid'): PaymentProvider => ({
  createSession: async (input) => ({ provider: 'square', mode: 'sandbox', status: 'ready', appId: 'app', locationId: 'loc', currency: input.currency, amountCents: input.amountCents, orderId: input.orderId }),
  confirmPayment: async () => ({ status: result, transactionId: result === 'paid' ? 'txn-1' : undefined }),
});

const ADDRESS: ShippingAddressInput = {
  name: '  Avi Buyer  ',
  line1: ' 99 Main St ',
  city: 'New York',
  state: 'ny',
  postalCode: '10001',
  country: 'us',
};

const RATE: AggregatedRate = {
  id: 'UPS:Ground',
  carrier: 'UPS',
  service: 'Ground',
  totalCents: 500,
  deliveryDays: 4,
  parcelCount: 1,
  quotedAt: '2026-08-14T06:00:00.000Z',
};

function input(cartId: string, overrides: Partial<CheckoutSessionInput> = {}): CheckoutSessionInput {
  return {
    cartId,
    buyerId: 'buyer-1',
    eventId: 'event-1',
    email: ' buyer@example.test ',
    shippingAddress: ADDRESS,
    shippingRateId: RATE.id,
    ...overrides,
  };
}

function shipping(
  resolve: (quote: ShippingRateInput, rateId: string) => AggregatedRate | Promise<AggregatedRate>
    = () => RATE,
): ShippingService {
  return { resolveRate: vi.fn(resolve) } as unknown as ShippingService;
}

describe('CheckoutService', () => {
  it('creates an idempotent pending order from cart snapshots', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-1', productId: 'p-1', title: 'Mug', priceCents: 1250, quantity: 2 });
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), carts, shipping());
    const first = await checkout.createSession(input(cart.id));
    const retry = await checkout.createSession(input(cart.id));
    expect(first.order.totalCents).toBe(3000);
    expect(first.order).toMatchObject({
      buyerId: 'buyer-1',
      eventId: 'event-1',
      email: 'buyer@example.test',
      shippingCents: 500,
      shippingAddress: { name: 'Avi Buyer', state: 'NY', country: 'US' },
      selectedShippingRate: RATE,
    });
    expect(retry.order.id).toBe(first.order.id);
    expect(retry.session.orderId).toBe(first.order.id);
  });

  it('scopes pending-order idempotency and listing to the current buyer', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-shared', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const orders = new InMemoryOrderStore();
    const checkout = new CheckoutService(provider(), orders, carts, shipping());

    const buyerOne = await checkout.createSession(input(cart.id));
    const buyerTwo = await checkout.createSession(input(cart.id, { buyerId: 'buyer-2' }));

    expect(buyerTwo.order.id).not.toBe(buyerOne.order.id);
    await expect(orders.listByBuyer('buyer-1')).resolves.toEqual([
      expect.objectContaining({ id: buyerOne.order.id, buyerId: 'buyer-1' }),
    ]);
    await expect(orders.listByBuyer('buyer-2')).resolves.toEqual([
      expect.objectContaining({ id: buyerTwo.order.id, buyerId: 'buyer-2' }),
    ]);
  });

  it('moves an order to paid only after the provider confirms it', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-2', productId: 'p-2', title: 'Headphones', priceCents: 19999 });
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), carts, shipping());
    const session = await checkout.createSession(input(cart.id, { buyerId: 'buyer-2', eventId: 'event-2' }));
    const confirmation = await checkout.confirmPayment({ orderId: session.order.id, sourceId: 'cnon:card-nonce-ok' });
    expect(confirmation.payment.status).toBe('paid');
    expect(confirmation.order.status).toBe('paid');
  });

  it('invalidates buyer orders, event stats, and product history after payment status changes', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-live-orders', productId: 'p-2', title: 'Headphones', priceCents: 19999 });
    const invalidations = new SyncInvalidationService();
    const published: SyncInvalidation[] = [];
    const subscription = invalidations.events().subscribe((event) => published.push(event));
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), carts, shipping(), invalidations);

    const session = await checkout.createSession(input(cart.id, { buyerId: 'buyer-live', eventId: 'event-live' }));
    await checkout.confirmPayment({ orderId: session.order.id, sourceId: 'cnon:card-nonce-ok' });
    subscription.unsubscribe();

    expect(published.filter(({ name }) => name === 'orders.byBuyer').map(({ args }) => args)).toEqual([
      { buyerId: 'buyer-live' },
      { buyerId: 'buyer-live' },
    ]);
    expect(published.filter(({ name }) => name === 'event.stats').map(({ args }) => args)).toEqual([
      { eventId: 'event-live' },
    ]);
    expect(published.filter(({ name }) => name === 'event.pricingHistory').map(({ args }) => args)).toEqual([
      { eventId: 'event-live', productId: 'p-2' },
    ]);
  });

  it('refreshes the same pending order when the buyer changes address or selected quote', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-refresh', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const rates = shipping((_quote, rateId) => ({
      ...RATE,
      id: rateId,
      service: rateId === 'UPS:Air' ? 'Air' : 'Ground',
      totalCents: rateId === 'UPS:Air' ? 900 : 500,
    }));
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), carts, rates);

    const first = await checkout.createSession(input(cart.id));
    const second = await checkout.createSession(input(cart.id, {
      shippingAddress: { ...ADDRESS, postalCode: '10002' },
      shippingRateId: 'UPS:Air',
    }));

    expect(second.order.id).toBe(first.order.id);
    expect(second.order).toMatchObject({
      shippingCents: 900,
      totalCents: 2150,
      shippingAddress: { postalCode: '10002' },
      selectedShippingRate: { id: 'UPS:Air', totalCents: 900 },
    });
  });

  it('rejects client-authored shipping cents before consulting the rate resolver', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-client-price', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const rates = shipping();
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), carts, rates);

    await expect(checkout.createSession({ ...input(cart.id), shippingCents: 1 } as never))
      .rejects.toThrow('shippingCents is server-authoritative');
    expect(rates.resolveRate).not.toHaveBeenCalled();
  });

  it('rejects a cart mutation that races shipping quote selection', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-race', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const rates = shipping(async () => {
      await carts.setQuantity(cart.id, 'p-1', 2);
      return RATE;
    });
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), carts, rates);

    await expect(checkout.createSession(input(cart.id))).rejects.toThrow('Cart changed while selecting shipping');
  });
});

describe('SquareSandboxProvider', () => {
  it('does not call Square when credentials are absent', async () => {
    let calls = 0;
    const square = new SquareSandboxProvider({ appId: 'app', locationId: 'loc' }, async () => {
      calls += 1;
      throw new Error('should not call');
    });
    const result = await square.confirmPayment({ orderId: 'order-1', sourceId: 'source', amountCents: 100, currency: 'USD' });
    expect(result.status).toBe('needs-configuration');
    expect(calls).toBe(0);
  });

  it("verifies Square's URL-plus-body HMAC contract", () => {
    const body = '{"type":"payment.completed"}';
    const url = 'https://example.test/checkout/webhook';
    const key = 'secret';
    const signature = createHmac('sha256', key).update(url + body).digest('base64');
    expect(verifySquareWebhookSignature(body, signature, url, key)).toBe(true);
    expect(verifySquareWebhookSignature(body, signature, url + '/wrong', key)).toBe(false);
  });
});
