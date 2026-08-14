import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { CartService, type Cart } from '../cart/cart.service';
import {
  normalizeShippingAddress,
  ShippingService,
  type AggregatedRate,
  type NormalizedShippingAddress,
  type ShippingAddressInput,
} from '../shipping/shipping.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';

export const CHECKOUT_PAYMENT_PROVIDER = Symbol('CHECKOUT_PAYMENT_PROVIDER');
export const ORDER_STORE = Symbol('ORDER_STORE');

export type PaymentSessionStatus = 'ready' | 'needs-configuration';
export type PaymentResultStatus = 'paid' | 'failed' | 'needs-configuration';
export type PayableOrderSourceKind = 'cart' | 'auction' | 'offer';
export type PayableOrderPaymentState =
  | 'payment_required'
  | 'payment_processing'
  | 'paid'
  | 'payment_failed'
  | 'cancelled'
  | 'expired';

export interface PaymentSession {
  provider: 'square';
  mode: 'sandbox';
  status: PaymentSessionStatus;
  appId: string | null;
  locationId: string | null;
  orderId: string;
  amountCents: number;
  currency: 'USD';
}

export interface PaymentResult {
  status: PaymentResultStatus;
  transactionId?: string;
  errorMessage?: string;
}

export interface PaymentProvider {
  createSession(input: { orderId: string; amountCents: number; currency: 'USD' }): Promise<PaymentSession>;
  confirmPayment(input: { orderId: string; sourceId: string; amountCents: number; currency: 'USD' }): Promise<PaymentResult>;
}

export type CheckoutOrderStatus = 'pending' | 'paid' | 'failed';

/**
 * Order persistence seam: PgOrderStore (db/pg-order-store) keeps orders across
 * restarts; the in-memory store below backs tests and DB-less clean clones.
 */
export interface OrderStore {
  get(id: string): Promise<CheckoutOrder | undefined>;
  findBySource(sourceKind: PayableOrderSourceKind, sourceId: string): Promise<CheckoutOrder | undefined>;
  findByPaymentIntent(paymentIntentId: string): Promise<CheckoutOrder | undefined>;
  listByBuyer(buyerId: string): Promise<CheckoutOrder[]>;
  set(order: CheckoutOrder): Promise<void>;
}

export interface CheckoutOrder {
  id: string;
  cartId?: string;
  buyerId: string;
  sourceKind: PayableOrderSourceKind;
  sourceId: string;
  eventId: string;
  email?: string;
  name?: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: 'USD';
  status: CheckoutOrderStatus;
  paymentState: PayableOrderPaymentState;
  stripePaymentIntentId?: string;
  createdAt: string;
  items: Cart['items'];
  cartUpdatedAt?: string;
  shippingAddress?: NormalizedShippingAddress;
  selectedShippingRate?: AggregatedRate;
  paymentSession?: PaymentSession;
  sourceSnapshot?: Record<string, unknown>;
}

export interface CheckoutSessionInput {
  cartId: string;
  buyerId: string;
  eventId: string;
  email?: string;
  name?: string;
  shippingAddress: ShippingAddressInput;
  shippingRateId: string;
}

export interface SquareSandboxConfig {
  accessToken?: string;
  appId?: string;
  locationId?: string;
  apiBaseUrl?: string;
}

const SQUARE_IDEMPOTENCY_PREFIX = 'sidestage:';
const SQUARE_IDEMPOTENCY_HASH_LENGTH = 32;
const SQUARE_REFERENCE_MAX_LENGTH = 40;
const SQUARE_REFERENCE_HASH_LENGTH = SQUARE_REFERENCE_MAX_LENGTH - SQUARE_IDEMPOTENCY_PREFIX.length;

function squareIdempotencyKey(orderId: string): string {
  const digest = createHash('sha256').update(orderId).digest('hex').slice(0, SQUARE_IDEMPOTENCY_HASH_LENGTH);
  return `${SQUARE_IDEMPOTENCY_PREFIX}${digest}`;
}

function squareReferenceId(orderId: string): string {
  if (orderId.length <= SQUARE_REFERENCE_MAX_LENGTH) return orderId;
  const digest = createHash('sha256').update(orderId).digest('hex').slice(0, SQUARE_REFERENCE_HASH_LENGTH);
  return `${SQUARE_IDEMPOTENCY_PREFIX}${digest}`;
}

/** Native-fetch Square adapter: no SDK credential or package is required for a clean clone. */
export class SquareSandboxProvider implements PaymentProvider {
  private readonly config: SquareSandboxConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SquareSandboxConfig = {}, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async createSession(input: { orderId: string; amountCents: number; currency: 'USD' }): Promise<PaymentSession> {
    const appId = this.config.appId ?? process.env.SQUARE_APP_ID ?? null;
    const locationId = this.config.locationId ?? process.env.SQUARE_LOCATION_ID ?? null;
    return {
      provider: 'square',
      mode: 'sandbox',
      status: appId && locationId ? 'ready' : 'needs-configuration',
      appId,
      locationId,
      orderId: input.orderId,
      amountCents: input.amountCents,
      currency: input.currency,
    };
  }

  async confirmPayment(input: { orderId: string; sourceId: string; amountCents: number; currency: 'USD' }): Promise<PaymentResult> {
    if (!input.sourceId.trim()) return { status: 'failed', errorMessage: 'sourceId is required' };
    const accessToken = this.config.accessToken ?? process.env.SQUARE_ACCESS_TOKEN;
    const locationId = this.config.locationId ?? process.env.SQUARE_LOCATION_ID;
    if (!accessToken || !locationId) return { status: 'needs-configuration', errorMessage: 'Square sandbox credentials are not configured' };

    const baseUrl = this.config.apiBaseUrl ?? 'https://connect.squareupsandbox.com';
    const response = await this.fetchImpl(`${baseUrl}/v2/payments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'square-version': '2025-10-16',
      },
      body: JSON.stringify({
        source_id: input.sourceId,
        idempotency_key: squareIdempotencyKey(input.orderId),
        amount_money: { amount: input.amountCents, currency: input.currency },
        location_id: locationId,
        reference_id: squareReferenceId(input.orderId),
      }),
    });
    const payload = (await response.json()) as { payment?: { id?: string; status?: string }; errors?: Array<{ detail?: string }> };
    if (!response.ok) {
      return { status: 'failed', errorMessage: payload.errors?.[0]?.detail ?? `Square returned HTTP ${response.status}` };
    }
    if (payload.payment?.status !== 'COMPLETED') {
      return { status: 'failed', transactionId: payload.payment?.id, errorMessage: `Square payment status: ${payload.payment?.status ?? 'unknown'}` };
    }
    return { status: 'paid', transactionId: payload.payment.id };
  }
}

export function verifySquareWebhookSignature(rawBody: string, signature: string, notificationUrl: string, signatureKey: string): boolean {
  const expected = createHmac('sha256', signatureKey).update(notificationUrl + rawBody).digest('base64');
  const actual = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

@Injectable()
export class InMemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, CheckoutOrder>();

  async get(id: string): Promise<CheckoutOrder | undefined> {
    const order = this.orders.get(id);
    return order ? cloneCheckoutOrder(order) : undefined;
  }

  async findBySource(sourceKind: PayableOrderSourceKind, sourceId: string): Promise<CheckoutOrder | undefined> {
    const order = [...this.orders.values()]
      .find((candidate) => candidate.sourceKind === sourceKind && candidate.sourceId === sourceId);
    return order ? cloneCheckoutOrder(order) : undefined;
  }

  async findByPaymentIntent(paymentIntentId: string): Promise<CheckoutOrder | undefined> {
    const order = [...this.orders.values()]
      .find((candidate) => candidate.stripePaymentIntentId === paymentIntentId);
    return order ? cloneCheckoutOrder(order) : undefined;
  }

  async listByBuyer(buyerId: string): Promise<CheckoutOrder[]> {
    return [...this.orders.values()]
      .filter((order) => order.buyerId === buyerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneCheckoutOrder);
  }

  async set(order: CheckoutOrder): Promise<void> {
    for (const existing of this.orders.values()) {
      if (existing.id === order.id) continue;
      if (existing.sourceKind === order.sourceKind && existing.sourceId === order.sourceId) {
        throw new Error(`Payable order source ${order.sourceKind}:${order.sourceId} already belongs to ${existing.id}`);
      }
      if (order.stripePaymentIntentId && existing.stripePaymentIntentId === order.stripePaymentIntentId) {
        throw new Error(`Stripe PaymentIntent ${order.stripePaymentIntentId} already belongs to ${existing.id}`);
      }
    }
    this.orders.set(order.id, cloneCheckoutOrder(order));
  }
}

function cloneCheckoutOrder(order: CheckoutOrder): CheckoutOrder {
  return {
    ...order,
    items: order.items.map((item) => ({ ...item })),
    shippingAddress: order.shippingAddress ? { ...order.shippingAddress } : undefined,
    selectedShippingRate: order.selectedShippingRate ? { ...order.selectedShippingRate } : undefined,
    paymentSession: order.paymentSession ? { ...order.paymentSession } : undefined,
    sourceSnapshot: order.sourceSnapshot ? { ...order.sourceSnapshot } : undefined,
  };
}

@Injectable()
export class CheckoutService {
  constructor(
    @Inject(CHECKOUT_PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    @Inject(CartService) private readonly carts: CartService,
    @Inject(ShippingService) private readonly shipping: ShippingService,
    @Optional()
    @Inject(SyncInvalidationService)
    private readonly syncInvalidations?: SyncInvalidationService,
  ) {}

  async createSession(input: CheckoutSessionInput): Promise<{ order: CheckoutOrder; session: PaymentSession }> {
    if (Object.prototype.hasOwnProperty.call(input ?? {}, 'shippingCents')) {
      throw new BadRequestException('shippingCents is server-authoritative; select shippingRateId instead');
    }
    const cartId = this.readId(input?.cartId, 'cartId');
    const buyerId = this.readId(input?.buyerId, 'buyerId');
    const eventId = this.readId(input?.eventId, 'eventId');
    const email = this.optionalText(input?.email);
    const name = this.optionalText(input?.name);
    const shippingAddress = normalizeShippingAddress({
      ...input?.shippingAddress,
      name: input?.shippingAddress?.name ?? name,
    });
    const cartBeforeQuote = await this.requireCart(cartId);
    const selectedShippingRate = await this.shipping.resolveRate(
      { cartId, address: shippingAddress },
      this.readId(input?.shippingRateId, 'shippingRateId'),
    );
    const cart = await this.requireCart(cartId);
    if (!this.sameCartSnapshot(cartBeforeQuote, cart)) {
      throw new BadRequestException('Cart changed while selecting shipping; refresh rates and try again');
    }

    const shippingCents = selectedShippingRate.totalCents;
    const totalCents = cart.subtotalCents + shippingCents;
    const existing = await this.orders.findBySource('cart', cart.id);
    if (existing?.buyerId !== undefined && existing.buyerId !== buyerId) {
      throw new BadRequestException('Cart is already associated with another buyer order');
    }
    if (existing?.status === 'paid') {
      throw new BadRequestException('Cart already has a paid order');
    }
    if (existing?.paymentSession && this.sameCheckout(existing, cart, eventId, email, name, shippingAddress, selectedShippingRate)) {
      const order = this.cloneOrder(existing);
      return { order, session: { ...order.paymentSession } };
    }

    const orderId = existing?.id ?? `order_${randomUUID()}`;
    const session = await this.provider.createSession({ orderId, amountCents: totalCents, currency: 'USD' });
    const order: CheckoutOrder = {
      id: orderId,
      cartId: cart.id,
      buyerId,
      sourceKind: 'cart',
      sourceId: cart.id,
      eventId,
      email,
      name,
      subtotalCents: cart.subtotalCents,
      shippingCents,
      totalCents,
      currency: 'USD',
      status: 'pending',
      paymentState: 'payment_required',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      items: cart.items.map((item) => ({ ...item })),
      cartUpdatedAt: cart.updatedAt,
      shippingAddress: { ...shippingAddress },
      selectedShippingRate: { ...selectedShippingRate },
      paymentSession: session,
    };
    await this.orders.set(order);
    this.invalidateBuyerOrders(buyerId);
    return { order: this.cloneOrder(order), session: { ...session } };
  }

  async confirmPayment(input: { orderId: string; sourceId: string }): Promise<{ order: CheckoutOrder; payment: PaymentResult }> {
    const order = await this.orders.get(input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.status === 'paid') return { order: this.cloneOrder(order), payment: { status: 'paid' } };
    if (!order.cartId) throw new BadRequestException('This order is not backed by a cart checkout');
    const cart = await this.requireCart(order.cartId);
    if (cart.updatedAt !== order.cartUpdatedAt || JSON.stringify(cart.items) !== JSON.stringify(order.items)) {
      throw new BadRequestException('Held items changed or expired before payment; review your held items and try again');
    }
    const previousStatus = order.status;
    const payment = await this.provider.confirmPayment({ orderId: order.id, sourceId: input.sourceId, amountCents: order.totalCents, currency: order.currency });
    if (payment.status === 'paid') {
      await this.carts.commit(order.cartId);
      order.status = 'paid';
      order.paymentState = 'paid';
    }
    if (payment.status === 'failed') {
      order.status = 'failed';
      order.paymentState = 'payment_failed';
    }
    await this.orders.set(order);
    if (order.status !== previousStatus) this.invalidateOrderStatus(order);
    return { order: this.cloneOrder(order), payment };
  }

  async getOrder(id: string): Promise<CheckoutOrder | null> {
    const order = await this.orders.get(id);
    return order ? this.cloneOrder(order) : null;
  }

  private async requireCart(id: string): Promise<Cart> {
    const cart = await this.carts.findCart(id);
    if (!cart || cart.items.length === 0) throw new BadRequestException('Cart is empty or not found');
    return cart;
  }

  private sameCartSnapshot(left: Cart, right: Cart): boolean {
    return left.id === right.id
      && left.updatedAt === right.updatedAt
      && left.subtotalCents === right.subtotalCents
      && JSON.stringify(left.items) === JSON.stringify(right.items);
  }

  private sameCheckout(
    order: CheckoutOrder,
    cart: Cart,
    eventId: string,
    email: string | undefined,
    name: string | undefined,
    shippingAddress: NormalizedShippingAddress,
    selectedShippingRate: AggregatedRate,
  ): boolean {
    return order.eventId === eventId
      && order.email === email
      && order.name === name
      && order.cartUpdatedAt === cart.updatedAt
      && order.subtotalCents === cart.subtotalCents
      && JSON.stringify(order.items) === JSON.stringify(cart.items)
      && JSON.stringify(order.shippingAddress) === JSON.stringify(shippingAddress)
      && JSON.stringify(order.selectedShippingRate) === JSON.stringify(selectedShippingRate);
  }

  private optionalText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    return text || undefined;
  }

  private readId(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
    const id = value.trim();
    if (!id || id.length > 120) throw new BadRequestException(`${field} is required and must be 120 characters or fewer`);
    return id;
  }

  private cloneOrder(order: CheckoutOrder): CheckoutOrder {
    return cloneCheckoutOrder(order);
  }

  private invalidateBuyerOrders(buyerId: string): void {
    this.syncInvalidations?.invalidate('orders.byBuyer', { buyerId });
  }

  private invalidateOrderStatus(order: CheckoutOrder): void {
    this.invalidateBuyerOrders(order.buyerId);
    this.syncInvalidations?.invalidate('event.stats', { eventId: order.eventId });
    for (const productId of new Set(order.items.map((item) => item.productId))) {
      this.syncInvalidations?.invalidate('event.pricingHistory', {
        eventId: order.eventId,
        productId,
      });
    }
  }
}
