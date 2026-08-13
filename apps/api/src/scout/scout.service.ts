import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CartService } from '../cart/cart.service';
import {
  SCOUT_CATALOG,
  SCOUT_REPLY_MODEL,
  type ProductCard,
  type ScoutCatalog,
  type ScoutChatRequest,
  type ScoutChatResponse,
  type ScoutReplyModel,
} from './scout.types';

@Injectable()
export class DeterministicScoutReplyModel implements ScoutReplyModel {
  async generate(request: { message: string; products: readonly ProductCard[] }): Promise<string> {
    if (request.products.length === 0) {
      return `I couldn't find a verified match for “${request.message}”. Try a brand, product type, or budget.`;
    }
    const names = request.products.slice(0, 3).map((product) => product.title).join(', ');
    return `I found ${request.products.length} verified option${request.products.length === 1 ? '' : 's'}: ${names}. Pick one to add it to your cart.`;
  }
}

@Injectable()
export class ScoutService {
  constructor(
    @Inject(SCOUT_CATALOG) private readonly catalog: ScoutCatalog,
    @Inject(SCOUT_REPLY_MODEL) private readonly model: ScoutReplyModel,
    @Inject(CartService) private readonly carts: CartService,
  ) {}

  async chat(input: ScoutChatRequest): Promise<ScoutChatResponse> {
    const message = input.message?.trim();
    if (!message) throw new Error('message is required');
    const started = Date.now();
    const cart = await this.carts.getCart(input.cartId);
    const limit = Math.max(1, Math.min(input.maxProducts ?? 6, 20));
    const products = await this.catalog.search(message, limit);
    const reply = (await this.model.generate({ message, products, cart, eventId: input.eventId })).trim();
    return {
      reply: reply || 'I need a little more detail to search the verified catalog.',
      products,
      cart,
      cartId: cart.id,
      latencyMs: Math.max(0, Date.now() - started),
    };
  }

  createSessionId(): string {
    return randomUUID();
  }
}
