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
  /**
   * What this buyer has said before, recalled from long-term memory (P-012).
   *
   * ALWAYS present, and EMPTY is the normal case — a guest, a cold buyer, or a
   * degraded memory store all yield `[]`. A reply model must therefore treat
   * memories as decoration it can ignore, never as an input it requires.
   */
  memories?: readonly ScoutMemory[];
}

export interface ScoutReplyModel {
  generate(request: ScoutReplyRequest): Promise<string>;
  /**
   * Optional NATIVE token stream. A model that can produce text incrementally
   * (an LLM) implements this and the turn streams its real tokens; a model that
   * can only return a finished string (the deterministic one) omits it and the
   * service chunks `generate()`'s result instead. The seam is what keeps the
   * wire contract identical either way — the client cannot tell which it got.
   */
  stream?(request: ScoutReplyRequest): AsyncIterable<string>;
}

// ─── Streaming contract (P-007) ──────────────────────────────────────────────

/**
 * One event on the SSE turn stream, as consumed by `@papercusp/scout-chat`'s
 * `applyChatEvent` reducer — this union IS the wire contract, so a name added
 * here without a reducer case is an event the drawer silently drops.
 *
 * `done` and `error` are TERMINAL: the shared transport's default
 * `terminalTypes` ends the client iteration on either.
 */
export type ScoutStreamEvent =
  /** Session identity, emitted first so a fresh client learns its sessionId. */
  | { type: 'session'; sessionId: string }
  /** A server-side step began; the drawer shows a transient status line. */
  | { type: 'tool_start'; tool: string }
  /** An incremental slice of the assistant's reply. */
  | { type: 'token'; content: string }
  /** The verified catalog cards for this turn. */
  | { type: 'products'; products: ProductCard[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** The tool name emitted before the catalog lookup (maps to a client status line). */
export const SCOUT_TOOL_SEARCH_CATALOG = 'search_catalog';

/**
 * The tool name emitted before the cart read (P-012).
 *
 * Restart's scout reaches its cart over HTTP because the cart lives in another
 * service; SideStage's `CartService` is in THIS Nest app, so the tool is a
 * direct call rather than a proxy. The wire event is identical either way,
 * which is the point: the drawer shows the same status line.
 */
export const SCOUT_TOOL_GET_CART = 'get_cart';

/**
 * One turn as posted to `POST /scout/chat/stream`.
 *
 * A RESUME request carries `turnId` (+ `lastEventId`, or the `Last-Event-ID`
 * header) and NOTHING else — the server re-attaches to the running turn and
 * replays what the dropped connection missed, so `message` is absent on a
 * resume by design.
 */
export interface ScoutStreamRequest extends ScoutChatRequest {
  sessionId?: string;
  /** App-defined page-awareness payload; carried for future turns, unused today. */
  pageContext?: unknown;
  turnId?: string;
  lastEventId?: number;
}

// ─── Durable transcript ──────────────────────────────────────────────────────

export interface ScoutMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

export interface ScoutSession {
  id: string;
  messages: ScoutMessage[];
  /** ISO timestamp of the last append — half of the transcript's ETag version. */
  lastActiveAt: string;
}

/**
 * Durable transcript storage. Mirrors the other SideStage store seams: a
 * Postgres implementation when the pool is reachable, an in-memory one
 * otherwise, chosen in the module factory.
 */
export interface ScoutSessionStore {
  get(id: string): Promise<ScoutSession | null>;
  /** Append messages to (creating if absent) a session; returns the new state. */
  append(id: string, messages: readonly ScoutMessage[]): Promise<ScoutSession>;
}

// ─── Long-term memory (P-012, D-008) ─────────────────────────────────────────

export interface ScoutMemory {
  id: string;
  /** `user:<buyerId>` for one buyer's own memories, `store` for shared facts. */
  scope: string;
  kind: string;
  text: string;
}

/**
 * Scope-keyed long-term memory.
 *
 * The CONTRACT is ported from Restart's MemoryService; the MECHANISM is not
 * (D-008). Restart recalls by pgvector cosine distance over OpenAI embeddings;
 * SideStage has neither extension nor embedding provider, so the Postgres
 * implementation recalls LEXICALLY over the full-text/trigram machinery this
 * schema already uses. Callers must not assume paraphrase-tolerant recall.
 *
 * **Degrade-safe is the load-bearing property, not an optimization.** Memory is
 * an enhancement layer on a turn, never a dependency of one: every method
 * swallows its own failures, so `recall` yields `[]` and `remember` drops the
 * write rather than letting a slow or broken store take down a reply the
 * customer is already watching stream in. (The catalog search path is the
 * opposite — fail-loud — because a wrong product IS a wrong answer.)
 */
export interface ScoutMemoryStore {
  /** Persist one memory. Best-effort: failure is swallowed, never thrown. */
  remember(scope: string, text: string, kind?: string): Promise<void>;
  /** Top-k memories across `scopes` matching `query`. Failure yields `[]`. */
  recall(scopes: readonly string[], query: string, k?: number): Promise<ScoutMemory[]>;
}

// ─── Identity (P-012, D-009) ─────────────────────────────────────────────────

/**
 * Who the server believes is asking — resolved from the REQUEST, never from
 * the request body.
 *
 * `buyerId` null means "no continuity identity" (a guest): memory is then read
 * store-scoped and written nowhere.
 *
 * ⚠ Read D-009 before treating this as a security boundary. Today the id comes
 * from an UNSIGNED cookie, so it is self-asserted: this delivers per-visitor
 * CONTINUITY, not authentication. Nothing sensitive belongs in scout memory
 * until this resolver is backed by a verified session.
 */
export interface ScoutIdentity {
  buyerId: string | null;
}

/**
 * The seam D-009 establishes so the trust boundary exists structurally BEFORE
 * SideStage has auth. Swapping this one provider for a session-verifying
 * implementation is the whole future auth change; no service code moves.
 */
export interface ScoutIdentityResolver {
  resolve(headers: Record<string, string | string[] | undefined>): ScoutIdentity;
}

export const SCOUT_CATALOG = Symbol('SCOUT_CATALOG');
export const SCOUT_REPLY_MODEL = Symbol('SCOUT_REPLY_MODEL');
export const SCOUT_SESSION_STORE = Symbol('SCOUT_SESSION_STORE');
export const SCOUT_MEMORY_STORE = Symbol('SCOUT_MEMORY_STORE');
export const SCOUT_IDENTITY_RESOLVER = Symbol('SCOUT_IDENTITY_RESOLVER');
