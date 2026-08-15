import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  normalizeShippingAddress,
  ShippingService,
  type ShippingAddressInput,
} from '../shipping/shipping.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { CheckoutSourceService } from './checkout-source.service';
import {
  cloneCheckoutOrder,
  ORDER_STORE,
  type CheckoutOrder,
  type OrderStore,
  type PayableOrderSourceKind,
} from './order-store';

export { InMemoryOrderStore, ORDER_STORE } from './order-store';
export type {
  CheckoutOrder,
  CheckoutOrderStatus,
  OrderStore,
  PayableOrderPaymentState,
  PayableOrderSourceKind,
} from './order-store';

export const CHECKOUT_PAYMENT_PROVIDER = Symbol('CHECKOUT_PAYMENT_PROVIDER');

export type PaymentSessionStatus = 'ready' | 'needs-configuration';
export type StripeMode = 'test' | 'live';

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

export interface CheckoutSessionInput {
  orderId?: string;
  cartId?: string;
  sourceKind?: PayableOrderSourceKind;
  sourceId?: string;
  buyerId: string;
  eventId?: string;
  email?: string;
  name?: string;
  shippingAddress: ShippingAddressInput;
  shippingRateId: string;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);
  private readonly paymentEventTails = new Map<string, Promise<void>>();

  constructor(
    @Inject(CHECKOUT_PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    @Inject(CheckoutSourceService) private readonly sources: CheckoutSourceService,
    @Inject(ShippingService) private readonly shipping: ShippingService,
    @Optional()
    @Inject(SyncInvalidationService)
    private readonly syncInvalidations?: SyncInvalidationService,
  ) {}

  async createSession(input: CheckoutSessionInput): Promise<{ order: CheckoutOrder; session: PaymentSession }> {
    if (Object.prototype.hasOwnProperty.call(input ?? {}, 'shippingCents')) {
      throw new BadRequestException('shippingCents is server-authoritative; select shippingRateId instead');
    }
    const buyerId = this.readId(input?.buyerId, 'buyerId');
    const requestedOrderId = this.optionalText(input?.orderId);
    if (requestedOrderId && (input?.cartId || input?.sourceKind || input?.sourceId || input?.eventId)) {
      throw new BadRequestException('orderId cannot be combined with payable-source fields');
    }
    const resumedOrder = requestedOrderId
      ? await this.getOrderForBuyer(requestedOrderId, buyerId)
      : undefined;
    if (resumedOrder?.status === 'paid') throw new BadRequestException('Order is already paid');
    if (resumedOrder?.paymentState === 'payment_processing') {
      throw new BadRequestException('Order payment is already processing');
    }
    if (
      resumedOrder?.paymentState === 'payment_failed'
      || resumedOrder?.paymentState === 'cancelled'
      || resumedOrder?.paymentState === 'expired'
    ) {
      throw new BadRequestException('Order is no longer payable');
    }

    const sourceKind = resumedOrder?.sourceKind ?? input?.sourceKind ?? 'cart';
    const sourceId = resumedOrder?.sourceId
      ?? this.readId(input?.sourceId ?? input?.cartId, sourceKind === 'cart' ? 'cartId' : 'sourceId');
    if (sourceKind === 'cart' && input?.cartId && input?.sourceId && input.cartId.trim() !== input.sourceId.trim()) {
      throw new BadRequestException('cartId and sourceId must identify the same cart');
    }
    const email = this.optionalText(input?.email);
    const name = this.optionalText(input?.name);
    const shippingAddress = normalizeShippingAddress({
      ...input?.shippingAddress,
      name: input?.shippingAddress?.name ?? name,
    });
    const sourceBeforeQuote = await this.sources.load({
      sourceKind,
      sourceId,
      buyerId,
      eventId: resumedOrder?.eventId ?? this.optionalText(input?.eventId),
    });
    const selectedShippingRate = await this.shipping.resolveRateForItems(
      {
        sourceKind: sourceBeforeQuote.sourceKind,
        sourceId: sourceBeforeQuote.sourceId,
        items: sourceBeforeQuote.items,
        revision: sourceBeforeQuote.revision,
        address: shippingAddress,
      },
      this.readId(input?.shippingRateId, 'shippingRateId'),
    );
    const source = await this.sources.load({
      sourceKind,
      sourceId,
      buyerId,
      eventId: resumedOrder?.eventId ?? this.optionalText(input?.eventId),
    });
    if (!this.sources.sameSnapshot(sourceBeforeQuote, source)) {
      throw new BadRequestException('Payable source changed while selecting shipping; refresh rates and try again');
    }

    const shippingCents = selectedShippingRate.totalCents;
    const totalCents = source.subtotalCents + shippingCents;
    const sourceOrder = await this.orders.findBySource(source.sourceKind, source.sourceId);
    if (resumedOrder && sourceOrder?.id !== resumedOrder.id) {
      throw new BadRequestException('Order source no longer matches the canonical order');
    }
    const existing = resumedOrder ?? sourceOrder;
    if (existing?.buyerId !== undefined && existing.buyerId !== buyerId) {
      throw new BadRequestException('Payable source is already associated with another buyer order');
    }
    if (existing?.status === 'paid') {
      throw new BadRequestException('Payable source already has a paid order');
    }
    if (source.orderId && existing && existing.id !== source.orderId) {
      throw new BadRequestException('Payable source is associated with an unexpected canonical order');
    }
    const orderId = existing?.id ?? source.orderId ?? `order_${randomUUID()}`;
    const order: CheckoutOrder = {
      id: orderId,
      cartId: source.sourceKind === 'cart' ? source.sourceId : undefined,
      buyerId,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      eventId: source.eventId,
      email: email ?? existing?.email,
      name: name ?? existing?.name,
      subtotalCents: source.subtotalCents,
      shippingCents,
      totalCents,
      currency: 'USD',
      status: 'pending',
      paymentState: 'payment_required',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      items: source.items.map((item) => ({ ...item })),
      cartUpdatedAt: source.sourceKind === 'cart' ? source.revision : undefined,
      shippingAddress: { ...shippingAddress },
      selectedShippingRate: { ...selectedShippingRate },
      sourceSnapshot: { ...source.snapshot },
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

  async getOrderForBuyer(idInput: string, buyerIdInput: string): Promise<CheckoutOrder> {
    const id = this.readId(idInput, 'orderId');
    const buyerId = this.readId(buyerIdInput, 'buyerId');
    const order = await this.orders.get(id);
    if (!order || order.buyerId !== buyerId) {
      throw new BadRequestException('Order was not found for this buyer');
    }
    return this.cloneOrder(order);
  }

  async quoteOrderShipping(
    idInput: string,
    buyerIdInput: string,
    addressInput: ShippingAddressInput,
  ) {
    const order = await this.getOrderForBuyer(idInput, buyerIdInput);
    if (
      order.status === 'paid'
      || order.paymentState === 'payment_failed'
      || order.paymentState === 'cancelled'
      || order.paymentState === 'expired'
    ) {
      throw new BadRequestException('Order is no longer payable');
    }
    const source = await this.sources.load({
      sourceKind: order.sourceKind,
      sourceId: order.sourceId,
      buyerId: order.buyerId,
      eventId: order.eventId,
    });
    return this.shipping.getRatesForItems({
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      items: source.items,
      revision: source.revision,
      address: normalizeShippingAddress(addressInput),
    });
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
      if (
        order!.status === 'paid'
        || order!.paymentState === 'payment_failed'
        || order!.paymentState === 'cancelled'
        || order!.paymentState === 'expired'
      ) {
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
        // A failed payment is terminal for this order. Release its source
        // before persisting the failure so a crash can only cause an
        // idempotent release retry, never a durable failed order with a live
        // cart/auction allocation. A later success for the same PaymentIntent
        // is ignored by the terminal-state guard above because its source no
        // longer owns inventory.
        await this.sources.release(order!);
        order!.status = 'failed';
        order!.paymentState = 'payment_failed';
        order!.paymentError = event.errorMessage ?? 'Payment failed';
      } else {
        await this.sources.commit(order!);
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

  async cancelOrder(id: string, buyerIdInput: string): Promise<CheckoutOrder> {
    const buyerId = this.readId(buyerIdInput, 'buyerId');
    return this.serializePaymentEvent(this.readId(id, 'orderId'), async () => {
      const order = await this.orders.get(id);
      if (!order || order.buyerId !== buyerId) throw new BadRequestException('Order was not found for this buyer');
      if (order.status === 'paid') throw new BadRequestException('Paid orders cannot be cancelled');
      if (order.paymentState === 'cancelled') return this.cloneOrder(order);
      await this.sources.release(order);
      order.status = 'failed';
      order.paymentState = 'cancelled';
      order.paymentError = undefined;
      await this.orders.set(order);
      this.invalidateOrderStatus(order);
      return this.cloneOrder(order);
    });
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
