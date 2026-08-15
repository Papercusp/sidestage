import { Injectable } from '@nestjs/common';
import type { Cart } from '../cart/cart.service';

export const ORDER_STORE = Symbol('ORDER_STORE');

export type PayableOrderSourceKind = 'cart' | 'auction' | 'offer';
export type PayableOrderPaymentState =
  | 'payment_required'
  | 'payment_processing'
  | 'paid'
  | 'payment_failed'
  | 'cancelled'
  | 'expired';
export type CheckoutOrderStatus = 'pending' | 'paid' | 'failed';
export type EventCartCommitmentState = 'active' | 'released' | 'committed';

export interface EventCartSourceCommitment {
  kind: 'event-cart';
  state: EventCartCommitmentState;
  /** Exact cart aggregate revision authorized when this payment attempt began. */
  revision: string;
}

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
  sourceCommitment?: EventCartSourceCommitment;
  shippingAddress?: import('../shipping/shipping.service').NormalizedShippingAddress;
  selectedShippingRate?: import('../shipping/shipping.service').AggregatedRate;
  sourceSnapshot?: Record<string, unknown>;
}

export function cloneCheckoutOrder(order: CheckoutOrder): CheckoutOrder {
  return {
    ...order,
    items: order.items.map((item) => ({ ...item })),
    shippingAddress: order.shippingAddress ? { ...order.shippingAddress } : undefined,
    selectedShippingRate: order.selectedShippingRate ? { ...order.selectedShippingRate } : undefined,
    sourceSnapshot: order.sourceSnapshot ? { ...order.sourceSnapshot } : undefined,
    sourceCommitment: order.sourceCommitment ? { ...order.sourceCommitment } : undefined,
  };
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
