import { Inject, Injectable } from '@nestjs/common';
import { GuardedActionService } from '../actions/action.service';
import type { TargetedOffer } from '../actions/action.types';
import { AuctionService, type AuctionWinnerOrder } from '../auction/auction.service';
import { ChatService, type ReplayChapter } from '../chat/chat.service';
import { EventService, type EventSummary } from '../events/event.service';
import { ORDER_STORE, type CheckoutOrder, type OrderStore } from './checkout.service';

export type BuyerOrderSource = 'checkout' | 'auction' | 'offer';
export type BuyerOrderStatus = CheckoutOrder['status'] | TargetedOffer['status'];

export interface BuyerOrderItem {
  productId: string;
  title: string;
  quantity: number;
  unitPriceCents: number;
  imageUrl?: string;
}

export interface BuyerOrderVideoSnapshot {
  id: string;
  eventId: string;
  eventTitle: string;
  sellerName?: string;
  productId: string;
  productTitle: string;
  thumbnailUrl?: string;
  startMs?: number;
  endMs?: number;
  previewText?: string;
  evidenceKind?: 'condition';
  evidenceLabel?: string;
}

export interface BuyerOrder {
  id: string;
  source: BuyerOrderSource;
  buyerId: string;
  eventId: string;
  eventTitle: string;
  sellerName?: string;
  status: BuyerOrderStatus;
  createdAt: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: 'USD';
  items: BuyerOrderItem[];
  videoSnapshots: BuyerOrderVideoSnapshot[];
}

@Injectable()
export class BuyerOrdersService {
  constructor(
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    @Inject(AuctionService) private readonly auctions: AuctionService,
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(EventService) private readonly events: EventService,
  ) {}

  async listForBuyer(buyerIdInput: string): Promise<BuyerOrder[]> {
    const buyerId = this.readBuyerId(buyerIdInput);
    const [checkoutOrders, auctionOrders, events] = await Promise.all([
      this.orders.listByBuyer(buyerId),
      this.auctions.listWinnerOrdersForBuyer(buyerId),
      this.events.listForGuide(),
    ]);
    const offers = this.actions.listOffersForBuyer(buyerId);
    const eventIds = [...new Set([
      ...checkoutOrders.map((order) => order.eventId),
      ...auctionOrders.map((order) => order.eventId),
      ...offers.map((offer) => offer.eventId),
    ])];
    const chaptersByEvent = new Map(await Promise.all(eventIds.map(async (eventId) => (
      [eventId, await this.chat.getReplayChapters(eventId)] as const
    ))));
    const eventById = new Map(events.map((event) => [event.eventId, event]));
    const normalized = [
      ...checkoutOrders.map((order) => this.fromCheckout(order, eventById.get(order.eventId), chaptersByEvent.get(order.eventId) ?? [])),
      ...auctionOrders.map((order) => this.fromAuction(order, eventById.get(order.eventId), chaptersByEvent.get(order.eventId) ?? [])),
      ...offers.map((offer) => this.fromOffer(offer, eventById.get(offer.eventId), chaptersByEvent.get(offer.eventId) ?? [])),
    ];
    const canonical = new Map<string, BuyerOrder>();
    for (const order of normalized) {
      const key = `${order.source}:${order.id}`;
      if (!canonical.has(key)) canonical.set(key, order);
    }
    return [...canonical.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 200);
  }

  private fromCheckout(order: CheckoutOrder, event: EventSummary | undefined, chapters: ReplayChapter[]): BuyerOrder {
    const items = order.items.map((item) => ({
      productId: item.productId,
      title: item.title,
      quantity: item.quantity,
      unitPriceCents: item.priceCents,
      imageUrl: item.imageUrl,
    }));
    return this.build({
      id: order.id, source: order.sourceKind === 'cart' ? 'checkout' : order.sourceKind,
      buyerId: order.buyerId, eventId: order.eventId,
      status: order.status, createdAt: order.createdAt, subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents, totalCents: order.totalCents, items, event, chapters,
    });
  }

  private fromAuction(order: AuctionWinnerOrder, event: EventSummary | undefined, chapters: ReplayChapter[]): BuyerOrder {
    const chapter = this.chapterFor(chapters, order.productId);
    const items = [{
      productId: order.productId,
      title: chapter?.productTitle ?? order.productId,
      quantity: order.quantity,
      unitPriceCents: order.unitPriceCents,
    }];
    return this.build({
      id: order.id, source: 'auction', buyerId: order.bidderId, eventId: order.eventId,
      status: order.status, createdAt: order.createdAt, subtotalCents: order.totalCents,
      shippingCents: 0, totalCents: order.totalCents, items, event, chapters,
    });
  }

  private fromOffer(offer: TargetedOffer, event: EventSummary | undefined, chapters: ReplayChapter[]): BuyerOrder {
    const chapter = this.chapterFor(chapters, offer.productId);
    const totalCents = offer.priceCents * offer.quantity;
    const items = [{
      productId: offer.productId,
      title: chapter?.productTitle ?? offer.productId,
      quantity: offer.quantity,
      unitPriceCents: offer.priceCents,
    }];
    return this.build({
      id: offer.id, source: 'offer', buyerId: offer.buyerId, eventId: offer.eventId,
      status: offer.status, createdAt: offer.createdAt ?? new Date(0).toISOString(),
      subtotalCents: totalCents, shippingCents: 0, totalCents, items, event, chapters,
    });
  }

  private build(input: Omit<BuyerOrder, 'eventTitle' | 'sellerName' | 'currency' | 'videoSnapshots'> & { event?: EventSummary; chapters: ReplayChapter[] }): BuyerOrder {
    const eventTitle = input.event?.title ?? input.eventId;
    const { chapters, ...order } = input;
    return {
      ...order,
      eventTitle,
      sellerName: input.event?.sellerName,
      currency: 'USD',
      videoSnapshots: input.items.flatMap((item) => {
        const itemChapters = this.chaptersFor(chapters, item.productId);
        return itemChapters.length > 0
          ? itemChapters.map((chapter) => this.snapshot(input.eventId, eventTitle, input.event, item, chapter))
          : [this.snapshot(input.eventId, eventTitle, input.event, item)];
      }),
    };
  }

  private snapshot(
    eventId: string,
    eventTitle: string,
    event: EventSummary | undefined,
    item: BuyerOrderItem,
    chapter?: ReplayChapter,
  ): BuyerOrderVideoSnapshot {
    return {
      id: `${eventId}:${item.productId}:${chapter?.startMs ?? 'event'}`,
      eventId,
      eventTitle,
      sellerName: event?.sellerName,
      productId: item.productId,
      productTitle: chapter?.productTitle ?? item.title,
      thumbnailUrl: event?.thumbnailUrl ?? item.imageUrl,
      startMs: chapter?.startMs,
      endMs: chapter?.endMs,
      previewText: chapter?.previewText,
      evidenceKind: chapter?.evidenceKind,
      evidenceLabel: chapter?.evidenceLabel,
    };
  }

  private chapterFor(chapters: ReplayChapter[], productId: string): ReplayChapter | undefined {
    return this.chaptersFor(chapters, productId)[0];
  }

  private chaptersFor(chapters: ReplayChapter[], productId: string): ReplayChapter[] {
    return chapters.filter((chapter) => chapter.productId === productId);
  }

  private readBuyerId(value: string): string {
    if (typeof value !== 'string') throw new Error('buyerId is required');
    const buyerId = value.trim();
    if (!buyerId || buyerId.length > 120) throw new Error('buyerId is required and must be 120 characters or fewer');
    return buyerId;
  }
}
