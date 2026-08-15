import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { CartService, InMemoryCartStore } from '../cart/cart.service';
import {
  ShippingService,
  type AggregatedRate,
  type ShippingAddressInput,
  type ShippingItemsRateInput,
} from '../shipping/shipping.service';
import { SyncInvalidationService, type SyncInvalidation } from '../sync/sync-invalidation.service';
import {
  CheckoutService,
  InMemoryOrderStore,
  type CheckoutOrder,
  type CheckoutSessionInput,
  type PaymentProvider,
  type PaymentSession,
  type StripePaymentEvent,
} from './checkout.service';
import { CheckoutSourceService } from './checkout-source.service';
import { StripePaymentProvider, type StripeClient } from './stripe-payment.provider';

function providerHarness() {
  let nextEvent: StripePaymentEvent | null = null;
  const paymentIntentId = (orderId: string) => `pi_${orderId}`;
  const provider: PaymentProvider = {
    createSession: vi.fn(async (input): Promise<PaymentSession> => ({
      provider: 'stripe',
      mode: 'test',
      status: 'ready',
      publishableKey: 'pk_test_public',
      clientSecret: `${paymentIntentId(input.orderId)}_secret_private`,
      paymentIntentId: input.paymentIntentId ?? paymentIntentId(input.orderId),
      currency: input.currency,
      amountCents: input.amountCents,
      orderId: input.orderId,
    })),
    parseWebhook: vi.fn(async () => nextEvent),
  };
  return { provider, deliver: (event: StripePaymentEvent) => { nextEvent = event; } };
}

const provider = (): PaymentProvider => providerHarness().provider;

function stripeEvent(
  order: CheckoutOrder,
  overrides: Partial<StripePaymentEvent> = {},
): StripePaymentEvent {
  return {
    id: 'evt_checkout_1',
    created: 1_786_751_000,
    type: 'succeeded',
    mode: 'test',
    paymentIntentId: order.stripePaymentIntentId!,
    orderId: order.id,
    buyerId: order.buyerId,
    sourceKind: order.sourceKind,
    sourceId: order.sourceId,
    amountCents: order.totalCents,
    amountReceivedCents: order.totalCents,
    currency: order.currency,
    ...overrides,
  };
}

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
  resolve: (quote: ShippingItemsRateInput, rateId: string) => AggregatedRate | Promise<AggregatedRate>
    = () => RATE,
): ShippingService {
  return { resolveRateForItems: vi.fn(resolve) } as unknown as ShippingService;
}

function sources(carts: CartService): CheckoutSourceService {
  return new CheckoutSourceService(carts, undefined as never, undefined as never);
}

describe('CheckoutService', () => {
  it('creates an idempotent pending order from cart snapshots', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-1', productId: 'p-1', title: 'Mug', priceCents: 1250, quantity: 2 });
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), sources(carts), shipping());
    const first = await checkout.createSession(input(cart.id));
    const retry = await checkout.createSession(input(cart.id));
    expect(first.order.totalCents).toBe(3000);
    expect(first.order).toMatchObject({
      buyerId: 'buyer-1',
      sourceKind: 'cart',
      sourceId: 'cart-1',
      paymentState: 'payment_required',
      eventId: 'event-1',
      email: 'buyer@example.test',
      shippingCents: 500,
      shippingAddress: { name: 'Avi Buyer', state: 'NY', country: 'US' },
      selectedShippingRate: RATE,
    });
    expect(retry.order.id).toBe(first.order.id);
    expect(retry.session.orderId).toBe(first.order.id);
    expect(first.order.stripePaymentIntentId).toBe(first.session.paymentIntentId);
    expect(JSON.stringify(first.order)).not.toContain('clientSecret');
    expect(JSON.stringify(first.order)).not.toContain('_secret_');
  });

  it('creates and pays a stable non-cart order through the shared source seam', async () => {
    const payments = providerHarness();
    const orders = new InMemoryOrderStore();
    const source = {
      sourceKind: 'auction' as const,
      sourceId: 'auction-1',
      orderId: 'order-winner-1',
      buyerId: 'buyer-winner',
      eventId: 'event-auction',
      subtotalCents: 3_000,
      items: [{ productId: 'plate', title: 'Plate', priceCents: 1_500, quantity: 2 }],
      revision: 'winner-v1',
      snapshot: { auctionId: 'auction-1', unitPriceCents: 1_500 },
    };
    const sourceService = {
      load: vi.fn().mockResolvedValue(source),
      sameSnapshot: vi.fn().mockReturnValue(true),
      commit: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as CheckoutSourceService;
    const checkout = new CheckoutService(payments.provider, orders, sourceService, shipping());

    const created = await checkout.createSession({
      sourceKind: 'auction',
      sourceId: 'auction-1',
      buyerId: 'buyer-winner',
      shippingAddress: ADDRESS,
      shippingRateId: RATE.id,
    });
    expect(created.order).toMatchObject({
      id: 'order-winner-1',
      sourceKind: 'auction',
      sourceId: 'auction-1',
      buyerId: 'buyer-winner',
      eventId: 'event-auction',
      subtotalCents: 3_000,
      totalCents: 3_500,
      cartId: undefined,
    });
    expect(payments.provider.createSession).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-winner-1', sourceKind: 'auction', sourceId: 'auction-1', amountCents: 3_500,
    }));

    payments.deliver(stripeEvent(created.order));
    await checkout.handleWebhook(Buffer.from('{}'), 'signed');
    await checkout.handleWebhook(Buffer.from('{}'), 'signed');
    expect(sourceService.commit).toHaveBeenCalledTimes(1);
    await expect(orders.get(created.order.id)).resolves.toMatchObject({ paymentState: 'paid' });
  });

  it('releases a cancelled source exactly once and ignores later success delivery', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-cancel', productId: 'p-1', title: 'Mug', priceCents: 1_250 });
    const sourceService = sources(carts);
    const release = vi.spyOn(sourceService, 'release');
    const payments = providerHarness();
    const checkout = new CheckoutService(payments.provider, new InMemoryOrderStore(), sourceService, shipping());
    const created = await checkout.createSession(input(cart.id));

    await checkout.cancelOrder(created.order.id, created.order.buyerId);
    await checkout.cancelOrder(created.order.id, created.order.buyerId);
    payments.deliver(stripeEvent(created.order));
    const late = await checkout.handleWebhook(Buffer.from('{}'), 'signed');

    expect(release).toHaveBeenCalledTimes(1);
    expect(late.handled).toBe(false);
    expect(late.order?.paymentState).toBe('cancelled');
  });

  it('rejects a second buyer trying to fork the same payable source', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-shared', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const orders = new InMemoryOrderStore();
    const checkout = new CheckoutService(provider(), orders, sources(carts), shipping());

    const buyerOne = await checkout.createSession(input(cart.id));
    await expect(checkout.createSession(input(cart.id, { buyerId: 'buyer-2' })))
      .rejects.toThrow('Payable source is already associated with another buyer order');
    await expect(orders.listByBuyer('buyer-1')).resolves.toEqual([
      expect.objectContaining({ id: buyerOne.order.id, buyerId: 'buyer-1' }),
    ]);
    await expect(orders.listByBuyer('buyer-2')).resolves.toEqual([]);
  });

  it('moves an order to paid only after a verified Stripe success webhook', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-2', productId: 'p-2', title: 'Headphones', priceCents: 19999 });
    const payments = providerHarness();
    const checkout = new CheckoutService(payments.provider, new InMemoryOrderStore(), sources(carts), shipping());
    const session = await checkout.createSession(input(cart.id, { buyerId: 'buyer-2', eventId: 'event-2' }));
    payments.deliver(stripeEvent(session.order));
    const confirmation = await checkout.handleWebhook(Buffer.from('{}'), 'signed');
    expect(confirmation.handled).toBe(true);
    expect(confirmation.order?.status).toBe('paid');
    expect(confirmation.order?.paymentState).toBe('paid');
  });

  it('invalidates buyer orders, event stats, and product history after payment status changes', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-live-orders', productId: 'p-2', title: 'Headphones', priceCents: 19999 });
    const invalidations = new SyncInvalidationService();
    const published: SyncInvalidation[] = [];
    const subscription = invalidations.events().subscribe((event) => published.push(event));
    const payments = providerHarness();
    const checkout = new CheckoutService(payments.provider, new InMemoryOrderStore(), sources(carts), shipping(), invalidations);

    const session = await checkout.createSession(input(cart.id, { buyerId: 'buyer-live', eventId: 'event-live' }));
    payments.deliver(stripeEvent(session.order));
    await checkout.handleWebhook(Buffer.from('{}'), 'signed');
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
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), sources(carts), rates);

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
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), sources(carts), rates);

    await expect(checkout.createSession({ ...input(cart.id), shippingCents: 1 } as never))
      .rejects.toThrow('shippingCents is server-authoritative');
    expect(rates.resolveRateForItems).not.toHaveBeenCalled();
  });

  it('rejects a cart mutation that races shipping quote selection', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-race', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const rates = shipping(async () => {
      await carts.setQuantity(cart.id, 'p-1', 2);
      return RATE;
    });
    const checkout = new CheckoutService(provider(), new InMemoryOrderStore(), sources(carts), rates);

    await expect(checkout.createSession(input(cart.id))).rejects.toThrow('Payable source changed while selecting shipping');
  });

  it('commits and invalidates exactly once for duplicate success deliveries', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-duplicate', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const commit = vi.spyOn(carts, 'commit');
    const invalidations = new SyncInvalidationService();
    const published: SyncInvalidation[] = [];
    const subscription = invalidations.events().subscribe((event) => published.push(event));
    const payments = providerHarness();
    const checkout = new CheckoutService(payments.provider, new InMemoryOrderStore(), sources(carts), shipping(), invalidations);
    const session = await checkout.createSession(input(cart.id));
    payments.deliver(stripeEvent(session.order));

    await checkout.handleWebhook(Buffer.from('{}'), 'signed');
    const duplicate = await checkout.handleWebhook(Buffer.from('{}'), 'signed');
    subscription.unsubscribe();

    expect(duplicate.handled).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(published.filter(({ name }) => name === 'event.stats')).toHaveLength(1);
  });

  it('allows success after failure but ignores failure delivered after paid', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-reordered', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const payments = providerHarness();
    const checkout = new CheckoutService(payments.provider, new InMemoryOrderStore(), sources(carts), shipping());
    const session = await checkout.createSession(input(cart.id));
    payments.deliver(stripeEvent(session.order, {
      id: 'evt_failed', type: 'failed', amountReceivedCents: undefined, errorMessage: 'declined',
    }));
    await checkout.handleWebhook(Buffer.from('{}'), 'signed');
    expect((await checkout.getOrder(session.order.id))?.paymentState).toBe('payment_failed');

    payments.deliver(stripeEvent(session.order, { id: 'evt_succeeded', created: 1_786_751_001 }));
    await checkout.handleWebhook(Buffer.from('{}'), 'signed');
    payments.deliver(stripeEvent(session.order, {
      id: 'evt_late_failed', created: 1_786_751_002, type: 'failed', amountReceivedCents: undefined,
    }));
    const late = await checkout.handleWebhook(Buffer.from('{}'), 'signed');
    expect(late.handled).toBe(false);
    expect(late.order?.status).toBe('paid');
  });

  it('rejects signed events whose SideStage identity or amount disagrees', async () => {
    const carts = new CartService(new InMemoryCartStore());
    const cart = await carts.addItem({ cartId: 'cart-mismatch', productId: 'p-1', title: 'Mug', priceCents: 1250 });
    const payments = providerHarness();
    const checkout = new CheckoutService(payments.provider, new InMemoryOrderStore(), sources(carts), shipping());
    const session = await checkout.createSession(input(cart.id));
    payments.deliver(stripeEvent(session.order, { buyerId: 'another-buyer', amountCents: 1 }));

    await expect(checkout.handleWebhook(Buffer.from('{}'), 'signed'))
      .rejects.toThrow('buyerId, amount');
    expect((await checkout.getOrder(session.order.id))?.status).toBe('pending');
  });
});

describe('StripePaymentProvider', () => {
  const sessionInput = {
    orderId: 'order_123',
    amountCents: 5_814,
    currency: 'USD' as const,
    buyerId: 'buyer-1',
    sourceKind: 'cart' as const,
    sourceId: 'cart-1',
    email: 'buyer@example.test',
  };

  it('creates one server-authored PaymentIntent with an order-derived idempotency key', async () => {
    const create = vi.fn(async (params: Stripe.PaymentIntentCreateParams) => ({
      id: 'pi_123',
      client_secret: 'pi_123_secret_private',
      amount: params.amount,
      currency: params.currency,
      metadata: params.metadata,
    }) as Stripe.PaymentIntent);
    const client = {
      paymentIntents: { create, update: vi.fn() },
      webhooks: { constructEvent: vi.fn() },
    } as unknown as StripeClient;
    const stripe = new StripePaymentProvider({
      secretKey: 'sk_test_secret', publishableKey: 'pk_test_public', webhookSecret: 'whsec_test',
    }, client);

    const session = await stripe.createSession(sessionInput);
    expect(session).toMatchObject({
      provider: 'stripe', mode: 'test', status: 'ready', paymentIntentId: 'pi_123',
      clientSecret: 'pi_123_secret_private', publishableKey: 'pk_test_public',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 5_814,
        currency: 'usd',
        metadata: { orderId: 'order_123', buyerId: 'buyer-1', sourceKind: 'cart', sourceId: 'cart-1' },
      }),
      { idempotencyKey: 'sidestage:payment-intent:order_123' },
    );
  });

  it('boots without keys and reports configuration without touching Stripe', async () => {
    const create = vi.fn();
    const client = {
      paymentIntents: { create, update: vi.fn() }, webhooks: { constructEvent: vi.fn() },
    } as unknown as StripeClient;
    const stripe = new StripePaymentProvider({ secretKey: '', publishableKey: '' }, client);
    await expect(stripe.createSession(sessionInput)).resolves.toMatchObject({
      status: 'needs-configuration', clientSecret: null, paymentIntentId: null,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('verifies Stripe signatures against the exact raw body and normalizes success', async () => {
    const webhookSecret = 'whsec_test_secret';
    const sdk = new Stripe('sk_test_secret');
    const payload = JSON.stringify({
      id: 'evt_signed',
      object: 'event',
      api_version: null,
      created: 1_786_751_000,
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_signed', object: 'payment_intent', amount: 5_814, amount_received: 5_814,
          currency: 'usd', metadata: {
            orderId: 'order_123', buyerId: 'buyer-1', sourceKind: 'cart', sourceId: 'cart-1',
          }, latest_charge: 'ch_123', last_payment_error: null,
        },
      },
    });
    const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    const stripe = new StripePaymentProvider({
      secretKey: 'sk_test_secret', publishableKey: 'pk_test_public', webhookSecret,
    }, sdk as unknown as StripeClient);

    await expect(stripe.parseWebhook(Buffer.from(payload), signature)).resolves.toMatchObject({
      id: 'evt_signed', type: 'succeeded', paymentIntentId: 'pi_signed', amountCents: 5_814,
      amountReceivedCents: 5_814, currency: 'USD', orderId: 'order_123', buyerId: 'buyer-1',
    });
    await expect(stripe.parseWebhook(Buffer.from(`${payload} `), signature))
      .rejects.toThrow('Stripe webhook verification failed');
  });
});
