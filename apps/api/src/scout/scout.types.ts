import type { Cart } from '../cart/cart.service';

export interface ProductCard {
  productId: string;
  title: string;
  description: string;
  priceCents: number;
  availableQty: number;
  imageUrl?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface ScoutChatRequest {
  message: string;
  cartId?: string;
  eventId?: string;
  maxProducts?: number;
}

export interface ScoutChatResponse {
  reply: string;
  products: ProductCard[];
  cart: Cart;
  cartId: string;
  latencyMs: number;
}

export interface ScoutCatalog {
  search(query: string, limit: number): Promise<ProductCard[]>;
}

export interface ScoutReplyRequest {
  message: string;
  products: readonly ProductCard[];
  cart: Cart;
  eventId?: string;
}

export interface ScoutReplyModel {
  generate(request: ScoutReplyRequest): Promise<string>;
}

export const SCOUT_CATALOG = Symbol('SCOUT_CATALOG');
export const SCOUT_REPLY_MODEL = Symbol('SCOUT_REPLY_MODEL');
