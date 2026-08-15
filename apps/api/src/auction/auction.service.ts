import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Subject, type Observable } from 'rxjs';
import type { CatalogSource } from '../catalog/catalog.types';
import { ORDER_STORE, type CheckoutOrder, type OrderStore } from '../checkout/order-store';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';

export const AUCTION_INVENTORY = Symbol('AUCTION_INVENTORY');
export const AUCTION_STORE = Symbol('AUCTION_STORE');

export type AuctionStatus = 'active' | 'closed';
export type AuctionAllocationState = 'held' | 'committed' | 'released';
export type AuctionCloseReason = 'settled' | 'seller-cancelled';

export interface AuctionInventorySnapshot {
  productId: string;
  qty: number;
  reservedQty: number;
  availableQty: number;
  priceCents?: number;
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
  getOwned(productId: string, sellerId: string): Promise<AuctionInventorySnapshot | undefined>;
  seed(productId: string, qty: number, reservedQty?: number, sellerId?: string): Promise<AuctionInventorySnapshot>;
  save(productId: string, quantity: number, priceCents: number): Promise<AuctionInventorySnapshot | undefined>;
  saveOwned(productId: string, quantity: number, priceCents: number, sellerId: string): Promise<AuctionInventorySnapshot | undefined>;
  reserve(productId: string, quantity: number, source: InventoryHoldSource, expiresAt?: string): Promise<boolean>;
  reserveOwned(productId: string, quantity: number, source: InventoryHoldSource, sellerId: string, expiresAt?: string): Promise<boolean>;
  release(productId: string, quantity: number, source: InventoryHoldSource): Promise<boolean>;
  releaseOwned(productId: string, quantity: number, source: InventoryHoldSource, sellerId: string): Promise<boolean>;
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
  private readonly owners = new Map<string, string>();
  private readonly holds = new Map<string, InMemoryInventoryHold>();
  private readonly releasedHolds = new Set<string>();

  constructor(private readonly catalog?: CatalogSource) {}

  async get(productId: string): Promise<AuctionInventorySnapshot | undefined> {
    this.expireHolds(productId);
    const item = this.items.get(productId);
    return item ? { ...item } : undefined;
  }

  async getOwned(productId: string, sellerId: string): Promise<AuctionInventorySnapshot | undefined> {
    return await this.isOwned(productId, sellerId) ? this.get(productId) : undefined;
  }

  async seed(productId: string, qty: number, reservedQty = 0, sellerId = 'demo-seller'): Promise<AuctionInventorySnapshot> {
    const id = this.readId(productId, 'productId');
    if (!Number.isInteger(qty) || qty < 0) throw new BadRequestException('qty must be a non-negative integer');
    if (!Number.isInteger(reservedQty) || reservedQty < 0 || reservedQty > qty) {
      throw new BadRequestException('reservedQty must be an integer between 0 and qty');
    }
    const item = { productId: id, qty, reservedQty, availableQty: Math.max(0, qty - reservedQty) };
    this.items.set(id, item);
    this.owners.set(id, sellerId);
    return { ...item };
  }

  async save(productId: string, quantity: number, priceCents: number): Promise<AuctionInventorySnapshot | undefined> {
    const id = this.readId(productId, 'productId');
    if (!Number.isInteger(quantity) || quantity < 0) throw new BadRequestException('quantity must be a non-negative integer');
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new BadRequestException('priceCents must be a non-negative integer');

    const item = this.items.get(id);
    const catalogVariant = await this.catalog?.variant(id);
    if (!item && !catalogVariant) return undefined;
    const reservedQty = item?.reservedQty ?? catalogVariant!.reservedQty;
    if (quantity < reservedQty) {
      throw new ConflictException(`Quantity cannot be lower than ${reservedQty} reserved units for ${id}`);
    }
    const savedCatalogVariant = this.catalog?.saveInventory
      ? await this.catalog.saveInventory(id, quantity, priceCents)
      : catalogVariant;
    const next = item ?? {
      productId: id,
      qty: quantity,
      reservedQty,
      availableQty: Math.max(0, quantity - reservedQty),
      priceCents: savedCatalogVariant?.priceCents ?? priceCents,
    };
    next.qty = quantity;
    next.availableQty = Math.max(0, quantity - next.reservedQty);
    next.priceCents = priceCents;
    this.items.set(id, next);
    return { ...next };
  }

  async saveOwned(productId: string, quantity: number, priceCents: number, sellerId: string): Promise<AuctionInventorySnapshot | undefined> {
    if (!(await this.isOwned(productId, sellerId))) return undefined;
    return this.save(productId, quantity, priceCents);
  }

  async reserve(productId: string, quantity: number, source: InventoryHoldSource, expiresAt?: string): Promise<boolean> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    this.expireHolds(productId);
    const item = this.items.get(productId);
    if (!item) return false;
    const holdKey = this.holdKey(productId, source);
    this.releasedHolds.delete(holdKey);
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

  async reserveOwned(productId: string, quantity: number, source: InventoryHoldSource, sellerId: string, expiresAt?: string): Promise<boolean> {
    if (!(await this.isOwned(productId, sellerId))) return false;
    return this.reserve(productId, quantity, source, expiresAt);
  }

  async release(productId: string, quantity: number, source: InventoryHoldSource): Promise<boolean> {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    this.expireHolds(productId);
    const item = this.items.get(productId);
    const holdKey = this.holdKey(productId, source);
    const hold = this.holds.get(holdKey);
    if (!item || !hold) return this.releasedHolds.has(holdKey);
    item.reservedQty = Math.max(0, item.reservedQty - hold.quantity);
    item.availableQty = Math.max(0, item.qty - item.reservedQty);
    this.holds.delete(holdKey);
    this.releasedHolds.add(holdKey);
    return true;
  }

  async releaseOwned(productId: string, quantity: number, source: InventoryHoldSource, sellerId: string): Promise<boolean> {
    if (!(await this.isOwned(productId, sellerId))) return false;
    return this.release(productId, quantity, source);
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

  private async isOwned(productId: string, sellerId: string): Promise<boolean> {
    const owner = this.owners.get(productId);
    if (owner) return owner === sellerId;
    if (!(await this.catalog?.variant(productId))) return false;
    // The clean-clone catalog is an explicit legacy fixture, matching the
    // seller_id used by db/seed/demo.sql. Runtime-created rows always seed an
    // owner explicitly through the seller path.
    this.owners.set(productId, 'demo-seller');
    return sellerId === 'demo-seller';
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
  /** Stable per verified buyer + request; persisted with the aggregate. */
  idempotencyKey?: string;
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
  /** Event-lineup allocation lifecycle; legacy rows are inferred on read. */
  allocationState?: AuctionAllocationState;
  closeReason?: AuctionCloseReason;
  startedAt: string;
  endsAt: string;
  closedAt?: string;
  bids: AuctionBid[];
  winnerOrder?: AuctionWinnerOrder;
}

export interface AuctionCloseResult {
  auction: Auction;
  changed: boolean;
  inventoryChanged: boolean;
}

export interface AuctionBidResult extends AuctionCloseResult {
  accepted: boolean;
}

/**
 * Transactional aggregate authority used when Postgres is available. The
 * in-memory implementation remains inside AuctionService for clean clones;
 * this seam owns every durable mutation so a process restart cannot split an
 * auction from its bid order, inventory hold, or winner order.
 */
export interface AuctionStore {
  start(auction: Auction, availableQty?: number): Promise<Auction>;
  getCurrentByEvent(eventId: string): Promise<Auction | null>;
  get(id: string): Promise<Auction | null>;
  listByProduct(productId: string): Promise<Auction[]>;
  listWinnerOrdersForBuyer(bidderId: string): Promise<AuctionWinnerOrder[]>;
  placeBid(id: string, bid: AuctionBid): Promise<AuctionBidResult>;
  close(id: string): Promise<AuctionCloseResult>;
  cancel(id: string): Promise<AuctionCloseResult>;
  commitWinner(id: string, buyerId: string): Promise<AuctionCloseResult>;
  releaseWinner(id: string, buyerId: string): Promise<AuctionCloseResult>;
  closeExpired(): Promise<AuctionCloseResult[]>;
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
  idempotencyKey?: string;
}

export interface AuctionSseEvent {
  id: string;
  type: 'auction';
  data: string;
}

const DEFAULT_DURATION_SEC = 60;
const MAX_DURATION_SEC = 86_400;
export const MAX_AUCTION_AMOUNT_CENTS = 100_000_000;
export const MAX_AUCTION_QUANTITY = 10_000;

@Injectable()
export class AuctionService {
  private readonly auctions = new Map<string, Auction>();
  /** Explicit clean-clone fallback; Postgres mutates event_lineup_item transactionally. */
  private readonly eventAvailability = new Map<string, number>();
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
    @Optional()
    @Inject(AUCTION_STORE)
    private readonly store?: AuctionStore | null,
    @Optional()
    @Inject(ORDER_STORE)
    private readonly orders?: OrderStore,
  ) {}

  async startAuction(input: StartAuctionInput): Promise<Auction> {
    const eventId = this.readId(input.eventId, 'eventId');
    const eventItemId = this.readId(input.eventItemId, 'eventItemId');
    const productId = this.readId(input.productId, 'productId');
    await this.expireActive(eventId);
    // The entry survives a close, so presence alone no longer proves an auction
    // is running — the status is what gates a new one.
    if (!this.store) {
      const currentId = this.currentByEvent.get(eventId);
      const current = currentId ? this.auctions.get(currentId) : undefined;
      if (current?.status === 'active') throw new ConflictException(`Event ${eventId} already has an active auction`);
    }

    const quantity = this.readPositiveInt(input.quantity, 'quantity', MAX_AUCTION_QUANTITY);
    const startingPriceCents = this.readMoney(input.startingPriceCents, 'startingPriceCents');
    const durationSec = input.durationSec ?? DEFAULT_DURATION_SEC;
    if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > MAX_DURATION_SEC) {
      throw new BadRequestException(`durationSec must be an integer between 1 and ${MAX_DURATION_SEC}`);
    }

    // The auction id doubles as the inventory-hold source id, so it is minted
    // before the hold is placed.
    const auctionId = `auction_${randomUUID()}`;

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
      allocationState: 'held',
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(now + durationSec * 1000).toISOString(),
      bids: [],
    };

    if (this.store) {
      const availableQty = input.availableQty === undefined
        ? undefined
        : this.readNonNegativeInt(input.availableQty, 'availableQty');
      const stored = await this.store.start(auction, availableQty);
      this.emitAuctionUpdate(stored, true);
      return this.cloneAuction(stored);
    }

    // Event-item setup normally seeds this snapshot before the auction call.
    // Accepting it here keeps a clean clone runnable while still reserving only
    // against the inventory-owned quantity, never against a caller's quantity.
    let inventorySnapshot = await this.inventory.get(productId);
    if (!inventorySnapshot) {
      if (input.availableQty === undefined) throw new NotFoundException(`Inventory item ${productId} was not found`);
      inventorySnapshot = await this.inventory.seed(productId, this.readNonNegativeInt(input.availableQty, 'availableQty'));
    }
    this.reserveEventAllocation(auction, input.availableQty ?? inventorySnapshot.availableQty);
    if (!(await this.inventory.reserve(productId, quantity, { kind: 'auction', id: auctionId }))) {
      this.releaseEventAllocation(auction);
      throw new ConflictException(`Insufficient available quantity for ${productId}`);
    }
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
    if (this.store) {
      const auction = await this.store.getCurrentByEvent(resolvedEventId);
      if (!auction) return null;
      const settled = await this.settleStoredAuction(auction);
      await this.ensureCanonicalWinnerOrder(settled.winnerOrder);
      return this.cloneAuction(settled);
    }
    const id = this.currentByEvent.get(resolvedEventId);
    if (!id) return null;
    // Settles a run-out clock first, so a caller never sees a stale 'active'.
    await this.expireActive(resolvedEventId);
    const auction = this.auctions.get(id);
    await this.ensureCanonicalWinnerOrder(auction?.winnerOrder);
    return auction ? this.cloneAuction(auction) : null;
  }

  async getAuction(id: string): Promise<Auction | null> {
    if (this.store) {
      const auction = await this.store.get(this.readId(id, 'auctionId'));
      if (!auction) throw new NotFoundException('Auction was not found');
      const settled = await this.settleStoredAuction(auction);
      await this.ensureCanonicalWinnerOrder(settled.winnerOrder);
      return this.cloneAuction(settled);
    }
    const auction = this.requireAuction(id);
    if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) await this.closeInternal(auction);
    await this.ensureCanonicalWinnerOrder(auction.winnerOrder);
    return this.cloneAuction(auction);
  }

  /** Completed and active auctions for one product, newest first. */
  async listByProduct(productIdInput: string): Promise<Auction[]> {
    const productId = this.readId(productIdInput, 'productId');
    if (this.store) {
      const matches = await this.store.listByProduct(productId);
      return Promise.all(matches.map(async (auction) => {
        const settled = await this.settleStoredAuction(auction);
        await this.ensureCanonicalWinnerOrder(settled.winnerOrder);
        return this.cloneAuction(settled);
      }));
    }
    const matches: Auction[] = [];
    for (const auction of this.auctions.values()) {
      if (auction.productId !== productId) continue;
      if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) {
        await this.closeInternal(auction);
      }
      await this.ensureCanonicalWinnerOrder(auction.winnerOrder);
      matches.push(this.cloneAuction(auction));
    }
    return matches.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async listWinnerOrdersForBuyer(bidderIdInput: string): Promise<AuctionWinnerOrder[]> {
    const bidderId = this.readId(bidderIdInput, 'bidderId');
    if (this.store) {
      for (const result of await this.store.closeExpired()) this.publishStoredClose(result);
      const orders = await this.store.listWinnerOrdersForBuyer(bidderId);
      await Promise.all(orders.map((order) => this.ensureCanonicalWinnerOrder(order)));
      return orders;
    }
    const orders: AuctionWinnerOrder[] = [];
    for (const auction of this.auctions.values()) {
      if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) {
        await this.closeInternal(auction);
      }
      if (auction.winnerOrder?.bidderId === bidderId) orders.push({ ...auction.winnerOrder });
    }
    await Promise.all(orders.map((order) => this.ensureCanonicalWinnerOrder(order)));
    return orders.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async placeBid(id: string, input: PlaceBidInput): Promise<Auction> {
    const resolvedId = this.readId(id, 'auctionId');
    const bidderId = this.readId(input.bidderId, 'bidderId');
    const amountCents = this.readMoney(input.amountCents, 'amountCents');
    const idempotencyKey = input.idempotencyKey === undefined
      ? undefined
      : this.readIdempotencyKey(input.idempotencyKey);
    const bid: AuctionBid = {
      id: `bid_${randomUUID()}`,
      bidderId,
      displayName: this.readOptionalName(input.displayName),
      amountCents,
      createdAt: new Date().toISOString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    if (this.store) {
      const result = await this.store.placeBid(resolvedId, bid);
      if (!result.accepted) {
        this.publishStoredClose(result);
        throw new ConflictException('Auction is closed');
      }
      this.emitAuctionUpdate(result.auction);
      return this.cloneAuction(result.auction);
    }

    const auction = this.requireAuction(resolvedId);
    const replay = this.findBidReplay(auction, bid);
    if (replay) return this.cloneAuction(auction);
    if (auction.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) await this.closeInternal(auction);
    if (auction.status !== 'active') throw new ConflictException('Auction is closed');
    if (amountCents <= auction.currentPriceCents) {
      throw new ConflictException(`Bid must be greater than the current price of ${auction.currentPriceCents} cents`);
    }
    auction.bids.push(bid);
    auction.bids.sort((left, right) => right.amountCents - left.amountCents || left.createdAt.localeCompare(right.createdAt));
    auction.currentPriceCents = amountCents;
    this.emitAuctionUpdate(auction);
    return this.cloneAuction(auction);
  }

  async closeAuction(id: string): Promise<Auction> {
    if (this.store) {
      const result = await this.store.close(this.readId(id, 'auctionId'));
      this.publishStoredClose(result);
      await this.ensureCanonicalWinnerOrder(result.auction.winnerOrder);
      return this.cloneAuction(result.auction);
    }
    const auction = this.requireAuction(id);
    if (auction.status === 'active') await this.closeInternal(auction);
    await this.ensureCanonicalWinnerOrder(auction.winnerOrder);
    return this.cloneAuction(auction);
  }

  async cancelAuction(id: string): Promise<Auction> {
    if (this.store) {
      const result = await this.store.cancel(this.readId(id, 'auctionId'));
      this.publishStoredClose(result);
      return this.cloneAuction(result.auction);
    }
    const auction = this.requireAuction(id);
    if (auction.status === 'closed') {
      if (auction.closeReason !== 'seller-cancelled') throw new ConflictException('Settled auctions cannot be cancelled');
      return this.cloneAuction(auction);
    }
    auction.status = 'closed';
    auction.closedAt = new Date().toISOString();
    auction.closeReason = 'seller-cancelled';
    await this.inventory.release(auction.productId, auction.quantity, { kind: 'auction', id: auction.id });
    this.releaseEventAllocation(auction);
    this.emitAuctionUpdate(auction, true);
    return this.cloneAuction(auction);
  }

  async commitWinnerReservation(auctionIdInput: string, buyerIdInput: string): Promise<void> {
    const auction = await this.requireWinnerAuction(auctionIdInput, buyerIdInput);
    if (this.store) {
      const result = await this.store.commitWinner(auction.id, buyerIdInput);
      if (result.changed) this.emitAuctionUpdate(result.auction, result.inventoryChanged);
      return;
    }
    if (auction.allocationState === 'committed') return;
    if (auction.allocationState === 'released') throw new ConflictException('Auction allocation was already released');
    const committed = await this.inventory.commit(
      auction.productId,
      { kind: 'auction', id: auction.id },
    );
    if (!committed) throw new Error(`Auction inventory hold for ${auction.productId} could not be committed`);
    auction.allocationState = 'committed';
    this.emitAuctionUpdate(auction, true);
  }

  async releaseWinnerReservation(auctionIdInput: string, buyerIdInput: string): Promise<void> {
    const auction = await this.requireWinnerAuction(auctionIdInput, buyerIdInput);
    if (this.store) {
      const result = await this.store.releaseWinner(auction.id, buyerIdInput);
      if (result.changed) this.emitAuctionUpdate(result.auction, result.inventoryChanged);
      return;
    }
    if (auction.allocationState === 'released') return;
    if (auction.allocationState === 'committed') throw new ConflictException('Paid auction allocation cannot be released');
    const released = await this.inventory.release(
      auction.productId,
      auction.quantity,
      { kind: 'auction', id: auction.id },
    );
    if (!released) throw new Error(`Auction inventory hold for ${auction.productId} could not be released`);
    this.releaseEventAllocation(auction);
    this.emitAuctionUpdate(auction, true);
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
    if (this.store) {
      const auction = await this.store.getCurrentByEvent(eventId);
      if (auction) await this.settleStoredAuction(auction);
      return;
    }
    const id = this.currentByEvent.get(eventId);
    if (!id) return;
    const auction = this.auctions.get(id);
    if (auction?.status === 'active' && Date.now() >= Date.parse(auction.endsAt)) await this.closeInternal(auction);
  }

  private async settleStoredAuction(auction: Auction): Promise<Auction> {
    if (!this.store || auction.status !== 'active' || Date.now() < Date.parse(auction.endsAt)) return auction;
    const result = await this.store.close(auction.id);
    this.publishStoredClose(result);
    await this.ensureCanonicalWinnerOrder(result.auction.winnerOrder);
    return result.auction;
  }

  private publishStoredClose(result: AuctionCloseResult): void {
    if (!result.changed) return;
    this.emitAuctionUpdate(result.auction, result.inventoryChanged);
    const winner = result.auction.winnerOrder;
    if (winner) this.syncInvalidations?.invalidate('orders.byBuyer', { buyerId: winner.bidderId });
  }

  private async closeInternal(auction: Auction): Promise<void> {
    if (auction.status !== 'active') return;
    auction.status = 'closed';
    auction.closedAt = new Date().toISOString();
    auction.closeReason = 'settled';
    // The event's current-auction entry deliberately survives the close — see
    // currentByEvent. Deleting it here is what hid the SOLD state (WI-38736).
    const winner = auction.bids[0];
    if (!winner) {
      // No winner means the start-time hold is no longer needed.
      await this.inventory.release(auction.productId, auction.quantity, { kind: 'auction', id: auction.id });
      this.releaseEventAllocation(auction);
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
    await this.ensureCanonicalWinnerOrder(auction.winnerOrder);
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
      this.syncInvalidations?.invalidate('event.lineup.items', { eventId: auction.eventId });
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

  private async requireWinnerAuction(auctionIdInput: string, buyerIdInput: string): Promise<Auction> {
    const buyerId = this.readId(buyerIdInput, 'buyerId');
    const auction = await this.getAuction(this.readId(auctionIdInput, 'auctionId'));
    if (!auction?.winnerOrder || auction.winnerOrder.bidderId !== buyerId) {
      throw new NotFoundException('Auction order was not found for this buyer');
    }
    return auction;
  }

  private async ensureCanonicalWinnerOrder(winner: AuctionWinnerOrder | undefined): Promise<void> {
    if (!winner || !this.orders) return;
    const existing = await this.orders.findBySource('auction', winner.auctionId);
    if (existing) {
      if (existing.id !== winner.id || existing.buyerId !== winner.bidderId) {
        throw new ConflictException('Auction winner is already associated with another canonical order');
      }
      return;
    }
    const order: CheckoutOrder = {
      id: winner.id,
      buyerId: winner.bidderId,
      sourceKind: 'auction',
      sourceId: winner.auctionId,
      eventId: winner.eventId,
      subtotalCents: winner.totalCents,
      shippingCents: 0,
      totalCents: winner.totalCents,
      currency: 'USD',
      status: 'pending',
      paymentState: 'payment_required',
      createdAt: winner.createdAt,
      items: [{
        productId: winner.productId,
        title: winner.productId,
        priceCents: winner.unitPriceCents,
        quantity: winner.quantity,
      }],
      sourceSnapshot: { ...winner },
    };
    await this.orders.set(order);
  }

  private cloneAuction(auction: Auction): Auction {
    return {
      ...auction,
      bids: auction.bids.map((bid) => ({ ...bid })),
      winnerOrder: auction.winnerOrder ? { ...auction.winnerOrder } : undefined,
    };
  }

  private eventAllocationKey(auction: Pick<Auction, 'eventId' | 'eventItemId' | 'productId'>): string {
    return `${auction.eventId}\u0000${auction.eventItemId}\u0000${auction.productId}`;
  }

  private reserveEventAllocation(auction: Auction, initialAvailableQty: number): void {
    const key = this.eventAllocationKey(auction);
    const available = this.eventAvailability.get(key) ?? this.readNonNegativeInt(initialAvailableQty, 'availableQty');
    if (available < auction.quantity) {
      throw new ConflictException(`Insufficient event allocation for ${auction.eventItemId}`);
    }
    this.eventAvailability.set(key, available - auction.quantity);
    auction.allocationState = 'held';
  }

  private releaseEventAllocation(auction: Auction): void {
    if (auction.allocationState === 'released') return;
    if (auction.allocationState === 'committed') throw new ConflictException('Paid auction allocation cannot be released');
    const key = this.eventAllocationKey(auction);
    this.eventAvailability.set(key, (this.eventAvailability.get(key) ?? 0) + auction.quantity);
    auction.allocationState = 'released';
  }

  private readId(value: string, field: string): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
    const id = value.trim();
    if (!id || id.length > 120) throw new BadRequestException(`${field} is required and must be 120 characters or fewer`);
    return id;
  }

  private readPositiveInt(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isInteger(value) || value <= 0 || value > max) {
      throw new BadRequestException(`${field} must be a positive integer no greater than ${max}`);
    }
    return value;
  }

  private readNonNegativeInt(value: number, field: string): number {
    if (!Number.isInteger(value) || value < 0) throw new BadRequestException(`${field} must be a non-negative integer`);
    return value;
  }

  private readMoney(value: number, field: string): number {
    if (!Number.isInteger(value) || value < 1 || value > MAX_AUCTION_AMOUNT_CENTS) {
      throw new BadRequestException(`${field} must be a positive integer no greater than ${MAX_AUCTION_AMOUNT_CENTS} cents`);
    }
    return value;
  }

  private readIdempotencyKey(value: string): string {
    const key = this.readId(value, 'idempotencyKey');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new BadRequestException('idempotencyKey must be 8–128 URL-safe characters');
    return key;
  }

  private findBidReplay(auction: Auction, bid: AuctionBid): AuctionBid | undefined {
    if (!bid.idempotencyKey) return undefined;
    const existing = auction.bids.find((candidate) => (
      candidate.bidderId === bid.bidderId && candidate.idempotencyKey === bid.idempotencyKey
    ));
    if (!existing) return undefined;
    if (existing.amountCents !== bid.amountCents || existing.displayName !== bid.displayName) {
      throw new ConflictException('Idempotency key was already used for a different bid');
    }
    return existing;
  }

  private readOptionalName(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim().length > 80) throw new BadRequestException('displayName must be 80 characters or fewer');
    return value.trim() || undefined;
  }
}
