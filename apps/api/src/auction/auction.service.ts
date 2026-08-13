import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Subject, type Observable } from 'rxjs';

export const AUCTION_INVENTORY = Symbol('AUCTION_INVENTORY');

export type AuctionStatus = 'active' | 'closed';

export interface AuctionInventorySnapshot {
  productId: string;
  qty: number;
  reservedQty: number;
  availableQty: number;
}

/**
 * Inventory is intentionally a seam. The clean-clone demo uses the atomic
 * in-memory implementation below; the Postgres implementation can delegate
 * to reserve_storefront_stock/release_storefront_stock in db/schema.sql.
 */
export interface AuctionInventory {
  get(productId: string): AuctionInventorySnapshot | undefined;
  seed(productId: string, qty: number, reservedQty?: number): AuctionInventorySnapshot;
  reserve(productId: string, quantity: number): boolean;
  release(productId: string, quantity: number): boolean;
}

@Injectable()
export class InMemoryAuctionInventory implements AuctionInventory {
  private readonly items = new Map<string, AuctionInventorySnapshot>();

  get(productId: string): AuctionInventorySnapshot | undefined {
    const item = this.items.get(productId);
    return item ? { ...item } : undefined;
  }

  seed(productId: string, qty: number, reservedQty = 0): AuctionInventorySnapshot {
    const id = this.readId(productId, 'productId');
    if (!Number.isInteger(qty) || qty < 0) throw new BadRequestException('qty must be a non-negative integer');
    if (!Number.isInteger(reservedQty) || reservedQty < 0 || reservedQty > qty) {
      throw new BadRequestException('reservedQty must be an integer between 0 and qty');
    }
    const item = { productId: id, qty, reservedQty, availableQty: Math.max(0, qty - reservedQty) };
    this.items.set(id, item);
    return { ...item };
  }

  reserve(productId: string, quantity: number): boolean {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    const item = this.items.get(productId);
    if (!item || item.availableQty < quantity) return false;
    item.reservedQty += quantity;
    item.availableQty = Math.max(0, item.qty - item.reservedQty);
    return true;
  }

  release(productId: string, quantity: number): boolean {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    const item = this.items.get(productId);
    if (!item || item.reservedQty < quantity) return false;
    item.reservedQty -= quantity;
    item.availableQty = Math.max(0, item.qty - item.reservedQty);
    return true;
  }

  private readId(value: string, field: string): string {
    const id = value.trim();
    if (!id || id.length > 120) throw new BadRequestException(`${field} is required and must be 120 characters or fewer`);
    return id;
  }
}

export interface AuctionBid {
  id: string;
  bidderId: string;
  displayName?: string;
  amountCents: number;
  createdAt: string;
}

export interface AuctionWinnerOrder {
  id: string;
  auctionId: string;
  eventId: string;
  eventItemId: string;
  productId: string;
  bidderId: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  status: 'pending';
  createdAt: string;
}

export interface Auction {
  id: string;
  eventId: string;
  eventItemId: string;
  productId: string;
  quantity: number;
  startingPriceCents: number;
  currentPriceCents: number;
  status: AuctionStatus;
  startedAt: string;
  endsAt: string;
  closedAt?: string;
  bids: AuctionBid[];
  winnerOrder?: AuctionWinnerOrder;
}

export interface StartAuctionInput {
  eventId: string;
  eventItemId: string;
  productId: string;
  quantity: number;
  startingPriceCents: number;
  durationSec?: number;
  /** Event setup may provide the verified item snapshot on first use. */
  availableQty?: number;
}

export interface PlaceBidInput {
  bidderId: string;
  displayName?: string;
  amountCents: number;
}

export interface AuctionSseEvent {
  id: string;
  type: 'auction';
  data: string;
}

const DEFAULT_DURATION_SEC = 60;
const MAX_DURATION_SEC = 86_400;

@Injectable()
export class AuctionService {
  private readonly auctions = new Map<string, Auction>();
  private readonly activeByEvent = new Map<string, string>();
  private readonly updatesByEvent = new Map<string, Subject<AuctionSseEvent>>();
  private updateSequence = 0;

  constructor(@Inject(AUCTION_INVENTORY) private readonly inventory: AuctionInventory) {}

  startAuction(input: StartAuctionInput): Auction {
    const eventId = this.readId(input.eventId, 'eventId');
    const eventItemId = this.readId(input.eventItemId, 'eventItemId');
    const productId = this.readId(input.productId, 'productId');
    this.expireActive(eventId);
    const activeId = this.activeByEvent.get(eventId);
    if (activeId) throw new ConflictException(`Event ${eventId} already has an active auction`);

    const quantity = this.readPositiveInt(input.quantity, 'quantity');
    const startingPriceCents = this.readMoney(input.startingPriceCents, 'startingPriceCents');
    const durationSec = input.durationSec ?? DEFAULT_DURATION_SEC;
    if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > MAX_DURATION_SEC) {
      throw new BadRequestException(`durationSec must be an integer between 1 and ${MAX_DURATION_SEC}`);
    }

    // Event-item setup normally seeds this snapshot before the auction call.
    // Accepting it here keeps a clean clone runnable while still reserving only
    // against the inventory-owned quantity, never against a caller's quantity.
    if (!this.inventory.get(productId)) {
      if (input.availableQty === undefined) throw new NotFoundException(`Inventory item ${productId} was not found`);
      this.inventory.seed(productId, this.readNonNegativeInt(input.availableQty, 'availableQty'));
    }
    if (!this.inventory.reserve(productId, quantity)) {
      throw new ConflictException(`Insufficient available quantity for ${productId}`);
    }

    const now = Date.now();
    const auction: Auction = {
      id: `auction_${randomUUID()}`,
      eventId,
      eventItemId,
      productId,
      quantity,
      startingPriceCents,
      currentPriceCents: startingPriceCents,
      status: 'active',
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(now + durationSec * 1000).toISOString(),
      bids: [],
    };
    this.auctions.set(auction.id, auction);
    this.activeByEvent.set(eventId, auction.id);
    this.emitAuctionUpdate(auction);
    return this.cloneAuction(auction);
  }

  getActiveAuction(eventId: string): Auction | null {
    const id = this.activeByEvent.get(this.readId(eventId, 'eventId'));
    if (!id) return null;
    this.expireActive(eventId);
    const auction = this.auctions.get(id);
    return auction?.status === 'active' ? this.cloneAuction(auction) : null;
  }

  getAuction(id: string): Auction | null {
    const auction = this.requireAuction(id);
    if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) this.closeInternal(auction);
    return this.cloneAuction(auction);
  }

  placeBid(id: string, input: PlaceBidInput): Auction {
    const auction = this.requireAuction(id);
    if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) this.closeInternal(auction);
    if (auction.status !== 'active') throw new ConflictException('Auction is closed');
    const bidderId = this.readId(input.bidderId, 'bidderId');
    const amountCents = this.readMoney(input.amountCents, 'amountCents');
    if (amountCents <= auction.currentPriceCents) {
      throw new ConflictException(`Bid must be greater than the current price of ${auction.currentPriceCents} cents`);
    }
    const bid: AuctionBid = {
      id: `bid_${randomUUID()}`,
      bidderId,
      displayName: this.readOptionalName(input.displayName),
      amountCents,
      createdAt: new Date().toISOString(),
    };
    auction.bids.push(bid);
    auction.bids.sort((left, right) => right.amountCents - left.amountCents || left.createdAt.localeCompare(right.createdAt));
    auction.currentPriceCents = amountCents;
    this.emitAuctionUpdate(auction);
    return this.cloneAuction(auction);
  }

  closeAuction(id: string): Auction {
    const auction = this.requireAuction(id);
    if (auction.status === 'active') this.closeInternal(auction);
    return this.cloneAuction(auction);
  }

  inventorySnapshot(productId: string): AuctionInventorySnapshot | null {
    return this.inventory.get(this.readId(productId, 'productId')) ?? null;
  }

  updates(eventId: string): Observable<AuctionSseEvent> {
    return this.updateSubject(this.readId(eventId, 'eventId')).asObservable();
  }

  snapshotEvent(eventId: string): AuctionSseEvent {
    const resolvedEventId = this.readId(eventId, 'eventId');
    return this.createAuctionEvent(resolvedEventId, this.getActiveAuction(resolvedEventId));
  }

  private expireActive(eventId: string): void {
    const id = this.activeByEvent.get(eventId);
    if (!id) return;
    const auction = this.auctions.get(id);
    if (auction?.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) this.closeInternal(auction);
  }

  private closeInternal(auction: Auction): void {
    if (auction.status !== 'active') return;
    auction.status = 'closed';
    auction.closedAt = new Date().toISOString();
    this.activeByEvent.delete(auction.eventId);
    const winner = auction.bids[0];
    if (!winner) {
      // No winner means the start-time hold is no longer needed.
      this.inventory.release(auction.productId, auction.quantity);
      this.emitAuctionUpdate(auction);
      return;
    }
    auction.winnerOrder = {
      id: `order_${randomUUID()}`,
      auctionId: auction.id,
      eventId: auction.eventId,
      eventItemId: auction.eventItemId,
      productId: auction.productId,
      bidderId: winner.bidderId,
      quantity: auction.quantity,
      unitPriceCents: winner.amountCents,
      totalCents: winner.amountCents * auction.quantity,
      status: 'pending',
      createdAt: auction.closedAt,
    };
    // The winner order owns the reservation and can later hand it to checkout.
    this.emitAuctionUpdate(auction);
  }

  private emitAuctionUpdate(auction: Auction): void {
    this.updateSubject(auction.eventId).next(this.createAuctionEvent(auction.eventId, auction));
  }

  private createAuctionEvent(eventId: string, auction: Auction | null): AuctionSseEvent {
    const now = Date.now();
    return {
      id: `${eventId}-${now}-${++this.updateSequence}`,
      type: 'auction',
      data: JSON.stringify({
        name: 'event.auction.active',
        args: { eventId },
        auction: auction ? this.cloneAuction(auction) : null,
        tsMs: now,
      }),
    };
  }

  private updateSubject(eventId: string): Subject<AuctionSseEvent> {
    let subject = this.updatesByEvent.get(eventId);
    if (!subject) {
      subject = new Subject<AuctionSseEvent>();
      this.updatesByEvent.set(eventId, subject);
    }
    return subject;
  }

  private requireAuction(id: string): Auction {
    const auction = this.auctions.get(this.readId(id, 'auctionId'));
    if (!auction) throw new NotFoundException('Auction was not found');
    return auction;
  }

  private cloneAuction(auction: Auction): Auction {
    return {
      ...auction,
      bids: auction.bids.map((bid) => ({ ...bid })),
      winnerOrder: auction.winnerOrder ? { ...auction.winnerOrder } : undefined,
    };
  }

  private readId(value: string, field: string): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
    const id = value.trim();
    if (!id || id.length > 120) throw new BadRequestException(`${field} is required and must be 120 characters or fewer`);
    return id;
  }

  private readPositiveInt(value: number, field: string): number {
    if (!Number.isInteger(value) || value <= 0) throw new BadRequestException(`${field} must be a positive integer`);
    return value;
  }

  private readNonNegativeInt(value: number, field: string): number {
    if (!Number.isInteger(value) || value < 0) throw new BadRequestException(`${field} must be a non-negative integer`);
    return value;
  }

  private readMoney(value: number, field: string): number {
    if (!Number.isInteger(value) || value < 1) throw new BadRequestException(`${field} must be a positive integer in cents`);
    return value;
  }

  private readOptionalName(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim().length > 80) throw new BadRequestException('displayName must be 80 characters or fewer');
    return value.trim() || undefined;
  }
}
