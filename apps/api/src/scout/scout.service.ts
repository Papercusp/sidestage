import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CartService, type Cart } from '../cart/cart.service';
import {
  SCOUT_CATALOG,
  SCOUT_REPLY_MODEL,
  SCOUT_SESSION_STORE,
  SCOUT_TOOL_SEARCH_CATALOG,
  type ProductCard,
  type ScoutCatalog,
  type ScoutChatRequest,
  type ScoutChatResponse,
  type ScoutReplyModel,
  type ScoutSessionStore,
  type ScoutStreamEvent,
  type ScoutStreamRequest,
} from './scout.types';

const FALLBACK_REPLY = 'I need a little more detail to search the verified catalog.';

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

/**
 * Split a finished reply into wire-sized token slices.
 *
 * Whitespace is kept ON the preceding slice so concatenating every slice
 * reproduces the input EXACTLY — the client's reducer appends slices blindly
 * (`content + evt.content`), so any lost or duplicated space shows up as
 * mangled text in the drawer. Guarded by a round-trip test.
 */
export function chunkReply(text: string, wordsPerChunk = 3): string[] {
  if (!text) return [];
  const pieces = text.match(/\S+\s*/g);
  if (!pieces) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < pieces.length; i += wordsPerChunk) {
    chunks.push(pieces.slice(i, i + wordsPerChunk).join(''));
  }
  return chunks;
}

@Injectable()
export class ScoutService {
  constructor(
    @Inject(SCOUT_CATALOG) private readonly catalog: ScoutCatalog,
    @Inject(SCOUT_REPLY_MODEL) private readonly model: ScoutReplyModel,
    @Inject(CartService) private readonly carts: CartService,
    @Inject(SCOUT_SESSION_STORE) private readonly sessions?: ScoutSessionStore,
  ) {}

  async chat(input: ScoutChatRequest): Promise<ScoutChatResponse> {
    const message = input.message?.trim();
    if (!message) throw new Error('message is required');
    const started = Date.now();
    const { cart, products, reply } = await this.runTurn(message, input);
    return {
      reply,
      products,
      cart,
      cartId: cart.id,
      latencyMs: Math.max(0, Date.now() - started),
    };
  }

  /**
   * One turn as a stream of wire events — the reconnect-safe streaming
   * contract (P-007). Driven DETACHED by the turn bus, so this generator
   * outlives the SSE connection that started it and a dropped client resumes
   * from the channel's ring buffer rather than losing the turn.
   *
   * Event order is the contract the shared drawer's reducer folds:
   *   session → tool_start → products → token* → done
   * `tool_start` raises the transient status line, the first `token` clears it.
   */
  async *stream(input: ScoutStreamRequest): AsyncGenerator<ScoutStreamEvent> {
    const sessionId = input.sessionId?.trim() || this.createSessionId();
    yield { type: 'session', sessionId };

    const message = input.message?.trim();
    if (!message) {
      // Terminal, and deliberately specific: a blank turn is a caller bug, and
      // the generic "something went wrong" would send them hunting the server.
      yield { type: 'error', message: 'message is required' };
      return;
    }

    yield { type: 'tool_start', tool: SCOUT_TOOL_SEARCH_CATALOG };
    const cart = await this.resolveCart(input);
    const products = await this.catalog.search(message, productLimit(input));
    yield { type: 'products', products };

    const replyRequest = { message, products, cart, eventId: input.eventId };
    let reply = '';
    if (this.model.stream) {
      // Native incremental model: relay its real tokens.
      for await (const slice of this.model.stream(replyRequest)) {
        if (!slice) continue;
        reply += slice;
        yield { type: 'token', content: slice };
      }
      reply = reply.trim() || FALLBACK_REPLY;
      if (!reply) yield { type: 'token', content: FALLBACK_REPLY };
    } else {
      reply = (await this.model.generate(replyRequest)).trim() || FALLBACK_REPLY;
      for (const slice of chunkReply(reply)) yield { type: 'token', content: slice };
    }

    await this.persistTurn(sessionId, message, reply);
    yield { type: 'done' };
  }

  createSessionId(): string {
    return randomUUID();
  }

  /** The shared turn body — `chat()` and `stream()` must not drift apart. */
  private async runTurn(
    message: string,
    input: ScoutChatRequest,
  ): Promise<{ cart: Cart; products: ProductCard[]; reply: string }> {
    const cart = await this.carts.getCart(input.cartId);
    const products = await this.catalog.search(message, productLimit(input));
    const reply = (
      await this.model.generate({ message, products, cart, eventId: input.eventId })
    ).trim();
    return { cart, products, reply: reply || FALLBACK_REPLY };
  }

  /**
   * A stream turn resolves the cart only when the client names one.
   *
   * `getCart()` MINTS and persists a cart when called without an id, so
   * resolving unconditionally would create a throwaway cart row per anonymous
   * chat turn. The reply model only needs cart context, and an empty cart is
   * the honest representation of "this visitor has no cart".
   */
  private async resolveCart(input: ScoutStreamRequest): Promise<Cart> {
    const cartId = input.cartId?.trim();
    if (!cartId) return emptyCart();
    return (await this.carts.findCart(cartId)) ?? emptyCart(cartId);
  }

  /**
   * Persist the turn for the ETag'd transcript restore. Never fatal: a
   * transcript that fails to save must not destroy a reply the customer has
   * already watched stream in.
   */
  private async persistTurn(sessionId: string, message: string, reply: string): Promise<void> {
    if (!this.sessions) return;
    const ts = new Date().toISOString();
    try {
      await this.sessions.append(sessionId, [
        { role: 'user', content: message, ts },
        { role: 'assistant', content: reply, ts },
      ]);
    } catch {
      /* transcript restore degrades; the live turn is unaffected */
    }
  }
}

function productLimit(input: ScoutChatRequest): number {
  return Math.max(1, Math.min(input.maxProducts ?? 6, 20));
}

function emptyCart(id = ''): Cart {
  return {
    id,
    currency: 'USD',
    items: [],
    subtotalCents: 0,
    updatedAt: new Date().toISOString(),
  };
}
