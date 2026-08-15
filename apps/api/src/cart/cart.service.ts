import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ActionItemStore, StoredActionEventItem } from '../actions/action-item.store';
import { AUCTION_INVENTORY, type AuctionInventory, type InventoryHoldSource } from '../auction/auction.service';
import type { EventStore } from '../events/event.service';
import { buyerHoldExpiresAt } from '../inventory/hold-policy';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';

export const CART_STORE = Symbol('CART_STORE');

export interface CartItem {
  productId: string;
  title: string;
  priceCents: number;
  quantity: number;
  imageUrl?: string;
  expiresAt?: string;
  eventId?: string;
  eventItemId?: string;
}

export interface Cart {
  id: string;
  currency: 'USD';
  items: CartItem[];
  subtotalCents: number;
  updatedAt: string;
  /** Durable retry ledger for event holds, retained after the cart is emptied. */
  eventHoldKeys?: string[];
}

export interface CartStore {
  get(id: string): Promise<Cart | undefined>;
  set(cart: Cart): Promise<void>;
  /**
   * One event-aware transaction boundary. Durable stores must update the event
   * allocation, physical reservation, and cart payload atomically.
   */
  holdEventItem?(input: EventCartHoldInput): Promise<Cart>;
}

export interface EventCartHoldInput {
  cartId: string;
  eventId: string;
  eventItemId: string;
  productId: string;
  quantity: number;
  expiresAt: string;
  idempotencyKey: string;
  imageUrl?: string;
}

export function cloneCart(cart: Cart): Cart {
  return {
    ...cart,
    items: cart.items.map((item) => ({ ...item })),
    eventHoldKeys: cart.eventHoldKeys ? [...cart.eventHoldKeys] : undefined,
  };
}

export function summarizeCart(cart: Cart): Cart {
  return {
    ...cart,
    subtotalCents: cart.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The public clone starts with an in-memory store. The store boundary is
 * deliberate: the product-db lane can replace it with a Postgres adapter
 * without changing Scout, checkout, or the browser contract.
 */
@Injectable()
export class InMemoryCartStore implements CartStore {
  private readonly carts = new Map<string, Cart>();

  constructor(
    private readonly eventItems?: ActionItemStore,
    private readonly events?: EventStore,
    private readonly inventory?: AuctionInventory,
  ) {}

  async get(id: string): Promise<Cart | undefined> {
    const cart = this.carts.get(id);
    return cart ? cloneCart(cart) : undefined;
  }

  async set(cart: Cart): Promise<void> {
    this.carts.set(cart.id, cloneCart(cart));
  }

  async holdEventItem(input: EventCartHoldInput): Promise<Cart> {
    const event = await this.events?.findById(input.eventId);
    if (!event || event.status === 'draft' || !this.eventItems || !this.inventory) {
      throw new NotFoundException('Event item is not available');
    }
    const lineup = await this.eventItems.list(input.eventId);
    const item = lineup.find((candidate) => (
      candidate.eventItemId === input.eventItemId && candidate.productId === input.productId
    ));
    if (!item) throw new NotFoundException('Event item is not available');

    const cart = this.carts.get(input.cartId) ?? emptyCart(input.cartId);
    assertEventCartScope(cart, input.eventId);
    if (hasEventHoldKey(cart, input.idempotencyKey)) return cloneCart(cart);
    const existing = cart.items.find((candidate) => candidate.eventItemId === input.eventItemId);
    if (item.availableQty < input.quantity) {
      throw new ConflictException(`Insufficient event allocation for ${input.eventItemId}`);
    }

    const previousQuantity = existing?.quantity ?? 0;
    const nextQuantity = previousQuantity + input.quantity;
    assertEventCartQuantity(nextQuantity);
    const source: InventoryHoldSource = { kind: 'cart', id: input.cartId };
    const reserved = await this.inventory.reserve(
      input.productId,
      nextQuantity,
      source,
      input.expiresAt,
    );
    if (!reserved) throw new ConflictException(`Insufficient available quantity for ${input.productId}`);

    let updatedLineup: StoredActionEventItem[];
    try {
      updatedLineup = await this.eventItems.write(input.eventId, [{
        expectedVersion: item.version,
        item: { ...item, availableQty: item.availableQty - input.quantity },
      }]);
    } catch (error) {
      if (previousQuantity > 0) {
        await this.inventory.reserve(
          input.productId,
          previousQuantity,
          source,
          existing?.expiresAt,
        );
      } else {
        await this.inventory.release(input.productId, nextQuantity, source);
      }
      throw error;
    }

    const authoritative = updatedLineup.find((candidate) => candidate.eventItemId === input.eventItemId);
    if (!authoritative) throw new Error('Event lineup transaction lost its updated item');
    upsertEventCartItem(cart, authoritative, input, nextQuantity);
    recordEventHoldKey(cart, input.idempotencyKey);
    const updated = summarizeCart(cart);
    await this.set(updated);
    return cloneCart(updated);
  }
}

@Injectable()
export class CartService {
  constructor(
    @Inject(CART_STORE) private readonly store: CartStore,
    @Optional() @Inject(AUCTION_INVENTORY) private readonly inventory?: AuctionInventory,
    @Optional() @Inject(SyncInvalidationService) private readonly syncInvalidations?: SyncInvalidationService,
  ) {}

  async findCart(id: string): Promise<Cart | null> {
    const cart = await this.store.get(id);
    if (!cart) return null;
    const expired = cart.items.filter((item) => this.isExpired(item));
    if (expired.length === 0) return cloneCart(cart);
    await Promise.all(expired.map((item) => this.releaseReservation(cart.id, item)));
    cart.items = cart.items.filter((item) => !this.isExpired(item));
    const updated = summarizeCart(cart);
    await this.persist(updated);
    this.invalidateInventory(expired.map((item) => item.productId));
    return cloneCart(updated);
  }

  async getCart(id?: string): Promise<Cart> {
    if (id) {
      const existing = await this.findCart(id);
      if (existing) return existing;
    }

    const cart: Cart = {
      id: id?.trim() || randomUUID(),
      currency: 'USD',
      items: [],
      subtotalCents: 0,
      updatedAt: new Date().toISOString(),
    };
    await this.persist(cart);
    return cloneCart(cart);
  }

  async addItem(input: {
    cartId?: string;
    productId: string;
    title: string;
    priceCents: number;
    quantity?: number;
    imageUrl?: string;
    expiresAt?: string;
  }): Promise<Cart> {
    this.assertProduct(input.productId, input.title, input.priceCents);
    const quantity = this.assertQuantity(input.quantity ?? 1);
    const cart = await this.getCart(input.cartId);
    const existing = cart.items.find((item) => item.productId === input.productId);
    if (existing) {
      existing.quantity = this.assertQuantity(existing.quantity + quantity);
      existing.title = input.title;
      existing.priceCents = input.priceCents;
      existing.imageUrl = input.imageUrl ?? existing.imageUrl;
      existing.expiresAt = input.expiresAt ?? existing.expiresAt;
    } else {
      cart.items.push({
        productId: input.productId,
        title: input.title,
        priceCents: input.priceCents,
        quantity,
        imageUrl: input.imageUrl,
        expiresAt: input.expiresAt,
      });
    }
    const updated = summarizeCart(cart);
    await this.persist(updated);
    return cloneCart(updated);
  }

  async holdItem(input: {
    cartId?: string;
    productId: string;
    title: string;
    priceCents: number;
    quantity?: number;
    imageUrl?: string;
    eventId?: string;
    eventItemId?: string;
    idempotencyKey?: string;
  }): Promise<Cart> {
    const quantity = this.assertQuantity(input.quantity ?? 1);
    const eventContext = this.readEventContext(input);
    if (eventContext) {
      if (!this.store.holdEventItem) throw new Error('Event-aware cart storage is unavailable');
      const cartId = input.cartId?.trim();
      const idempotencyKey = input.idempotencyKey?.trim();
      if (!cartId || !idempotencyKey || idempotencyKey.length > 200) {
        throw new ConflictException('Event holds require a stable cart and request identity');
      }
      const updated = await this.store.holdEventItem({
        cartId,
        eventId: eventContext.eventId,
        eventItemId: eventContext.eventItemId,
        productId: input.productId.trim(),
        quantity,
        expiresAt: buyerHoldExpiresAt(),
        idempotencyKey,
        imageUrl: input.imageUrl,
      });
      this.invalidateEventHold(updated.id, eventContext.eventId, input.productId);
      return cloneCart(updated);
    }

    this.assertProduct(input.productId, input.title, input.priceCents);
    const cart = await this.getCart(input.cartId);
    const existing = cart.items.find((item) => item.productId === input.productId);
    const nextQuantity = this.assertQuantity((existing?.quantity ?? 0) + quantity);
    const expiresAt = buyerHoldExpiresAt();
    if (this.inventory) {
      const reserved = await this.inventory.reserve(input.productId, nextQuantity, this.holdSource(cart.id), expiresAt);
      if (!reserved) throw new ConflictException(`Insufficient available quantity for ${input.productId}`);
    }
    try {
      const updated = await this.addItem({ ...input, cartId: cart.id, expiresAt });
      if (this.inventory) this.invalidateInventory([input.productId]);
      return updated;
    } catch (error) {
      await this.inventory?.release(input.productId, nextQuantity, this.holdSource(cart.id));
      throw error;
    }
  }

  async setQuantity(cartId: string, productId: string, quantity: number): Promise<Cart> {
    const cart = await this.requireCart(cartId);
    const item = cart.items.find((candidate) => candidate.productId === productId);
    if (!item) throw new Error(`Product ${productId} is not in cart`);
    const nextQuantity = this.assertQuantity(quantity);
    if (this.inventory && item.expiresAt) {
      const reserved = await this.inventory.reserve(productId, nextQuantity, this.holdSource(cart.id), item.expiresAt);
      if (!reserved) throw new ConflictException(`Insufficient available quantity for ${productId}`);
    }
    item.quantity = nextQuantity;
    const updated = summarizeCart(cart);
    await this.persist(updated);
    if (this.inventory && item.expiresAt) this.invalidateInventory([productId]);
    return cloneCart(updated);
  }

  async removeItem(cartId: string, productId: string): Promise<Cart> {
    const cart = await this.requireCart(cartId);
    const heldItem = cart.items.find((item) => item.productId === productId);
    if (heldItem) await this.releaseReservation(cart.id, heldItem);
    cart.items = cart.items.filter((item) => item.productId !== productId);
    const updated = summarizeCart(cart);
    await this.persist(updated);
    if (heldItem?.expiresAt) this.invalidateInventory([productId]);
    return cloneCart(updated);
  }

  async commit(cartId: string): Promise<Cart> {
    const cart = await this.store.get(cartId);
    if (!cart) throw new Error('Cart is empty or not found');
    if (cart.items.length === 0) return cloneCart(cart);
    if (this.inventory) {
      await Promise.all(cart.items.map(async (item) => {
        if (!item.expiresAt) return;
        const committed = await this.inventory!.commit(item.productId, this.holdSource(cart.id));
        if (!committed) throw new Error(`Inventory hold for ${item.productId} could not be committed`);
      }));
    }
    const updated = summarizeCart({ ...cart, items: [] });
    await this.persist(updated);
    this.invalidateInventory(cart.items.filter((item) => item.expiresAt).map((item) => item.productId));
    return cloneCart(updated);
  }

  /** Releases every source-tracked hold in a cancelled checkout, idempotently. */
  async release(cartId: string): Promise<Cart> {
    const cart = await this.store.get(cartId);
    if (!cart) throw new Error('Cart is empty or not found');
    if (cart.items.length === 0) return cloneCart(cart);
    await Promise.all(cart.items.map((item) => this.releaseReservation(cart.id, item)));
    const updated = summarizeCart({ ...cart, items: [] });
    await this.persist(updated);
    this.invalidateInventory(cart.items.filter((item) => item.expiresAt).map((item) => item.productId));
    return cloneCart(updated);
  }

  private async persist(cart: Cart): Promise<void> {
    await this.store.set(cart);
    this.syncInvalidations?.invalidate('cart.byId', { cartId: cart.id });
  }

  private invalidateInventory(productIds: readonly string[]): void {
    const uniqueProductIds = new Set(productIds);
    if (uniqueProductIds.size === 0) return;
    // The seller Inventory tab reads reservation totals from catalog.page.
    // Invalidate the unscoped query once per mutation so every active search
    // refreshes when any buyer adds, changes, removes, commits, or expires a
    // hold; the per-product snapshot invalidations remain scoped below.
    this.syncInvalidations?.invalidate('catalog.page');
    for (const productId of uniqueProductIds) {
      this.syncInvalidations?.invalidate('inventory.snapshot', { productId });
    }
  }

  private invalidateEventHold(cartId: string, eventId: string, productId: string): void {
    this.syncInvalidations?.invalidate('cart.byId', { cartId });
    this.syncInvalidations?.invalidate('event.lineup.items', { eventId });
    this.syncInvalidations?.invalidate('event.actions.items', { eventId });
    this.invalidateInventory([productId]);
  }

  private async requireCart(id: string): Promise<Cart> {
    const cart = await this.findCart(id);
    if (!cart) throw new Error(`Cart ${id} was not found`);
    return cart;
  }

  private isExpired(item: CartItem): boolean {
    if (!item.expiresAt) return false;
    const deadline = Date.parse(item.expiresAt);
    return !Number.isFinite(deadline) || deadline <= Date.now();
  }

  private holdSource(cartId: string): InventoryHoldSource {
    return { kind: 'cart', id: cartId };
  }

  private readEventContext(input: { eventId?: string; eventItemId?: string }): {
    eventId: string;
    eventItemId: string;
  } | null {
    const eventId = input.eventId?.trim();
    const eventItemId = input.eventItemId?.trim();
    if (!eventId && !eventItemId) return null;
    if (!eventId || !eventItemId || eventId.length > 120 || eventItemId.length > 160) {
      throw new NotFoundException('Event item is not available');
    }
    return { eventId, eventItemId };
  }

  private async releaseReservation(cartId: string, item: CartItem): Promise<void> {
    if (!this.inventory || !item.expiresAt) return;
    await this.inventory.release(item.productId, item.quantity, this.holdSource(cartId));
  }

  private assertProduct(productId: string, title: string, priceCents: number): void {
    if (!productId.trim() || !title.trim() || !Number.isInteger(priceCents) || priceCents < 0) {
      throw new Error('A product id, title, and non-negative integer price are required');
    }
  }

  private assertQuantity(quantity: number): number {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new Error('Quantity must be an integer between 1 and 99');
    }
    return quantity;
  }
}

export function emptyCart(id: string): Cart {
  return {
    id,
    currency: 'USD',
    items: [],
    subtotalCents: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function assertEventCartScope(cart: Cart, eventId: string): void {
  if (cart.items.some((item) => !item.eventId || item.eventId !== eventId)) {
    throw new ConflictException('Empty the cart before shopping a different event');
  }
}

export function assertEventCartQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new ConflictException('Event cart quantity must be between 1 and 99');
  }
}

export function hasEventHoldKey(cart: Cart, idempotencyKey: string): boolean {
  return cart.eventHoldKeys?.includes(idempotencyKey) ?? false;
}

export function recordEventHoldKey(cart: Cart, idempotencyKey: string): void {
  cart.eventHoldKeys = [...(cart.eventHoldKeys ?? []), idempotencyKey];
}

export function upsertEventCartItem(
  cart: Cart,
  item: Pick<StoredActionEventItem, 'eventId' | 'eventItemId' | 'productId' | 'title' | 'priceCents'>,
  input: EventCartHoldInput,
  nextQuantity: number,
): void {
  const existing = cart.items.find((candidate) => candidate.eventItemId === input.eventItemId);
  const next: CartItem = {
    productId: item.productId,
    title: item.title,
    priceCents: item.priceCents,
    quantity: nextQuantity,
    imageUrl: input.imageUrl ?? existing?.imageUrl,
    expiresAt: input.expiresAt,
    eventId: item.eventId,
    eventItemId: item.eventItemId,
  };
  if (existing) Object.assign(existing, next);
  else cart.items.push(next);
}
