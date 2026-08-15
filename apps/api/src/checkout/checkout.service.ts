import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
export type StripeMode = 'test' | 'live';
export type PayableOrderSourceKind = 'cart' | 'auction' | 'offer';
export type PayableOrderPaymentState =
  | 'payment_required'
  | 'payment_processing'
  | 'paid'
  | 'payment_failed'
  | 'cancelled'
  | 'expired';

export interface PaymentSession {
  provider: 'stripe';
  mode: StripeMode | null;
  status: PaymentSessionStatus;
  publishableKey: string | null;
  clientSecret: string | null;
  paymentIntentId: string | null;
  orderId: string;
  amountCents: number;
  currency: 'USD';
}

export type StripePaymentEventType = 'processing' | 'succeeded' | 'failed';

export interface StripePaymentEvent {
  id: string;
  created: number;
  type: StripePaymentEventType;
  mode: StripeMode;
  paymentIntentId: string;
  orderId: string;
  buyerId: string;
  sourceKind: string;
  sourceId: string;
  amountCents: number;
  amountReceivedCents?: number;
  currency: string;
  errorMessage?: string;
}

export interface PaymentProvider {
  createSession(input: {
    orderId: string;
    amountCents: number;
    currency: 'USD';
    buyerId: string;
    sourceKind: PayableOrderSourceKind;
    sourceId: string;
    email?: string;
    paymentIntentId?: string;
  }): Promise<PaymentSession>;
  parseWebhook(
    rawBody: Buffer,
    signature: string | string[] | undefined,
  ): Promise<StripePaymentEvent | null>;
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
  stripeEventId?: string;
  stripeEventCreated?: number;
  paymentError?: string;
  createdAt: string;
  items: Cart['items'];
  cartUpdatedAt?: string;
  shippingAddress?: NormalizedShippingAddress;
  selectedShippingRate?: AggregatedRate;
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
    sourceSnapshot: order.sourceSnapshot ? { ...order.sourceSnapshot } : undefined,
  };
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);
  private readonly paymentEventTails = new Map<string, Promise<void>>();

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
    const orderId = existing?.id ?? `order_${randomUUID()}`;
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
    };
    const session = await this.provider.createSession({
      orderId: order.id,
      amountCents: order.totalCents,
      currency: order.currency,
      buyerId: order.buyerId,
      sourceKind: order.sourceKind,
      sourceId: order.sourceId,
      email: order.email,
      paymentIntentId: existing?.stripePaymentIntentId,
    });
    order.stripePaymentIntentId = session.paymentIntentId ?? existing?.stripePaymentIntentId;
    await this.orders.set(order);
    this.invalidateBuyerOrders(buyerId);
    return { order: this.cloneOrder(order), session: { ...session } };
  }

  async handleWebhook(
    rawBody: Buffer,
    signature: string | string[] | undefined,
  ): Promise<{ received: true; handled: boolean; order?: CheckoutOrder }> {
    const event = await this.provider.parseWebhook(rawBody, signature);
    if (!event) return { received: true, handled: false };

    const matched = await this.orders.findByPaymentIntent(event.paymentIntentId);
    if (!matched) {
      this.rejectWebhook(event, ['paymentIntentId']);
    }

    return this.serializePaymentEvent(matched!.id, async () => {
      const order = await this.orders.get(matched!.id);
      if (!order) this.rejectWebhook(event, ['order']);
      this.assertWebhookMatchesOrder(order!, event);

      if (order!.stripeEventId === event.id) {
        return { received: true, handled: false, order: this.cloneOrder(order!) };
      }
      if (order!.status === 'paid') {
        return { received: true, handled: false, order: this.cloneOrder(order!) };
      }
      if (
        event.type !== 'succeeded'
        && order!.stripeEventCreated !== undefined
        && event.created < order!.stripeEventCreated
      ) {
        return { received: true, handled: false, order: this.cloneOrder(order!) };
      }

      const previousStatus = order!.status;
      const previousPaymentState = order!.paymentState;
      if (event.type === 'processing') {
        order!.status = 'pending';
        order!.paymentState = 'payment_processing';
        order!.paymentError = undefined;
      } else if (event.type === 'failed') {
        order!.status = 'failed';
        order!.paymentState = 'payment_failed';
        order!.paymentError = event.errorMessage ?? 'Payment failed';
      } else {
        if (order!.sourceKind === 'cart') {
          if (!order!.cartId) throw new BadRequestException('Cart order is missing its cart reference');
          await this.carts.commit(order!.cartId);
        }
        order!.status = 'paid';
        order!.paymentState = 'paid';
        order!.paymentError = undefined;
      }
      order!.stripeEventId = event.id;
      order!.stripeEventCreated = event.created;
      await this.orders.set(order!);

      if (order!.status !== previousStatus || order!.paymentState !== previousPaymentState) {
        this.invalidateOrderStatus(order!);
      }
      return { received: true, handled: true, order: this.cloneOrder(order!) };
    });
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

  private assertWebhookMatchesOrder(order: CheckoutOrder, event: StripePaymentEvent): void {
    const mismatches: string[] = [];
    if (order.stripePaymentIntentId !== event.paymentIntentId) mismatches.push('paymentIntentId');
    if (order.id !== event.orderId) mismatches.push('orderId');
    if (order.buyerId !== event.buyerId) mismatches.push('buyerId');
    if (order.sourceKind !== event.sourceKind) mismatches.push('sourceKind');
    if (order.sourceId !== event.sourceId) mismatches.push('sourceId');
    if (order.totalCents !== event.amountCents) mismatches.push('amount');
    if (event.type === 'succeeded' && event.amountReceivedCents !== undefined && order.totalCents !== event.amountReceivedCents) {
      mismatches.push('amountReceived');
    }
    if (order.currency !== event.currency.toUpperCase()) mismatches.push('currency');
    if (mismatches.length > 0) this.rejectWebhook(event, mismatches);
  }

  private rejectWebhook(event: StripePaymentEvent, mismatches: string[]): never {
    this.logger.warn(
      `Rejected Stripe event ${event.id} for PaymentIntent ${event.paymentIntentId}: ${mismatches.join(', ')}`,
    );
    throw new BadRequestException(`Stripe event does not match SideStage order: ${mismatches.join(', ')}`);
  }

  private async serializePaymentEvent<T>(orderId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.paymentEventTails.get(orderId) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    this.paymentEventTails.set(orderId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.paymentEventTails.get(orderId) === current) this.paymentEventTails.delete(orderId);
    }
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
