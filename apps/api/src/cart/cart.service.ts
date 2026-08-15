import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AUCTION_INVENTORY, type AuctionInventory, type InventoryHoldSource } from '../auction/auction.service';
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
}

export interface Cart {
  id: string;
  currency: 'USD';
  items: CartItem[];
  subtotalCents: number;
  updatedAt: string;
}

export interface CartStore {
  get(id: string): Promise<Cart | undefined>;
  set(cart: Cart): Promise<void>;
}

function cloneCart(cart: Cart): Cart {
  return { ...cart, items: cart.items.map((item) => ({ ...item })) };
}

function summarize(cart: Cart): Cart {
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

  async get(id: string): Promise<Cart | undefined> {
    const cart = this.carts.get(id);
    return cart ? cloneCart(cart) : undefined;
  }

  async set(cart: Cart): Promise<void> {
    this.carts.set(cart.id, cloneCart(cart));
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
    const updated = summarize(cart);
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
    const updated = summarize(cart);
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
  }): Promise<Cart> {
    this.assertProduct(input.productId, input.title, input.priceCents);
    const quantity = this.assertQuantity(input.quantity ?? 1);
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
    const updated = summarize(cart);
    await this.persist(updated);
    if (this.inventory && item.expiresAt) this.invalidateInventory([productId]);
    return cloneCart(updated);
  }

  async removeItem(cartId: string, productId: string): Promise<Cart> {
    const cart = await this.requireCart(cartId);
    const heldItem = cart.items.find((item) => item.productId === productId);
    if (heldItem) await this.releaseReservation(cart.id, heldItem);
    cart.items = cart.items.filter((item) => item.productId !== productId);
    const updated = summarize(cart);
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
    const updated = summarize({ ...cart, items: [] });
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
    const updated = summarize({ ...cart, items: [] });
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
