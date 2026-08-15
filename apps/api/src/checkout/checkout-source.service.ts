import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { GuardedActionService } from '../actions/action.service';
import { AuctionService } from '../auction/auction.service';
import { CartService, type CartItem } from '../cart/cart.service';
import type { CheckoutOrder, PayableOrderSourceKind } from './order-store';

export interface CheckoutSource {
  sourceKind: PayableOrderSourceKind;
  sourceId: string;
  orderId?: string;
  buyerId: string;
  eventId: string;
  subtotalCents: number;
  items: CartItem[];
  revision: string;
  snapshot: Record<string, unknown>;
}

@Injectable()
export class CheckoutSourceService {
  constructor(
    @Inject(CartService) private readonly carts: CartService,
    @Inject(AuctionService) private readonly auctions: AuctionService,
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
  ) {}

  async load(input: {
    sourceKind: PayableOrderSourceKind;
    sourceId: string;
    buyerId: string;
    eventId?: string;
  }): Promise<CheckoutSource> {
    if (input.sourceKind === 'cart') return this.loadCart(input.sourceId, input.buyerId, input.eventId);
    if (input.sourceKind === 'auction') return this.loadAuction(input.sourceId, input.buyerId);
    return this.loadOffer(input.sourceId, input.buyerId);
  }

  sameSnapshot(left: CheckoutSource, right: CheckoutSource): boolean {
    return left.sourceKind === right.sourceKind
      && left.sourceId === right.sourceId
      && left.revision === right.revision;
  }

  async commit(order: CheckoutOrder): Promise<void> {
    if (order.sourceKind === 'cart') {
      await this.carts.commit(order.sourceId);
      return;
    }
    if (order.sourceKind === 'auction') {
      await this.auctions.commitWinnerReservation(order.sourceId, order.buyerId);
      return;
    }
    await this.actions.commitOffer(order.sourceId, order.buyerId);
  }

  async release(order: CheckoutOrder): Promise<void> {
    if (order.sourceKind === 'cart') {
      await this.carts.release(order.sourceId);
      return;
    }
    if (order.sourceKind === 'auction') {
      await this.auctions.releaseWinnerReservation(order.sourceId, order.buyerId);
      return;
    }
    await this.actions.cancelOffer(order.sourceId, order.buyerId);
  }

  private async loadCart(sourceId: string, buyerId: string, eventId?: string): Promise<CheckoutSource> {
    if (!eventId) throw new BadRequestException('eventId is required for cart checkout');
    const cart = await this.carts.findCart(sourceId);
    if (!cart || cart.items.length === 0) throw new BadRequestException('Cart is empty or not found');
    const snapshot = {
      cartId: cart.id,
      cartUpdatedAt: cart.updatedAt,
      items: cart.items.map((item) => ({ ...item })),
    };
    return {
      sourceKind: 'cart',
      sourceId: cart.id,
      buyerId,
      eventId,
      subtotalCents: cart.subtotalCents,
      items: cart.items.map((item) => ({ ...item })),
      revision: JSON.stringify(snapshot),
      snapshot,
    };
  }

  private async loadAuction(sourceId: string, buyerId: string): Promise<CheckoutSource> {
    const auction = await this.auctions.getAuction(sourceId);
    const winner = auction?.winnerOrder;
    if (!winner || winner.bidderId !== buyerId) throw new BadRequestException('Auction order was not found for this buyer');
    const snapshot = { ...winner };
    return {
      sourceKind: 'auction',
      sourceId: auction.id,
      orderId: winner.id,
      buyerId: winner.bidderId,
      eventId: winner.eventId,
      subtotalCents: winner.totalCents,
      items: [{
        productId: winner.productId,
        title: winner.productId,
        priceCents: winner.unitPriceCents,
        quantity: winner.quantity,
      }],
      revision: JSON.stringify(snapshot),
      snapshot,
    };
  }

  private async loadOffer(sourceId: string, buyerId: string): Promise<CheckoutSource> {
    const offer = await this.actions.acceptOffer(sourceId, buyerId);
    const item = (await this.actions.listItems(offer.eventId))
      .find((candidate) => candidate.productId === offer.productId);
    const snapshot = { ...offer };
    return {
      sourceKind: 'offer',
      sourceId: offer.id,
      orderId: offer.id,
      buyerId: offer.buyerId,
      eventId: offer.eventId,
      subtotalCents: offer.priceCents * offer.quantity,
      items: [{
        productId: offer.productId,
        title: item?.title ?? offer.productId,
        priceCents: offer.priceCents,
        quantity: offer.quantity,
      }],
      revision: JSON.stringify(snapshot),
      snapshot,
    };
  }
}
