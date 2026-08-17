import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import {
  memoryScopes,
  memoryScore,
  memoryTokens,
  MIN_MEMORY_RELEVANCE,
} from './scout-memory';
import {
  SCOUT_CATEGORIES,
  SCOUT_CATEGORY_PRODUCT_TYPES,
  SCOUT_CATALOG,
  SCOUT_MEMORY_STORE,
  SCOUT_REPLY_MODEL,
  SCOUT_RUNTIME_MODEL,
  SCOUT_SESSION_STORE,
  SCOUT_TOOL_GET_CART,
  SCOUT_TOOL_SEARCH_CATALOG,
  type ProductCard,
  type ScoutCatalog,
  type ScoutCategory,
  type ScoutChatRequest,
  type ScoutChatResponse,
  type ScoutIdentity,
  type ScoutMemory,
  type ScoutMemoryStore,
  type ScoutReplyModel,
  type ScoutSessionStore,
  type ScoutStreamEvent,
  type ScoutStreamRequest,
  parseScoutCategory,
} from './scout.types';

/** A turn with no resolved buyer — the guest default. */
const GUEST: ScoutIdentity = { buyerId: null };
const FALLBACK_REPLY = 'I need a little more detail to search the verified catalog.';

@Injectable()
export class DeterministicScoutReplyModel implements ScoutReplyModel {
  async generate(request: {
    message: string;
    products: readonly ProductCard[];
    // Read by `noMatchReply` below, so the entry point has to declare it — the
    // field exists on ScoutReplyRequest but this shape is deliberately looser
    // (an optional `cart`), so it is mirrored rather than reused (WI-39741).
    alternatives?: readonly ProductCard[];
    cart?: Cart;
    memories?: readonly ScoutMemory[];
  }): Promise<string> {
    const callback = recallCallback(request.memories);
    // A question about what the buyer is holding is answered from the cart the
    // request names — never from catalog matches on the question's own words,
    // which is how "what do I have held?" used to come back as a product list.
    if (isCartStateQuestion(request.message)) {
      return heldItemsReply(request.cart, callback);
    }
    if (request.products.length === 0) {
      return noMatchReply(request, callback);
    }
    const names = request.products.slice(0, 3).map((product) => product.title).join(', ');
    return `I found ${request.products.length} verified option${request.products.length === 1 ? '' : 's'}: ${names}.${callback} Pick one to add it to your cart.`;
  }
}

/**
 * Lead-ins a shopper wraps a product noun in. Stripped so the reply names the
 * SUBJECT ("laptops") rather than quoting the whole question back — echoing the
 * sentence made a correct "we don't carry that" read as a failed substring
 * search, which is how WI-39741 was reported.
 */
const SUBJECT_LEAD_IN =
  /^(?:hi\s+|hey\s+|hello\s+)?(?:do\s+you\s+(?:have|sell|carry|stock)|are\s+there|is\s+there|have\s+you\s+got|i'?m\s+looking\s+for|looking\s+for|show\s+me|find\s+me|can\s+i\s+(?:get|buy)|what\s+about|got|any)\s+/i;
const SUBJECT_TRAILER = /\s+(?:for\s+sale|in\s+stock|available|today|right\s+now|please)$/i;

/** The product noun a question is about, or null when we cannot tell. */
function searchSubject(message: string): string | null {
  let subject = message.trim().replace(/[?!.]+$/, '').trim();
  subject = subject.replace(SUBJECT_LEAD_IN, '').replace(SUBJECT_TRAILER, '').trim();
  subject = subject.replace(/^(?:any|some|a|an|the)\s+/i, '').trim();
  // Anything still sentence-length is not a noun phrase we can quote safely.
  if (!subject || subject === message.trim() || subject.split(/\s+/).length > 4) return null;
  return subject.toLowerCase();
}

/**
 * A no-match turn still knows what the catalog holds, so it says so. "No" plus
 * generic advice is an ungrounded answer when real inventory is in hand.
 */
function noMatchReply(
  request: { message: string; alternatives?: readonly ProductCard[] },
  callback: string,
): string {
  const subject = searchSubject(request.message);
  const lead = subject
    ? `I don't have any ${subject} in this event's catalog.`
    : "I couldn't find a match for that in this event's catalog.";
  const names = (request.alternatives ?? []).slice(0, 3).map((product) => product.title);
  if (names.length === 0) return `${lead}${callback} Try a brand, product type, or budget.`;
  return `${lead}${callback} What I do have includes ${names.join(', ')}. Want me to show one of those?`;
}

function recallCallback(memories: readonly ScoutMemory[] | undefined): string {
  const best = memories?.[0]?.text?.trim();
  return best ? ` Last time you asked about “${best}”.` : '';
}

/**
 * Questions about what the buyer is already holding, which Scout must answer
 * from cart state. These are deliberately anchored on a first-person subject
 * ("my", "I have", "am I") so an ordinary product search that merely mentions a
 * cart word — "cart organizer", "hold-down straps" — is NOT diverted here.
 */
const CART_STATE_PATTERNS: readonly RegExp[] = [
  /\b(?:what|which|anything|something)\b[^?]*\b(?:i|i've|ive)\b[^?]*\b(?:held|holding|hold|reserved)\b/i,
  /\bam\s+i\s+holding\b/i,
  /\bdo\s+i\s+have\b[^?]*\b(?:held|holding|hold|reserved|cart|basket)\b/i,
  /\bmy\s+(?:held\s+items?|holds?|cart|basket)\b/i,
  /\bheld\s+items?\b/i,
  /\bin\s+my\s+(?:cart|basket)\b/i,
  /\bcart\s+(?:contents|state|status|total)\b/i,
];

/** True when the message asks about the buyer's own held/cart state. */
export function isCartStateQuestion(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return CART_STATE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The held-items answer. An EMPTY cart is a real, useful answer here — the
 * defect this replaces treated "nothing held" as "nothing found in the
 * catalog" and fell through to unrelated product suggestions.
 */
function heldItemsReply(cart: Cart | undefined, callback: string): string {
  const items = cart?.items ?? [];
  if (items.length === 0) {
    return `You don't have any items held right now.${callback} Search the verified catalog and I'll hold something for you.`;
  }
  const held = items
    .slice(0, 3)
    .map((item) => (item.quantity > 1 ? `${item.title} ×${item.quantity}` : item.title))
    .join(', ');
  const more = items.length > 3 ? `, and ${items.length - 3} more` : '';
  return `You have ${items.length} item${items.length === 1 ? '' : 's'} held: ${held}${more}.${callback}`;
}

const CATEGORY_PATTERNS: ReadonlyArray<readonly [ScoutCategory, RegExp]> = [
  ['Laptop bags & cases', /\b(?:laptop|computer).*(?:bag|case|sleeve)|(?:bag|case|sleeve).*(?:laptop|computer)\b/i],
  ['Chargers & power adapters', /\b(?:charger|power adapter|power cord)\b/i],
  ['Docking stations', /\b(?:dock|docking station|multiport hub)\b/i],
  ['Cables', /\b(?:cable|cord)\b/i],
  ['Memory & RAM', /\b(?:memory|ram)\b/i],
  ['Storage & drives', /\b(?:storage|hard drive|ssd|flash drive)\b/i],
  ['Graphics cards', /\b(?:graphics card|video card|gpu)\b/i],
  ['Networking', /\b(?:router|network switch|networking)\b/i],
  ['Monitors', /\b(?:monitor|display)\b/i],
  ['Keyboards', /\bkeyboards?\b/i],
  ['Mice', /\b(?:mouse|mice)\b/i],
  ['Printers', /\bprinters?\b/i],
  ['Tablets', /\btablets?\b/i],
  ['Laptops', /\b(?:laptop|notebook)s?\b/i],
  ['Desktops', /\bdesktops?\b/i],
  ['Computers', /\bcomputers?\b/i],
  ['Speakers', /\bspeakers?\b/i],
  ['Headphones', /\b(?:headphones?|earbuds?)\b/i],
];

const CATEGORY_QUERY_TOKENS: Record<ScoutCategory, ReadonlySet<string>> = Object.fromEntries(
  SCOUT_CATEGORIES.map((category) => [category, new Set(memoryTokens(category))]),
) as unknown as Record<ScoutCategory, ReadonlySet<string>>;

const SEARCH_FILLER_TOKENS = new Set([
  'a', 'an', 'any', 'are', 'buy', 'do', 'find', 'for', 'get', 'have', 'i', 'im',
  'is', 'looking', 'me', 'need', 'please', 'show', 'some', 'the', 'there', 'to',
  'want', 'with', 'you',
]);

export function inferScoutCategory(message: string): ScoutCategory | undefined {
  return CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0];
}

export function categoryFreeSearchQuery(message: string, category: ScoutCategory): string {
  const categoryTokens = CATEGORY_QUERY_TOKENS[category];
  return memoryTokens(message)
    .filter((token) => !SEARCH_FILLER_TOKENS.has(token) && !categoryTokens.has(token))
    .join(' ');
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
  alternatives: ProductCard[];
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
            ? (() => {
              const category = inferScoutCategory(this.context.message);
              return {
                query: category
                  ? categoryFreeSearchQuery(this.context.message, category)
                  : this.context.message,
                ...(category ? { category } : {}),
                limit: productLimit(this.context.input),
              };
            })()
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
      alternatives: this.context.alternatives,
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
 * any answer. Once that bounded sequence is complete, the runner moves to its
 * existing tool-free final stream instead of letting a model loop on searches.
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
    if (!missing) return { content: '', toolCalls: [] };

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
  private readonly log = new Logger(ScoutService.name);

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
      alternatives: [],
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
    const history = await this.safeSessionMessages(identity.buyerId, sessionId);
    const messages: RuntimeMessage[] = [
      { role: 'system', content: systemPrompt(input, memories) },
      ...history,
      { role: 'user', content: message },
    ];
    const baseModel = this.runtimeModel
      ?? new LegacyReplyModelAdapter(this.fallbackModel, context);
    // A cart-state question is answered from the cart alone. Requiring a
    // catalog search here is what turned "what do I have held?" into search
    // terms, so the buyer got unrelated products instead of their own holds.
    const requiredTools = [
      ...(input.cartId?.trim() ? [SCOUT_TOOL_GET_CART] : []),
      ...(isCartStateQuestion(message) ? [] : [SCOUT_TOOL_SEARCH_CATALOG]),
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
        onError: (error) => {
          const detail = error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
          this.log.error(`Scout ${mode} turn ${sessionId} failed: ${detail}`);
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
        await this.persistTurn(identity.buyerId, sessionId, message, context.reply);
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
              query: {
                type: 'string',
                description: 'Brand, model, and specification terms only. Put the requested product type in category.',
              },
              category: {
                type: 'string',
                enum: [...SCOUT_CATEGORIES],
                description: 'The product type the shopper wants to buy. Accessories are separate from computers.',
              },
              limit: { type: 'integer', minimum: 1, maximum: 20 },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
        execute: async (args) => {
          const category = parseScoutCategory(args.category)
            ?? inferScoutCategory(context.message);
          const suppliedQuery = typeof args.query === 'string' ? args.query.trim() : undefined;
          const query = suppliedQuery ?? (category
            ? categoryFreeSearchQuery(context.message, category)
            : context.message);
          const requestedLimit = typeof args.limit === 'number' ? args.limit : undefined;
          const limit = Math.max(
            1,
            Math.min(Number.isInteger(requestedLimit) ? requestedLimit! : productLimit(context.input), 20),
          );
          context.products = await this.catalog.search(
            query,
            limit,
            category ? SCOUT_CATEGORY_PRODUCT_TYPES[category] : undefined,
          );
          if (context.products.length === 0) {
            // A no-match turn still has the catalog in hand. Grounding the
            // refusal in real rows is the difference between an answer that is
            // correct and one that READS broken (WI-39741).
            context.alternatives = await this.catalog.search('', 3).catch(() => []);
          }
          return {
            content: toJsonValue({ products: context.products }),
            events: [{ type: 'products', products: context.products }],
          };
        },
      },
    ];
  }

  private async safeSessionMessages(
    buyerId: string | null,
    sessionId: string,
  ): Promise<RuntimeMessage[]> {
    if (!this.sessions || !buyerId) return [];
    try {
      const session = await this.sessions.get(buyerId, sessionId);
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
      const recalled = await this.memory.recall(scopes, query);
      return recalled.filter((memory) => memoryScore(memory.text, query) >= MIN_MEMORY_RELEVANCE);
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

  private async persistTurn(
    buyerId: string | null,
    sessionId: string,
    message: string,
    reply: string,
  ): Promise<void> {
    if (!this.sessions || !buyerId || !reply) return;
    const ts = new Date().toISOString();
    try {
      await this.sessions.append(buyerId, sessionId, [
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
    'For search_catalog, keep brand/model/spec terms in query and choose the requested product category separately; accessories are not computers.',
    'Only describe products and availability returned by the tools in this turn.',
    input.cartId?.trim()
      ? 'The request names a cart. Read it with get_cart before answering about cart state.'
      : 'No cart was named. Do not invent cart contents.',
    isCartStateQuestion(input.message ?? '')
      ? 'This question is about the buyer\'s own held items. Answer it from get_cart only. Do not search the catalog and do not suggest products; if nothing is held, say plainly that nothing is held.'
      : '',
    input.eventId ? `Live event context: ${input.eventId}.` : '',
    recalled,
  ].filter(Boolean).join('\n');
}

function productLimit(input: Pick<ScoutChatRequest, 'maxProducts'>): number {
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
