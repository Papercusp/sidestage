import {
  buildTurnBody,
  createHttpChatTransport,
  type ChatTransport,
  type HttpChatTransportOptions,
} from '@papercusp/scout-chat';
import type { BuyerProduct } from './buyer';
import { productDescriptionText } from './product-description-text';

export const SCOUT_BUYER_COOKIE = 'ss_buyer_id';
const SCOUT_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;
const SCOUT_BUYER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ScoutCookieDocument {
  cookie: string;
}

function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName !== name) continue;
    try {
      return decodeURIComponent(rawValue.join('='));
    } catch {
      return rawValue.join('=');
    }
  }
  return null;
}

/**
 * Preserve ordinary buyer ids verbatim and deterministically project the rare
 * D-013 id containing unicode/whitespace into the resolver's bounded keyspace.
 * There is deliberately no random fallback: Scout continuity is a function of
 * the selected demo buyer, never a second browser identity.
 */
export function scoutBuyerContinuityId(selectedBuyerId: string): string {
  const normalized = selectedBuyerId.trim();
  if (!normalized) throw new Error('Scout continuity requires a selected buyer');
  if (SCOUT_BUYER_ID.test(normalized)) return normalized;

  // Four independent 32-bit FNV-style lanes keep the synchronous browser seam
  // dependency-free while making collisions vanishingly unlikely for demo ids.
  const lanes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    for (let lane = 0; lane < lanes.length; lane += 1) {
      lanes[lane] = Math.imul(lanes[lane] ^ (code + lane * 0x9e37), 0x01000193) >>> 0;
    }
  }
  return `buyer-${lanes.map((value) => value.toString(16).padStart(8, '0')).join('')}`;
}

/**
 * Synchronize the deliberately unsigned continuity cookie with the selected
 * demo buyer. A null buyer is the explicit anonymous fallback and clears any
 * previous selected-buyer cookie instead of silently inheriting it.
 */
export function ensureScoutBuyerCookie(
  selectedBuyerId: string | null,
  cookieDocument: ScoutCookieDocument | null = typeof document === 'undefined' ? null : document,
): string | null {
  if (!cookieDocument) return null;
  if (!selectedBuyerId) {
    if (readCookie(cookieDocument.cookie, SCOUT_BUYER_COOKIE) !== null) {
      cookieDocument.cookie = `${SCOUT_BUYER_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
    }
    return null;
  }

  const selected = scoutBuyerContinuityId(selectedBuyerId);
  const existing = readCookie(cookieDocument.cookie, SCOUT_BUYER_COOKIE);
  if (existing === selected) return selected;

  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  cookieDocument.cookie = `${SCOUT_BUYER_COOKIE}=${encodeURIComponent(selected)}; Path=/; SameSite=Lax; Max-Age=${SCOUT_COOKIE_MAX_AGE_SEC}${secure}`;
  return selected;
}

export interface SideStageScoutPageContext {
  eventId?: string;
  cartId?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// Merchant HTML in catalog descriptions is projected to text by the shared
// boundary helper, so the Scout card path and the catalog browse path cannot
// drift apart on it (EI-20491379430268439).

/** Promote only SideStage's existing cart/event inputs; identity stays server-resolved. */
export const buildSideStageScoutBody: NonNullable<HttpChatTransportOptions['buildBody']> = (turn, resume) => {
  const base = buildTurnBody(turn, resume);
  if (resume || !turn.pageContext || typeof turn.pageContext !== 'object') return base;
  const context = turn.pageContext as Record<string, unknown>;
  const cartId = nonEmptyString(context.cartId);
  const eventId = nonEmptyString(context.eventId);
  return {
    ...base,
    ...(cartId ? { cartId } : {}),
    ...(eventId ? { eventId } : {}),
  };
};

/**
 * Fail a Scout turn after this much server silence. The API streams a heartbeat
 * on open and every 10s, so 25s tolerates two missed beats before giving up —
 * long enough never to cut a healthy slow turn, short enough that a stalled one
 * hands the composer back instead of locking it until a reload (WI-39716).
 */
export const SCOUT_IDLE_TIMEOUT_MS = 25_000;

export interface CreateSideStageScoutTransportOptions {
  buyerId?: string | null;
  fetchImpl?: typeof fetch;
  cookieDocument?: ScoutCookieDocument | null;
  /** Override the idle deadline (tests). Defaults to SCOUT_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
}

export function createSideStageScoutTransport(
  options: CreateSideStageScoutTransportOptions = {},
): ChatTransport {
  const cookieDocument = options.cookieDocument === undefined
    ? (typeof document === 'undefined' ? null : document)
    : options.cookieDocument;
  const activateBuyer = () => ensureScoutBuyerCookie(options.buyerId ?? null, cookieDocument);
  activateBuyer();
  const transport = createHttpChatTransport({
    chatUrl: '/api/scout/chat/stream',
    transcriptUrl: (sessionId) => `/api/scout/session/${encodeURIComponent(sessionId)}`,
    buildBody: buildSideStageScoutBody,
    idleTimeoutMs: options.idleTimeoutMs ?? SCOUT_IDLE_TIMEOUT_MS,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return {
    async *streamTurn(turn, streamOptions) {
      activateBuyer();
      yield* transport.streamTurn(turn, streamOptions);
    },
    transcriptFetcher(sessionId) {
      const fetcher = transport.transcriptFetcher(sessionId);
      return async (context) => {
        activateBuyer();
        return fetcher(context);
      };
    },
    answerCard: async () => {
      throw new Error('SideStage Scout does not support interactive cards');
    },
  };
}

export interface SideStageScoutProduct {
  productId: string;
  title: string;
  description: string;
  priceCents: number;
  availableQty: number;
  imageUrl?: string;
  attributes?: Record<string, string | number | boolean>;
}

export function scoutProductToBuyerProduct(value: unknown): BuyerProduct | null {
  if (!value || typeof value !== 'object') return null;
  const product = value as Partial<SideStageScoutProduct>;
  if (!nonEmptyString(product.productId) || !nonEmptyString(product.title)) return null;
  if (!Number.isFinite(product.priceCents) || !Number.isFinite(product.availableQty)) return null;
  return {
    id: product.productId!.trim(),
    title: product.title!.trim(),
    subtitle: productDescriptionText(product.description) ?? 'Verified SideStage catalog item',
    priceCents: Math.max(0, Math.round(product.priceCents!)),
    availableQty: Math.max(0, Math.floor(product.availableQty!)),
    ...(nonEmptyString(product.imageUrl) ? { imageUrl: product.imageUrl!.trim() } : {}),
  };
}
