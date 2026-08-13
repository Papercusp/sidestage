import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export const CART_STORE = Symbol('CART_STORE');

export interface CartItem {
  productId: string;
  title: string;
  priceCents: number;
  quantity: number;
  imageUrl?: string;
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
  constructor(@Inject(CART_STORE) private readonly store: CartStore) {}

  async findCart(id: string): Promise<Cart | null> {
    const cart = await this.store.get(id);
    return cart ? cloneCart(cart) : null;
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
    await this.store.set(cart);
    return cloneCart(cart);
  }

  async addItem(input: {
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
    if (existing) {
      existing.quantity = this.assertQuantity(existing.quantity + quantity);
      existing.title = input.title;
      existing.priceCents = input.priceCents;
      existing.imageUrl = input.imageUrl ?? existing.imageUrl;
    } else {
      cart.items.push({
        productId: input.productId,
        title: input.title,
        priceCents: input.priceCents,
        quantity,
        imageUrl: input.imageUrl,
      });
    }
    const updated = summarize(cart);
    await this.store.set(updated);
    return cloneCart(updated);
  }

  async setQuantity(cartId: string, productId: string, quantity: number): Promise<Cart> {
    const cart = await this.requireCart(cartId);
    const item = cart.items.find((candidate) => candidate.productId === productId);
    if (!item) throw new Error(`Product ${productId} is not in cart`);
    item.quantity = this.assertQuantity(quantity);
    const updated = summarize(cart);
    await this.store.set(updated);
    return cloneCart(updated);
  }

  async removeItem(cartId: string, productId: string): Promise<Cart> {
    const cart = await this.requireCart(cartId);
    cart.items = cart.items.filter((item) => item.productId !== productId);
    const updated = summarize(cart);
    await this.store.set(updated);
    return cloneCart(updated);
  }

  private async requireCart(id: string): Promise<Cart> {
    const cart = await this.findCart(id);
    if (!cart) throw new Error(`Cart ${id} was not found`);
    return cart;
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
