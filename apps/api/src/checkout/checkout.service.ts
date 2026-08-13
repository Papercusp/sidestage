import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { CartService, type Cart } from '../cart/cart.service';

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
  findPendingByCart(cartId: string): Promise<CheckoutOrder | undefined>;
  set(order: CheckoutOrder): Promise<void>;
}

export interface CheckoutOrder {
  id: string;
  cartId: string;
  email?: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: 'USD';
  status: CheckoutOrderStatus;
  items: Cart['items'];
  paymentSession: PaymentSession;
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
    return this.orders.get(id);
  }

  async findPendingByCart(cartId: string): Promise<CheckoutOrder | undefined> {
    return [...this.orders.values()].find((order) => order.cartId === cartId && order.status === 'pending');
  }

  async set(order: CheckoutOrder): Promise<void> {
    this.orders.set(order.id, order);
  }
}

@Injectable()
export class CheckoutService {
  constructor(
    @Inject(CHECKOUT_PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    private readonly carts: CartService,
  ) {}

  async createSession(input: { cartId: string; email?: string; shippingCents?: number }): Promise<{ order: CheckoutOrder; session: PaymentSession }> {
    const cart = await this.carts.findCart(input.cartId);
    if (!cart || cart.items.length === 0) throw new Error('Cart is empty or not found');
    const shippingCents = input.shippingCents ?? 0;
    if (!Number.isInteger(shippingCents) || shippingCents < 0) throw new Error('shippingCents must be a non-negative integer');
    const existing = await this.orders.findPendingByCart(cart.id);
    if (existing) return { order: this.cloneOrder(existing), session: existing.paymentSession };

    const subtotalCents = cart.subtotalCents;
    const orderId = `order_${randomUUID()}`;
    const session = await this.provider.createSession({ orderId, amountCents: subtotalCents + shippingCents, currency: 'USD' });
    const order: CheckoutOrder = {
      id: orderId,
      cartId: cart.id,
      email: input.email,
      subtotalCents,
      shippingCents,
      totalCents: subtotalCents + shippingCents,
      currency: 'USD',
      status: 'pending',
      items: cart.items.map((item) => ({ ...item })),
      paymentSession: session,
    };
    await this.orders.set(order);
    return { order: this.cloneOrder(order), session };
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

  private cloneOrder(order: CheckoutOrder): CheckoutOrder {
    return { ...order, items: order.items.map((item) => ({ ...item })), paymentSession: { ...order.paymentSession } };
  }
}
