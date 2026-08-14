import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Subject, type Observable } from 'rxjs';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';

export const AUCTION_INVENTORY = Symbol('AUCTION_INVENTORY');

export type AuctionStatus = 'active' | 'closed';

export interface AuctionInventorySnapshot {
  productId: string;
  qty: number;
  reservedQty: number;
  availableQty: number;
}

/** Identifies WHO holds inventory, so holds are idempotent and releasable per source. */
export interface InventoryHoldSource {
  kind: 'auction' | 'event' | 'cart';
  id: string;
}

/**
 * Inventory is intentionally a seam. The clean-clone demo uses the atomic
 * in-memory implementation below; PgAuctionInventory (db/pg-auction-inventory)
 * delegates to the source-tracked reserve_inventory()/release_inventory()
 * primitives in db/schema.sql. The contract is async because the durable
 * implementation is.
 */
export interface AuctionInventory {
  get(productId: string): Promise<AuctionInventorySnapshot | undefined>;
  seed(productId: string, qty: number, reservedQty?: number): Promise<AuctionInventorySnapshot>;
  reserve(productId: string, quantity: number, source: InventoryHoldSource, expiresAt?: string): Promise<boolean>;
  release(productId: string, quantity: number, source: InventoryHoldSource): Promise<boolean>;
  commit(productId: string, source: InventoryHoldSource): Promise<boolean>;
}

interface InMemoryInventoryHold {
  quantity: number;
  expiresAt?: string;
  committed: boolean;
}

@Injectable()
export class InMemoryAuctionInventory implements AuctionInventory {
  private readonly items = new Map<string, AuctionInventorySnapshot>();
  private readonly holds = new Map<string, InMemoryInventoryHold>();

  async get(productId: string): Promise<AuctionInventorySnapshot | undefined> {
    this.expireHolds(productId);
    const item = this.items.get(productId);
    return item ? { ...item } : undefined;
  }

  async seed(productId: string, qty: number, reservedQty = 0): Promise<AuctionInventorySnapshot> {
    const id = this.readId(productId, 'productId');
    if (!Number.isInteger(qty) || qty < 0) throw new BadRequestException('qty must be a non-negative integer');
    if (!Number.isInteger(reservedQty) || reservedQty < 0 || reservedQty > qty) {
      throw new BadRequestException('reservedQty must be an integer between 0 and qty');
    }
    const item = { productId: id, qty, reservedQty, availableQty: Math.max(0, qty - reservedQty) };
    this.items.set(id, item);
    return { ...item };
  }

  async reserve(productId: string, quantity: number, source: InventoryHoldSource, expiresAt?: string): Promise<boolean> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    this.expireHolds(productId);
    const item = this.items.get(productId);
    if (!item) return false;
    const holdKey = this.holdKey(productId, source);
    const previousHold = this.holds.get(holdKey);
    if (previousHold?.committed) return true;
    const previous = previousHold?.quantity ?? 0;
    // Idempotent per source, like reserve_inventory(): re-reserving replaces the hold.
    if (item.availableQty + previous < quantity) return false;
    item.reservedQty += quantity - previous;
    item.availableQty = Math.max(0, item.qty - item.reservedQty);
    this.holds.set(holdKey, { quantity, expiresAt, committed: false });
    return true;
  }

  async release(productId: string, quantity: number, source: InventoryHoldSource): Promise<boolean> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    this.expireHolds(productId);
    const item = this.items.get(productId);
    const holdKey = this.holdKey(productId, source);
    const hold = this.holds.get(holdKey);
    if (!item || !hold) return false;
    item.reservedQty = Math.max(0, item.reservedQty - hold.quantity);
    item.availableQty = Math.max(0, item.qty - item.reservedQty);
    this.holds.delete(holdKey);
    return true;
  }

  async commit(productId: string, source: InventoryHoldSource): Promise<boolean> {
    const hold = this.holds.get(this.holdKey(productId, source));
    if (!hold) return false;
    hold.committed = true;
    hold.expiresAt = undefined;
    return true;
  }

  private expireHolds(productId: string): void {
    const now = Date.now();
    for (const [key, hold] of this.holds) {
      if (!key.endsWith(`:${productId}`) || hold.committed || !hold.expiresAt) continue;
      const expiresAt = Date.parse(hold.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
      const item = this.items.get(productId);
      if (item) {
        item.reservedQty = Math.max(0, item.reservedQty - hold.quantity);
        item.availableQty = Math.max(0, item.qty - item.reservedQty);
      }
      this.holds.delete(key);
    }
  }

  private holdKey(productId: string, source: InventoryHoldSource): string {
    return `${source.kind}:${source.id}:${productId}`;
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
  /**
   * The event's CURRENT auction — active, or the most recently closed one.
   *
   * It deliberately survives a close: the buyer panel reads this to show the
   * SOLD/winner result, and clearing it here would make the closed state
   * unreachable by every client path (closeInternal emits the winner and then
   * invalidates the query that would re-serve it). A new startAuction on the
   * same event overwrites the entry.
   */
  private readonly currentByEvent = new Map<string, string>();
  private readonly updatesByEvent = new Map<string, Subject<AuctionSseEvent>>();
  private updateSequence = 0;

  constructor(
    @Inject(AUCTION_INVENTORY) private readonly inventory: AuctionInventory,
    @Optional()
    @Inject(SyncInvalidationService)
    private readonly syncInvalidations?: SyncInvalidationService,
  ) {}

  async startAuction(input: StartAuctionInput): Promise<Auction> {
    const eventId = this.readId(input.eventId, 'eventId');
    const eventItemId = this.readId(input.eventItemId, 'eventItemId');
    const productId = this.readId(input.productId, 'productId');
    await this.expireActive(eventId);
    // The entry survives a close, so presence alone no longer proves an auction
    // is running — the status is what gates a new one.
    const currentId = this.currentByEvent.get(eventId);
    const current = currentId ? this.auctions.get(currentId) : undefined;
    if (current?.status === 'active') throw new ConflictException(`Event ${eventId} already has an active auction`);

    const quantity = this.readPositiveInt(input.quantity, 'quantity');
    const startingPriceCents = this.readMoney(input.startingPriceCents, 'startingPriceCents');
    const durationSec = input.durationSec ?? DEFAULT_DURATION_SEC;
    if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > MAX_DURATION_SEC) {
      throw new BadRequestException(`durationSec must be an integer between 1 and ${MAX_DURATION_SEC}`);
    }

    // The auction id doubles as the inventory-hold source id, so it is minted
    // before the hold is placed.
    const auctionId = `auction_${randomUUID()}`;

    // Event-item setup normally seeds this snapshot before the auction call.
    // Accepting it here keeps a clean clone runnable while still reserving only
    // against the inventory-owned quantity, never against a caller's quantity.
    if (!(await this.inventory.get(productId))) {
      if (input.availableQty === undefined) throw new NotFoundException(`Inventory item ${productId} was not found`);
      await this.inventory.seed(productId, this.readNonNegativeInt(input.availableQty, 'availableQty'));
    }
    if (!(await this.inventory.reserve(productId, quantity, { kind: 'auction', id: auctionId }))) {
      throw new ConflictException(`Insufficient available quantity for ${productId}`);
    }

    const now = Date.now();
    const auction: Auction = {
      id: auctionId,
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
    this.currentByEvent.set(eventId, auction.id);
    this.emitAuctionUpdate(auction, true);
    return this.cloneAuction(auction);
  }

  /**
   * The event's current auction — ACTIVE, or the most recently closed one.
   *
   * Closed auctions are returned on purpose. This is what the buyer panel
   * reads, and the close is the moment the buyer most needs to see: filtering
   * to `status === 'active'` here made the panel's SOLD/winner state
   * unreachable at runtime, so a winning bidder was shown "No auction is live
   * yet" the instant they won (WI-38736). The entry is replaced when the next
   * auction starts on the event.
   */
  async getCurrentAuction(eventId: string): Promise<Auction | null> {
    const resolvedEventId = this.readId(eventId, 'eventId');
    const id = this.currentByEvent.get(resolvedEventId);
    if (!id) return null;
    // Settles a run-out clock first, so a caller never sees a stale 'active'.
    await this.expireActive(resolvedEventId);
    const auction = this.auctions.get(id);
    return auction ? this.cloneAuction(auction) : null;
  }

  async getAuction(id: string): Promise<Auction | null> {
    const auction = this.requireAuction(id);
    if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) await this.closeInternal(auction);
    return this.cloneAuction(auction);
  }

  /** Completed and active auctions for one product, newest first. */
  async listByProduct(productIdInput: string): Promise<Auction[]> {
    const productId = this.readId(productIdInput, 'productId');
    const matches: Auction[] = [];
    for (const auction of this.auctions.values()) {
      if (auction.productId !== productId) continue;
      if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) {
        await this.closeInternal(auction);
      }
      matches.push(this.cloneAuction(auction));
    }
    return matches.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async listWinnerOrdersForBuyer(bidderIdInput: string): Promise<AuctionWinnerOrder[]> {
    const bidderId = this.readId(bidderIdInput, 'bidderId');
    const orders: AuctionWinnerOrder[] = [];
    for (const auction of this.auctions.values()) {
      if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) {
        await this.closeInternal(auction);
      }
      if (auction.winnerOrder?.bidderId === bidderId) orders.push({ ...auction.winnerOrder });
    }
    return orders.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async placeBid(id: string, input: PlaceBidInput): Promise<Auction> {
    const auction = this.requireAuction(id);
    if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) await this.closeInternal(auction);
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

  async closeAuction(id: string): Promise<Auction> {
    const auction = this.requireAuction(id);
    if (auction.status === 'active') await this.closeInternal(auction);
    return this.cloneAuction(auction);
  }

  async inventorySnapshot(productId: string): Promise<AuctionInventorySnapshot | null> {
    return (await this.inventory.get(this.readId(productId, 'productId'))) ?? null;
  }

  updates(eventId: string): Observable<AuctionSseEvent> {
    return this.updateSubject(this.readId(eventId, 'eventId')).asObservable();
  }

  async snapshotEvent(eventId: string): Promise<AuctionSseEvent> {
    const resolvedEventId = this.readId(eventId, 'eventId');
    return this.createAuctionEvent(resolvedEventId, await this.getCurrentAuction(resolvedEventId));
  }

  private async expireActive(eventId: string): Promise<void> {
    const id = this.currentByEvent.get(eventId);
    if (!id) return;
    const auction = this.auctions.get(id);
    if (auction?.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) await this.closeInternal(auction);
  }

  private async closeInternal(auction: Auction): Promise<void> {
    if (auction.status !== 'active') return;
    auction.status = 'closed';
    auction.closedAt = new Date().toISOString();
    // The event's current-auction entry deliberately survives the close — see
    // currentByEvent. Deleting it here is what hid the SOLD state (WI-38736).
    const winner = auction.bids[0];
    if (!winner) {
      // No winner means the start-time hold is no longer needed.
      await this.inventory.release(auction.productId, auction.quantity, { kind: 'auction', id: auction.id });
      this.emitAuctionUpdate(auction, true);
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
    this.syncInvalidations?.invalidate('orders.byBuyer', { buyerId: winner.bidderId });
  }

  private emitAuctionUpdate(auction: Auction, inventoryChanged = false): void {
    this.updateSubject(auction.eventId).next(this.createAuctionEvent(auction.eventId, auction));
    this.syncInvalidations?.invalidate('event.auction.active', { eventId: auction.eventId });
    this.syncInvalidations?.invalidate('event.pricingHistory', {
      eventId: auction.eventId,
      productId: auction.productId,
    });
    if (inventoryChanged) {
      this.syncInvalidations?.invalidate('catalog.page');
      this.syncInvalidations?.invalidate('inventory.snapshot', { productId: auction.productId });
    }
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
