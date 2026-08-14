import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  runScoutTurn,
  type JsonObject,
  type JsonValue,
  type ScoutMessage as RuntimeMessage,
  type ScoutModelAdapter,
  type ScoutModelRequest,
  type ScoutModelResponse,
  type ScoutModelStreamEvent,
  type ScoutTool,
} from '@papercusp/scout-runtime';
import { CartService, type Cart } from '../cart/cart.service';
import { memoryScopes } from './scout-memory';
import {
  SCOUT_CATALOG,
  SCOUT_MEMORY_STORE,
  SCOUT_REPLY_MODEL,
  SCOUT_RUNTIME_MODEL,
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
    const callback = recallCallback(request.memories);
    if (request.products.length === 0) {
      return `I couldn't find a verified match for “${request.message}”.${callback} Try a brand, product type, or budget.`;
    }
    const names = request.products.slice(0, 3).map((product) => product.title).join(', ');
    return `I found ${request.products.length} verified option${request.products.length === 1 ? '' : 's'}: ${names}.${callback} Pick one to add it to your cart.`;
  }
}

function recallCallback(memories: readonly ScoutMemory[] | undefined): string {
  const best = memories?.[0]?.text?.trim();
  return best ? ` Last time you asked about “${best}”.` : '';
}

/** Split a finished fallback reply without changing a single whitespace byte. */
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

interface ScoutTurnContext {
  readonly input: ScoutStreamRequest;
  readonly identity: ScoutIdentity;
  readonly mode: 'chat' | 'stream';
  readonly sessionId: string;
  readonly message: string;
  readonly memories: readonly ScoutMemory[];
  readonly writeScope: string | null;
  products: ProductCard[];
  cart: Cart;
  reply: string;
  error?: string;
}

/**
 * Offline adapter retained for unit tests and clean clones without Vertex
 * credentials. It still runs through the shared runtime; only the final prose
 * comes from SideStage's deterministic legacy model.
 */
class LegacyReplyModelAdapter implements ScoutModelAdapter {
  readonly model = 'sidestage-deterministic';

  constructor(
    private readonly legacy: ScoutReplyModel,
    private readonly context: ScoutTurnContext,
  ) {}

  async complete(request: ScoutModelRequest): Promise<ScoutModelResponse> {
    if (request.toolChoice === 'required' && request.tools[0]) {
      const tool = request.tools[0];
      return {
        content: '',
        toolCalls: [{
          id: `${tool.name}-${randomUUID()}`,
          name: tool.name,
          args: tool.name === SCOUT_TOOL_SEARCH_CATALOG
            ? { query: this.context.message, limit: productLimit(this.context.input) }
            : {},
        }],
      };
    }
    return { content: '', toolCalls: [] };
  }

  async *stream(): AsyncGenerator<ScoutModelStreamEvent> {
    const request = {
      message: this.context.message,
      products: this.context.products,
      cart: this.context.cart,
      eventId: this.context.input.eventId,
      memories: this.context.memories,
    };
    if (this.legacy.stream) {
      for await (const text of this.legacy.stream(request)) {
        if (text) yield { type: 'text', text };
      }
      return;
    }
    const reply = (await this.legacy.generate(request)).trim() || FALLBACK_REPLY;
    for (const text of chunkReply(reply)) yield { type: 'text', text };
  }
}

/**
 * Makes the application invariants explicit at the runtime seam. A cart named
 * by the client is read first, then the canonical catalog is searched before
 * any answer. Vertex still chooses every later tool round itself.
 */
class RequiredToolSequenceModel implements ScoutModelAdapter {
  readonly model: string;

  constructor(
    private readonly delegate: ScoutModelAdapter,
    private readonly requiredTools: readonly string[],
  ) {
    this.model = delegate.model;
  }

  async complete(request: ScoutModelRequest): Promise<ScoutModelResponse> {
    const missing = this.requiredTools.find((name) => !request.messages.some(
      (message) => message.role === 'tool' && message.toolName === name,
    ));
    if (!missing) return this.delegate.complete(request);

    const tool = request.tools.find((candidate) => candidate.name === missing);
    if (!tool) throw new Error(`Required Scout tool is unavailable: ${missing}`);
    const response = await this.delegate.complete({
      ...request,
      tools: [tool],
      toolChoice: 'required',
    });
    if (!response.toolCalls.some((call) => call.name === missing)) {
      throw new Error(`Scout model did not call required tool: ${missing}`);
    }
    return response;
  }

  stream(request: ScoutModelRequest): AsyncIterable<ScoutModelStreamEvent> {
    return this.delegate.stream(request);
  }
}

@Injectable()
export class ScoutService {
  constructor(
    @Inject(SCOUT_CATALOG) private readonly catalog: ScoutCatalog,
    @Inject(SCOUT_REPLY_MODEL) private readonly fallbackModel: ScoutReplyModel,
    @Inject(CartService) private readonly carts: CartService,
    @Inject(SCOUT_MEMORY_STORE) private readonly memory: ScoutMemoryStore,
    @Inject(SCOUT_SESSION_STORE) private readonly sessions?: ScoutSessionStore,
    @Optional() @Inject(SCOUT_RUNTIME_MODEL) private readonly runtimeModel?: ScoutModelAdapter,
  ) {}

  async chat(input: ScoutChatRequest, identity: ScoutIdentity = GUEST): Promise<ScoutChatResponse> {
    const started = Date.now();
    const turn = this.executeTurn(
      { ...input, sessionId: this.createSessionId() },
      identity,
      'chat',
    );
    const result = await drainTurn(turn);
    if (result.error) throw new Error(result.error);
    if (!result.cart.id) result.cart = await this.carts.getCart(input.cartId);
    return {
      reply: result.reply,
      products: result.products,
      cart: result.cart,
      cartId: result.cart.id,
      latencyMs: Math.max(0, Date.now() - started),
    };
  }

  /** Preserve the existing reconnect-safe SideStage SSE event contract. */
  async *stream(
    input: ScoutStreamRequest,
    identity: ScoutIdentity = GUEST,
  ): AsyncGenerator<ScoutStreamEvent> {
    const turn = this.executeTurn(input, identity, 'stream');
    while (true) {
      const step = await turn.next();
      if (step.done) return;
      yield step.value;
    }
  }

  createSessionId(): string {
    return randomUUID();
  }

  private async *executeTurn(
    input: ScoutStreamRequest,
    identity: ScoutIdentity,
    mode: ScoutTurnContext['mode'],
  ): AsyncGenerator<ScoutStreamEvent, ScoutTurnContext> {
    const sessionId = input.sessionId?.trim() || this.createSessionId();
    const message = input.message?.trim() ?? '';
    const { scopes, writeScope } = memoryScopes(identity.buyerId);
    const context: ScoutTurnContext = {
      input,
      identity,
      mode,
      sessionId,
      message,
      memories: [],
      writeScope,
      products: [],
      cart: emptyCart(input.cartId?.trim()),
      reply: '',
    };

    yield { type: 'session', sessionId };
    if (!message) {
      context.error = 'message is required';
      yield { type: 'error', message: context.error };
      return context;
    }

    const memories = await this.safeRecall(scopes, message);
    // Context is local to this turn, so replacing the readonly view is safe and
    // prevents the runtime from owning the memory store itself.
    (context as { memories: readonly ScoutMemory[] }).memories = memories;
    const history = await this.safeSessionMessages(sessionId);
    const messages: RuntimeMessage[] = [
      { role: 'system', content: systemPrompt(input, memories) },
      ...history,
      { role: 'user', content: message },
    ];
    const baseModel = this.runtimeModel
      ?? new LegacyReplyModelAdapter(this.fallbackModel, context);
    const requiredTools = [
      ...(input.cartId?.trim() ? [SCOUT_TOOL_GET_CART] : []),
      SCOUT_TOOL_SEARCH_CATALOG,
    ];
    const model = new RequiredToolSequenceModel(baseModel, requiredTools);

    for await (const event of runScoutTurn({
      model,
      messages,
      tools: this.createTools(context),
      context,
      maxToolRounds: 6,
      forceToolOnFirstRound: true,
      hooks: {
        onMessage: (runtimeMessage) => {
          if (runtimeMessage.role === 'assistant' && !runtimeMessage.toolCalls?.length) {
            context.reply = runtimeMessage.content.trim() || FALLBACK_REPLY;
          }
        },
      },
    })) {
      if (event.type === 'app') {
        yield event.event;
      } else if (event.type === 'tool_start') {
        yield { type: 'tool_start', tool: event.name };
      } else if (event.type === 'token') {
        yield { type: 'token', content: event.content };
      } else if (event.type === 'error') {
        context.error = event.message;
        yield { type: 'error', message: event.message };
        return context;
      } else {
        if (mode === 'chat' && !context.cart.id) {
          context.cart = await this.carts.getCart(input.cartId);
        }
        await this.persistTurn(sessionId, message, context.reply);
        await this.rememberTurn(writeScope, message);
        yield { type: 'done' };
        return context;
      }
    }

    context.error = 'Scout turn ended without a terminal event';
    yield { type: 'error', message: context.error };
    return context;
  }

  private createTools(context: ScoutTurnContext): ScoutTool<ScoutTurnContext, ScoutStreamEvent>[] {
    return [
      {
        definition: {
          name: SCOUT_TOOL_GET_CART,
          description: 'Read the cart named by the trusted SideStage request context.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        execute: async () => {
          const cartId = context.input.cartId?.trim();
          context.cart = context.mode === 'chat'
            ? await this.carts.getCart(cartId)
            : cartId
              ? (await this.carts.findCart(cartId)) ?? emptyCart(cartId)
              : emptyCart();
          return { content: toJsonValue(context.cart) };
        },
      },
      {
        definition: {
          name: SCOUT_TOOL_SEARCH_CATALOG,
          description: 'Search the canonical SideStage catalog and return verified sellable products.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What the shopper wants to find.' },
              limit: { type: 'integer', minimum: 1, maximum: 20 },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
        execute: async (args) => {
          const query = typeof args.query === 'string' && args.query.trim()
            ? args.query.trim()
            : context.message;
          const requestedLimit = typeof args.limit === 'number' ? args.limit : undefined;
          const limit = Math.max(
            1,
            Math.min(Number.isInteger(requestedLimit) ? requestedLimit! : productLimit(context.input), 20),
          );
          context.products = await this.catalog.search(query, limit);
          return {
            content: toJsonValue({ products: context.products }),
            events: [{ type: 'products', products: context.products }],
          };
        },
      },
    ];
  }

  private async safeSessionMessages(sessionId: string): Promise<RuntimeMessage[]> {
    if (!this.sessions) return [];
    try {
      const session = await this.sessions.get(sessionId);
      return (session?.messages ?? []).map((message) => ({
        role: message.role,
        content: message.content,
      }));
    } catch {
      return [];
    }
  }

  private async safeRecall(scopes: string[], query: string): Promise<ScoutMemory[]> {
    try {
      return await this.memory.recall(scopes, query);
    } catch {
      return [];
    }
  }

  private async rememberTurn(writeScope: string | null, message: string): Promise<void> {
    if (!writeScope) return;
    try {
      await this.memory.remember(writeScope, message, 'turn');
    } catch {
      // Memory is an enhancement; its failure cannot eat a completed answer.
    }
  }

  private async persistTurn(sessionId: string, message: string, reply: string): Promise<void> {
    if (!this.sessions || !reply) return;
    const ts = new Date().toISOString();
    try {
      await this.sessions.append(sessionId, [
        { role: 'user', content: message, ts },
        { role: 'assistant', content: reply, ts },
      ]);
    } catch {
      // Transcript restore degrades; the live turn is unaffected.
    }
  }
}

async function drainTurn(
  turn: AsyncGenerator<ScoutStreamEvent, ScoutTurnContext>,
): Promise<ScoutTurnContext> {
  while (true) {
    const step = await turn.next();
    if (step.done) return step.value;
  }
}

function systemPrompt(input: ScoutStreamRequest, memories: readonly ScoutMemory[]): string {
  const recalled = memories.length === 0
    ? 'No prior buyer memories were recalled.'
    : `Relevant buyer memories:\n${memories.map((memory) => `- ${memory.text}`).join('\n')}`;
  return [
    'You are SideStage Scout, a concise shopping assistant.',
    'Use search_catalog before making any product claim or recommendation.',
    'Only describe products and availability returned by the tools in this turn.',
    input.cartId?.trim()
      ? 'The request names a cart. Read it with get_cart before answering about cart state.'
      : 'No cart was named. Do not invent cart contents.',
    input.eventId ? `Live event context: ${input.eventId}.` : '',
    recalled,
  ].filter(Boolean).join('\n');
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

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
