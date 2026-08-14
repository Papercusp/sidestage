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

export const SCOUT_CATALOG = Symbol('SCOUT_CATALOG');
export const SCOUT_REPLY_MODEL = Symbol('SCOUT_REPLY_MODEL');
export const SCOUT_SESSION_STORE = Symbol('SCOUT_SESSION_STORE');
