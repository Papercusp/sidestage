import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CartService, type Cart } from '../cart/cart.service';
import { memoryScopes } from './scout-memory';
import {
  SCOUT_CATALOG,
  SCOUT_MEMORY_STORE,
  SCOUT_REPLY_MODEL,
  SCOUT_SESSION_STORE,
  SCOUT_TOOL_GET_CART,
  SCOUT_TOOL_SEARCH_CATALOG,
  type ProductCard,
  type ScoutCatalog,
  type ScoutChatRequest,
  type ScoutChatResponse,
  type ScoutIdentity,
  type ScoutMemory,
  type ScoutMemoryStore,
  type ScoutReplyModel,
  type ScoutSessionStore,
  type ScoutStreamEvent,
  type ScoutStreamRequest,
} from './scout.types';

/** A turn with no resolved buyer — the guest default. */
const GUEST: ScoutIdentity = { buyerId: null };

const FALLBACK_REPLY = 'I need a little more detail to search the verified catalog.';

@Injectable()
export class DeterministicScoutReplyModel implements ScoutReplyModel {
  async generate(request: {
    message: string;
    products: readonly ProductCard[];
    memories?: readonly ScoutMemory[];
  }): Promise<string> {
    // Memory is decoration, never a requirement: an empty recall (a guest, a
    // cold buyer, a degraded store) must produce exactly the reply this model
    // produced before memory existed.
    const callback = recallCallback(request.memories);
    if (request.products.length === 0) {
      return `I couldn't find a verified match for “${request.message}”.${callback} Try a brand, product type, or budget.`;
    }
    const names = request.products.slice(0, 3).map((product) => product.title).join(', ');
    return `I found ${request.products.length} verified option${request.products.length === 1 ? '' : 's'}: ${names}.${callback} Pick one to add it to your cart.`;
  }
}

/**
 * A one-clause nod to the most relevant thing this buyer said before, or ''.
 *
 * Kept to the single best hit: a deterministic model that recites every recalled
 * memory turns a helpful callback into a wall of the customer's own words.
 */
function recallCallback(memories: readonly ScoutMemory[] | undefined): string {
  const best = memories?.[0]?.text?.trim();
  return best ? ` Last time you asked about “${best}”.` : '';
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
    @Inject(SCOUT_MEMORY_STORE) private readonly memory: ScoutMemoryStore,
    @Inject(SCOUT_SESSION_STORE) private readonly sessions?: ScoutSessionStore,
  ) {}

  async chat(input: ScoutChatRequest, identity: ScoutIdentity = GUEST): Promise<ScoutChatResponse> {
    const message = input.message?.trim();
    if (!message) throw new Error('message is required');
    const started = Date.now();
    const { cart, products, reply } = await this.runTurn(message, input, identity);
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
  async *stream(
    input: ScoutStreamRequest,
    identity: ScoutIdentity = GUEST,
  ): AsyncGenerator<ScoutStreamEvent> {
    const sessionId = input.sessionId?.trim() || this.createSessionId();
    yield { type: 'session', sessionId };

    const message = input.message?.trim();
    if (!message) {
      // Terminal, and deliberately specific: a blank turn is a caller bug, and
      // the generic "something went wrong" would send them hunting the server.
      yield { type: 'error', message: 'message is required' };
      return;
    }

    const { scopes, writeScope } = memoryScopes(identity.buyerId);

    // The cart read is a real server-side step, so it gets a real status line.
    // Only when the client named a cart: `resolveCart` returns an empty cart
    // otherwise, and announcing a tool that did not run would put a lie on the
    // wire that the drawer faithfully renders.
    const wantsCart = Boolean(input.cartId?.trim());
    if (wantsCart) yield { type: 'tool_start', tool: SCOUT_TOOL_GET_CART };
    const cart = await this.resolveCart(input);

    yield { type: 'tool_start', tool: SCOUT_TOOL_SEARCH_CATALOG };
    const [products, memories] = await Promise.all([
      this.catalog.search(message, productLimit(input)),
      this.safeRecall(scopes, message),
    ]);
    yield { type: 'products', products };

    const replyRequest = { message, products, cart, eventId: input.eventId, memories };
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
    await this.rememberTurn(writeScope, message);
    yield { type: 'done' };
  }

  /**
   * Write this turn into the buyer's long-term memory.
   *
   * `writeScope` is null for a guest and nothing is written — the isolation
   * rule from D-009/`memoryScopes`: a visitor with no identity must not pour
   * turns into the shared `store` scope that every other visitor recalls.
   *
   * What gets remembered is the buyer's own message, not the reply. Restart
   * extracts memories with an LLM `remember` tool; SideStage's reply model is
   * deterministic, so the honest port is to keep the buyer's actual words —
   * which is what makes a later "what was I looking at?" recallable — and let
   * the store seam carry a smarter extractor when a model exists.
   */
  private async rememberTurn(writeScope: string | null, message: string): Promise<void> {
    if (!writeScope) return;
    try {
      await this.memory.remember(writeScope, message, 'turn');
    } catch {
      /* see safeRecall: the guarantee lives here, not in the store */
    }
  }

  /**
   * Recall, with the degrade guarantee enforced HERE rather than trusted.
   *
   * `ScoutMemoryStore` documents that implementations swallow their own
   * failures, and the two shipped stores do — but "memory never breaks a turn"
   * is a property of the TURN, so it cannot rest on every present and future
   * implementor remembering to honour a comment. A store that throws (a bug, a
   * third-party one, a future embedding client) would otherwise take down a
   * reply the customer is already watching stream in. Guarded by tests that
   * drive the turn with a store throwing from both methods.
   */
  private async safeRecall(scopes: string[], query: string): Promise<ScoutMemory[]> {
    try {
      return await this.memory.recall(scopes, query);
    } catch {
      return [];
    }
  }

  createSessionId(): string {
    return randomUUID();
  }

  /** The shared turn body — `chat()` and `stream()` must not drift apart. */
  private async runTurn(
    message: string,
    input: ScoutChatRequest,
    identity: ScoutIdentity,
  ): Promise<{ cart: Cart; products: ProductCard[]; reply: string }> {
    const { scopes, writeScope } = memoryScopes(identity.buyerId);
    const cart = await this.carts.getCart(input.cartId);
    const [products, memories] = await Promise.all([
      this.catalog.search(message, productLimit(input)),
      this.safeRecall(scopes, message),
    ]);
    const reply = (
      await this.model.generate({ message, products, cart, eventId: input.eventId, memories })
    ).trim();
    await this.rememberTurn(writeScope, message);
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
