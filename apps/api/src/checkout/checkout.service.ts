import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { CartService, type Cart } from '../cart/cart.service';
import {
  normalizeShippingAddress,
  ShippingService,
  type AggregatedRate,
  type NormalizedShippingAddress,
  type ShippingAddressInput,
} from '../shipping/shipping.service';

export const CHECKOUT_PAYMENT_PROVIDER = Symbol('CHECKOUT_PAYMENT_PROVIDER');
export const ORDER_STORE = Symbol('ORDER_STORE');

export type PaymentSessionStatus = 'ready' | 'needs-configuration';
export type PaymentResultStatus = 'paid' | 'failed' | 'needs-configuration';

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
  findPendingByCart(cartId: string, buyerId: string): Promise<CheckoutOrder | undefined>;
  listByBuyer(buyerId: string): Promise<CheckoutOrder[]>;
  set(order: CheckoutOrder): Promise<void>;
}

export interface CheckoutOrder {
  id: string;
  cartId: string;
  buyerId: string;
  eventId: string;
  email?: string;
  name?: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: 'USD';
  status: CheckoutOrderStatus;
  createdAt: string;
  items: Cart['items'];
  cartUpdatedAt?: string;
  shippingAddress?: NormalizedShippingAddress;
  selectedShippingRate?: AggregatedRate;
  paymentSession: PaymentSession;
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
        idempotency_key: `sidestage:${input.orderId}`,
        amount_money: { amount: input.amountCents, currency: input.currency },
        location_id: locationId,
        reference_id: input.orderId,
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

  async findPendingByCart(cartId: string, buyerId: string): Promise<CheckoutOrder | undefined> {
    const order = [...this.orders.values()]
      .find((candidate) => candidate.cartId === cartId && candidate.buyerId === buyerId && candidate.status === 'pending');
    return order ? cloneCheckoutOrder(order) : undefined;
  }

  async listByBuyer(buyerId: string): Promise<CheckoutOrder[]> {
    return [...this.orders.values()]
      .filter((order) => order.buyerId === buyerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneCheckoutOrder);
  }

  async set(order: CheckoutOrder): Promise<void> {
    this.orders.set(order.id, cloneCheckoutOrder(order));
  }
}

function cloneCheckoutOrder(order: CheckoutOrder): CheckoutOrder {
  return {
    ...order,
    items: order.items.map((item) => ({ ...item })),
    shippingAddress: order.shippingAddress ? { ...order.shippingAddress } : undefined,
    selectedShippingRate: order.selectedShippingRate ? { ...order.selectedShippingRate } : undefined,
    paymentSession: { ...order.paymentSession },
  };
}

@Injectable()
export class CheckoutService {
  constructor(
    @Inject(CHECKOUT_PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    @Inject(CartService) private readonly carts: CartService,
    @Inject(ShippingService) private readonly shipping: ShippingService,
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
    const existing = await this.orders.findPendingByCart(cart.id, buyerId);
    if (existing && this.sameCheckout(existing, cart, eventId, email, name, shippingAddress, selectedShippingRate)) {
      const order = this.cloneOrder(existing);
      return { order, session: { ...order.paymentSession } };
    }

    const orderId = existing?.id ?? `order_${randomUUID()}`;
    const session = await this.provider.createSession({ orderId, amountCents: totalCents, currency: 'USD' });
    const order: CheckoutOrder = {
      id: orderId,
      cartId: cart.id,
      buyerId,
      eventId,
      email,
      name,
      subtotalCents: cart.subtotalCents,
      shippingCents,
      totalCents,
      currency: 'USD',
      status: 'pending',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      items: cart.items.map((item) => ({ ...item })),
      cartUpdatedAt: cart.updatedAt,
      shippingAddress: { ...shippingAddress },
      selectedShippingRate: { ...selectedShippingRate },
      paymentSession: session,
    };
    await this.orders.set(order);
    return { order: this.cloneOrder(order), session: { ...session } };
  }

  async confirmPayment(input: { orderId: string; sourceId: string }): Promise<{ order: CheckoutOrder; payment: PaymentResult }> {
    const order = await this.orders.get(input.orderId);
    if (!order) throw new Error('Order not found');
    if (order.status === 'paid') return { order: this.cloneOrder(order), payment: { status: 'paid' } };
    const payment = await this.provider.confirmPayment({ orderId: order.id, sourceId: input.sourceId, amountCents: order.totalCents, currency: order.currency });
    if (payment.status === 'paid') order.status = 'paid';
    if (payment.status === 'failed') order.status = 'failed';
    await this.orders.set(order);
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
}
