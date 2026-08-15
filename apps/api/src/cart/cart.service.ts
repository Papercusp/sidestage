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
  /** Server-verified owner for every buyer-facing cart aggregate. */
  buyerId?: string;
  currency: 'USD';
  items: CartItem[];
  subtotalCents: number;
  updatedAt: string;
  /** Monotonic aggregate revision; absent only on carts written before event-cart support. */
  revision?: number;
  /** Durable retry ledger for event holds, retained after the cart is emptied. */
  eventHoldKeys?: string[];
  /** Makes a retried terminal transition idempotent without applying its allocation delta twice. */
  eventTerminalTransition?: EventCartTerminalTransition;
}

export type EventCartTerminalState = 'released' | 'committed';

export interface EventCartTerminalTransition {
  eventId: string;
  state: EventCartTerminalState;
  sourceRevision: string;
}

export interface CartStore {
  get(id: string): Promise<Cart | undefined>;
  set(cart: Cart): Promise<void>;
  /**
   * One event-aware transaction boundary. Durable stores must update the event
   * allocation, physical reservation, and cart payload atomically.
   */
  holdEventItem?(input: EventCartHoldInput): Promise<Cart>;
  setEventItemQuantity?(input: EventCartQuantityInput): Promise<Cart>;
  releaseEventCart?(input: EventCartTerminalInput): Promise<Cart>;
  commitEventCart?(input: EventCartTerminalInput): Promise<Cart>;
}

export interface EventCartHoldInput {
  cartId: string;
  buyerId?: string;
  eventId: string;
  eventItemId: string;
  productId: string;
  quantity: number;
  expiresAt: string;
  idempotencyKey: string;
  imageUrl?: string;
}

export interface EventCartQuantityInput {
  cartId: string;
  eventId: string;
  eventItemId: string;
  productId: string;
  /** Zero removes the item and releases its event and physical allocation. */
  quantity: number;
  expectedRevision: string;
}

export interface EventCartTerminalInput {
  cartId: string;
  eventId: string;
  expectedRevision?: string;
}

export function cloneCart(cart: Cart): Cart {
  return {
    ...cart,
    items: cart.items.map((item) => ({ ...item })),
    eventHoldKeys: cart.eventHoldKeys ? [...cart.eventHoldKeys] : undefined,
    eventTerminalTransition: cart.eventTerminalTransition
      ? { ...cart.eventTerminalTransition }
      : undefined,
  };
}

export function summarizeCart(cart: Cart): Cart {
  return {
    ...cart,
    subtotalCents: cart.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0),
    updatedAt: new Date().toISOString(),
    revision: (cart.revision ?? 0) + 1,
  };
}

export function cartRevision(cart: Cart): string {
  return `${cart.id}:${cart.revision ?? 0}:${cart.updatedAt}`;
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
    const existing = this.carts.get(cart.id);
    if (existing && existing.buyerId !== cart.buyerId && (existing.buyerId || cart.buyerId)) {
      throw new NotFoundException('Cart was not found for this buyer');
    }
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

    const cart = this.carts.get(input.cartId) ?? emptyCart(input.cartId, input.buyerId);
    if (input.buyerId) assertCartOwner(cart, input.buyerId);
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
    cart.eventTerminalTransition = undefined;
    const updated = summarizeCart(cart);
    await this.set(updated);
    return cloneCart(updated);
  }

  async setEventItemQuantity(input: EventCartQuantityInput): Promise<Cart> {
    if (!this.eventItems || !this.inventory) throw new Error('Event-aware cart storage is unavailable');
    const cart = this.requireStoredCart(input.cartId);
    assertExpectedCartRevision(cart, input.expectedRevision);
    assertEventCartScope(cart, input.eventId);
    const existing = cart.items.find((candidate) => (
      candidate.eventId === input.eventId
      && candidate.eventItemId === input.eventItemId
      && candidate.productId === input.productId
    ));
    if (!existing) throw new NotFoundException('Event cart item is not available');
    assertEventCartTargetQuantity(input.quantity);
    if (existing.quantity === input.quantity) return cloneCart(cart);

    const lineup = await this.eventItems.list(input.eventId);
    const item = lineup.find((candidate) => (
      candidate.eventItemId === input.eventItemId && candidate.productId === input.productId
    ));
    if (!item) throw new NotFoundException('Event cart item is not available');
    const delta = input.quantity - existing.quantity;
    if (delta > 0 && item.availableQty < delta) {
      throw new ConflictException(`Insufficient event allocation for ${input.eventItemId}`);
    }

    const source: InventoryHoldSource = { kind: 'cart', id: input.cartId };
    const physicalChanged = input.quantity === 0
      ? await this.inventory.release(input.productId, existing.quantity, source)
      : await this.inventory.reserve(input.productId, input.quantity, source, existing.expiresAt);
    if (!physicalChanged && !(input.quantity === 0 && cartItemDeadlinePassed(existing))) {
      throw new ConflictException(`Inventory hold for ${input.productId} changed; reload the cart and retry`);
    }

    let updatedLineup: StoredActionEventItem[];
    try {
      updatedLineup = await this.eventItems.write(input.eventId, [{
        expectedVersion: item.version,
        item: { ...item, availableQty: item.availableQty - delta },
      }]);
    } catch (error) {
      await this.inventory.reserve(input.productId, existing.quantity, source, existing.expiresAt);
      throw error;
    }

    if (input.quantity === 0) {
      cart.items = cart.items.filter((candidate) => candidate !== existing);
    } else {
      const authoritative = updatedLineup.find((candidate) => candidate.eventItemId === input.eventItemId);
      if (!authoritative) throw new Error('Event lineup transaction lost its updated item');
      existing.quantity = input.quantity;
      existing.title = authoritative.title;
      existing.priceCents = authoritative.priceCents;
    }
    const updated = summarizeCart(cart);
    await this.set(updated);
    return cloneCart(updated);
  }

  async releaseEventCart(input: EventCartTerminalInput): Promise<Cart> {
    return this.transitionEventCart(input, 'released');
  }

  async commitEventCart(input: EventCartTerminalInput): Promise<Cart> {
    return this.transitionEventCart(input, 'committed');
  }

  private async transitionEventCart(
    input: EventCartTerminalInput,
    state: EventCartTerminalState,
  ): Promise<Cart> {
    if (!this.eventItems || !this.inventory) throw new Error('Event-aware cart storage is unavailable');
    const cart = this.requireStoredCart(input.cartId);
    const replay = terminalTransitionReplay(cart, input, state);
    if (replay) return replay;
    assertExpectedCartRevision(cart, input.expectedRevision);
    const context = requireEventCartContext(cart);
    if (context.eventId !== input.eventId) throw new ConflictException('Event cart context changed');

    if (state === 'released') {
      const lineup = await this.eventItems.list(input.eventId);
      const changes = cart.items.map((cartItem) => {
        const item = lineup.find((candidate) => (
          candidate.eventItemId === cartItem.eventItemId && candidate.productId === cartItem.productId
        ));
        if (!item) throw new ConflictException('Event cart allocation changed; reload the cart and retry');
        return {
          expectedVersion: item.version,
          item: { ...item, availableQty: item.availableQty + cartItem.quantity },
        };
      });
      for (const item of cart.items) {
        const released = await this.inventory.release(
          item.productId,
          item.quantity,
          { kind: 'cart', id: cart.id },
        );
        if (!released && !cartItemDeadlinePassed(item)) {
          throw new ConflictException(`Inventory hold for ${item.productId} changed; reload the cart and retry`);
        }
      }
      await this.eventItems.write(input.eventId, changes);
    } else {
      for (const item of cart.items) {
        const committed = await this.inventory.commit(item.productId, { kind: 'cart', id: cart.id });
        if (!committed) throw new ConflictException(`Inventory hold for ${item.productId} could not be committed`);
      }
    }

    const sourceRevision = input.expectedRevision ?? cartRevision(cart);
    cart.items = [];
    cart.eventTerminalTransition = { eventId: input.eventId, state, sourceRevision };
    const updated = summarizeCart(cart);
    await this.set(updated);
    return cloneCart(updated);
  }

  private requireStoredCart(id: string): Cart {
    const cart = this.carts.get(id);
    if (!cart) throw new NotFoundException(`Cart ${id} was not found`);
    return cloneCart(cart);
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
    let cart = await this.store.get(id);
    if (!cart) return null;
    const expiredEventItems = cart.items.filter((item) => this.isExpired(item) && isEventCartItem(item));
    for (const item of expiredEventItems) {
      if (!this.store.setEventItemQuantity) throw new Error('Event-aware cart storage is unavailable');
      cart = await this.store.setEventItemQuantity({
        cartId: cart.id,
        eventId: item.eventId!,
        eventItemId: item.eventItemId!,
        productId: item.productId,
        quantity: 0,
        expectedRevision: cartRevision(cart),
      });
      this.invalidateEventCart(cart.id, item.eventId!, [item.productId]);
    }

    const expiredLegacyItems = cart.items.filter((item) => this.isExpired(item));
    if (expiredLegacyItems.length === 0) return cloneCart(cart);
    await Promise.all(expiredLegacyItems.map((item) => this.releaseReservation(cart.id, item)));
    cart.items = cart.items.filter((item) => !this.isExpired(item));
    const updated = summarizeCart(cart);
    await this.persist(updated);
    this.invalidateInventory(expiredLegacyItems.map((item) => item.productId));
    return cloneCart(updated);
  }

  async findCartForBuyer(id: string, buyerId: string): Promise<Cart | null> {
    const stored = await this.store.get(id);
    if (!stored) return null;
    assertCartOwner(stored, buyerId);
    return this.findCart(id);
  }

  async getCart(id?: string, buyerId?: string): Promise<Cart> {
    if (id) {
      if (buyerId) {
        const stored = await this.store.get(id);
        if (stored) assertCartOwner(stored, buyerId);
      }
      const existing = await this.findCart(id);
      if (existing) {
        return existing;
      }
    }

    const cart = emptyCart(id?.trim() || randomUUID(), buyerId);
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
    buyerId?: string;
  }): Promise<Cart> {
    this.assertProduct(input.productId, input.title, input.priceCents);
    const quantity = this.assertQuantity(input.quantity ?? 1);
    const cart = await this.getCart(input.cartId, input.buyerId);
    if (cart.items.some(isEventCartItem)) {
      throw new ConflictException('Empty the cart before adding a product outside the event');
    }
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
    buyerId?: string;
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
        buyerId: input.buyerId,
        eventId: eventContext.eventId,
        eventItemId: eventContext.eventItemId,
        productId: input.productId.trim(),
        quantity,
        expiresAt: buyerHoldExpiresAt(),
        idempotencyKey,
        imageUrl: input.imageUrl,
      });
      this.invalidateEventCart(updated.id, eventContext.eventId, [input.productId]);
      return cloneCart(updated);
    }

    this.assertProduct(input.productId, input.title, input.priceCents);
    const cart = await this.getCart(input.cartId, input.buyerId);
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

  async holdItemForBuyer(
    input: Omit<Parameters<CartService['holdItem']>[0], 'buyerId'>,
    buyerId: string,
  ): Promise<Cart> {
    return this.holdItem({ ...input, buyerId: requireBuyerId(buyerId) });
  }

  async setQuantity(
    cartId: string,
    productId: string,
    quantity: number,
    buyerId?: string,
  ): Promise<Cart> {
    const cart = await this.requireCart(cartId, buyerId);
    const item = cart.items.find((candidate) => candidate.productId === productId);
    if (!item) throw new Error(`Product ${productId} is not in cart`);
    const nextQuantity = this.assertQuantity(quantity);
    if (isEventCartItem(item)) {
      if (!this.store.setEventItemQuantity) throw new Error('Event-aware cart storage is unavailable');
      const updated = await this.store.setEventItemQuantity({
        cartId: cart.id,
        eventId: item.eventId!,
        eventItemId: item.eventItemId!,
        productId: item.productId,
        quantity: nextQuantity,
        expectedRevision: cartRevision(cart),
      });
      this.invalidateEventCart(updated.id, item.eventId!, [item.productId]);
      return cloneCart(updated);
    }
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

  async setQuantityForBuyer(
    cartId: string,
    productId: string,
    quantity: number,
    buyerId: string,
  ): Promise<Cart> {
    return this.setQuantity(cartId, productId, quantity, requireBuyerId(buyerId));
  }

  async removeItem(cartId: string, productId: string, buyerId?: string): Promise<Cart> {
    const cart = await this.requireCart(cartId, buyerId);
    const heldItem = cart.items.find((item) => item.productId === productId);
    if (heldItem && isEventCartItem(heldItem)) {
      if (!this.store.setEventItemQuantity) throw new Error('Event-aware cart storage is unavailable');
      const updated = await this.store.setEventItemQuantity({
        cartId: cart.id,
        eventId: heldItem.eventId!,
        eventItemId: heldItem.eventItemId!,
        productId: heldItem.productId,
        quantity: 0,
        expectedRevision: cartRevision(cart),
      });
      this.invalidateEventCart(updated.id, heldItem.eventId!, [heldItem.productId]);
      return cloneCart(updated);
    }
    if (heldItem) await this.releaseReservation(cart.id, heldItem);
    cart.items = cart.items.filter((item) => item.productId !== productId);
    const updated = summarizeCart(cart);
    await this.persist(updated);
    if (heldItem?.expiresAt) this.invalidateInventory([productId]);
    return cloneCart(updated);
  }

  async removeItemForBuyer(cartId: string, productId: string, buyerId: string): Promise<Cart> {
    return this.removeItem(cartId, productId, requireBuyerId(buyerId));
  }

  async commit(cartId: string, expectedRevision?: string): Promise<Cart> {
    const cart = await this.store.get(cartId);
    if (!cart) throw new Error('Cart is empty or not found');
    if (cart.items.length === 0 && cart.eventTerminalTransition) {
      return terminalTransitionReplay(cart, {
        cartId,
        eventId: cart.eventTerminalTransition.eventId,
        expectedRevision,
      }, 'committed')!;
    }
    const eventContext = eventCartContext(cart);
    if (eventContext) {
      if (!this.store.commitEventCart) throw new Error('Event-aware cart storage is unavailable');
      const updated = await this.store.commitEventCart({
        cartId,
        eventId: eventContext.eventId,
        expectedRevision,
      });
      this.invalidateEventCart(cartId, eventContext.eventId, cart.items.map((item) => item.productId));
      return cloneCart(updated);
    }
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
  async release(cartId: string, expectedRevision?: string): Promise<Cart> {
    const cart = await this.store.get(cartId);
    if (!cart) throw new Error('Cart is empty or not found');
    if (cart.items.length === 0 && cart.eventTerminalTransition) {
      return terminalTransitionReplay(cart, {
        cartId,
        eventId: cart.eventTerminalTransition.eventId,
        expectedRevision,
      }, 'released')!;
    }
    const eventContext = eventCartContext(cart);
    if (eventContext) {
      if (!this.store.releaseEventCart) throw new Error('Event-aware cart storage is unavailable');
      const updated = await this.store.releaseEventCart({
        cartId,
        eventId: eventContext.eventId,
        expectedRevision,
      });
      this.invalidateEventCart(cartId, eventContext.eventId, cart.items.map((item) => item.productId));
      return cloneCart(updated);
    }
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

  private invalidateEventCart(cartId: string, eventId: string, productIds: readonly string[]): void {
    this.syncInvalidations?.invalidate('cart.byId', { cartId });
    this.syncInvalidations?.invalidate('event.lineup.items', { eventId });
    this.syncInvalidations?.invalidate('event.actions.items', { eventId });
    this.invalidateInventory(productIds);
  }

  private async requireCart(id: string, buyerId?: string): Promise<Cart> {
    if (buyerId) {
      const stored = await this.store.get(id);
      if (!stored) throw new Error(`Cart ${id} was not found`);
      assertCartOwner(stored, buyerId);
    }
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

export function emptyCart(id: string, buyerId?: string): Cart {
  return {
    id,
    ...(buyerId ? { buyerId: requireBuyerId(buyerId) } : {}),
    currency: 'USD',
    items: [],
    subtotalCents: 0,
    updatedAt: new Date().toISOString(),
    revision: 0,
  };
}

export function assertCartOwner(cart: Cart, buyerId: string): void {
  if (cart.buyerId !== requireBuyerId(buyerId)) {
    throw new NotFoundException('Cart was not found for this buyer');
  }
}

function requireBuyerId(value: string): string {
  const buyerId = value.trim();
  if (!buyerId) throw new NotFoundException('Cart was not found for this buyer');
  return buyerId;
}

export function isEventCartItem(item: CartItem): boolean {
  return Boolean(item.eventId || item.eventItemId);
}

export function eventCartContext(cart: Cart): { eventId: string } | null {
  if (cart.items.length === 0) return null;
  const eventItems = cart.items.filter(isEventCartItem);
  if (eventItems.length === 0) return null;
  if (eventItems.length !== cart.items.length) {
    throw new ConflictException('Event carts cannot contain products outside the event');
  }
  const eventIds = new Set(eventItems.map((item) => item.eventId).filter(Boolean));
  if (eventIds.size !== 1 || eventItems.some((item) => !item.eventId || !item.eventItemId)) {
    throw new ConflictException('Event cart context is incomplete or mixed');
  }
  return { eventId: [...eventIds][0]! };
}

export function requireEventCartContext(cart: Cart): { eventId: string } {
  const context = eventCartContext(cart);
  if (!context) throw new ConflictException('Event cart is empty or no longer active');
  return context;
}

export function assertExpectedCartRevision(cart: Cart, expectedRevision?: string): void {
  if (expectedRevision && cartRevision(cart) !== expectedRevision) {
    throw new ConflictException('Event cart changed; reload the cart and retry');
  }
}

export function assertEventCartTargetQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
    throw new ConflictException('Event cart quantity must be between 0 and 99');
  }
}

export function terminalTransitionReplay(
  cart: Cart,
  input: EventCartTerminalInput,
  state: EventCartTerminalState,
): Cart | null {
  const terminal = cart.eventTerminalTransition;
  if (cart.items.length > 0 || !terminal) return null;
  if (
    terminal.eventId === input.eventId
    && terminal.state === state
    && (!input.expectedRevision || terminal.sourceRevision === input.expectedRevision)
  ) {
    return cloneCart(cart);
  }
  throw new ConflictException(`Event cart was already ${terminal.state}`);
}

function cartItemDeadlinePassed(item: CartItem): boolean {
  if (!item.expiresAt) return false;
  const expiresAt = Date.parse(item.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
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
