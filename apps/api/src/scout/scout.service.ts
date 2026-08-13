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
export class InMemoryScoutCatalog implements ScoutCatalog {
  private readonly products: ProductCard[] = [
    {
      productId: 'demo-espresso-new',
      title: 'Barista Pro Espresso Machine',
      description: 'Compact dual-boiler espresso machine with an integrated grinder and steam wand.',
      priceCents: 49999,
      availableQty: 12,
      imageUrl: 'https://placehold.co/640x640/png?text=Barista+Pro',
      attributes: { brand: 'BrewHaus', color: 'stainless', powerWatts: 1600 },
    },
    {
      productId: 'demo-headphones-black',
      title: 'Cloud ANC Wireless Headphones',
      description: 'Over-ear wireless headphones with adaptive noise cancellation and a 30-hour battery.',
      priceCents: 19999,
      availableQty: 24,
      imageUrl: 'https://placehold.co/640x640/png?text=Cloud+ANC',
      attributes: { brand: 'Northstar Audio', color: 'black', batteryHours: 30 },
    },
    {
      productId: 'demo-creator-camera',
      title: 'Creator 4K Mirrorless Camera',
      description: 'Lightweight mirrorless camera with 4K60 video, a flip screen, and USB-C streaming.',
      priceCents: 89999,
      availableQty: 6,
      imageUrl: 'https://placehold.co/640x640/png?text=Creator+4K',
      attributes: { brand: 'FrameForge', mount: 'E', video: '4K60' },
    },
  ];

  async search(query: string, limit: number): Promise<ProductCard[]> {
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const ranked = this.products
      .map((product) => {
        const haystack = `${product.title} ${product.description} ${Object.values(product.attributes).join(' ')}`.toLowerCase();
        const score = tokens.length === 0 ? 0 : tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
        return { product, score };
      })
      .filter(({ score }) => tokens.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title));
    return ranked.slice(0, limit).map(({ product }) => ({ ...product, attributes: { ...product.attributes } }));
  }
}

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
    private readonly carts: CartService,
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
