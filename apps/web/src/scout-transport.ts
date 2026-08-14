import {
  buildTurnBody,
  createHttpChatTransport,
  type ChatTransport,
  type HttpChatTransportOptions,
} from '@papercusp/scout-chat';
import type { BuyerProduct } from './buyer';

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

function generatedScoutBuyerId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `scout-${uuid}` : `scout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Establish the deliberately unsigned continuity cookie from D-009/D-010.
 * This is an opaque browser id, not the app's impersonatable demo identity.
 */
export function ensureScoutBuyerCookie(
  cookieDocument: ScoutCookieDocument | null = typeof document === 'undefined' ? null : document,
  randomId: () => string = generatedScoutBuyerId,
): string | null {
  if (!cookieDocument) return null;
  const existing = readCookie(cookieDocument.cookie, SCOUT_BUYER_COOKIE);
  if (existing && SCOUT_BUYER_ID.test(existing)) return existing;

  const generated = randomId();
  if (!SCOUT_BUYER_ID.test(generated)) throw new Error('Scout continuity id must be URL-safe and at most 128 characters');
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  cookieDocument.cookie = `${SCOUT_BUYER_COOKIE}=${encodeURIComponent(generated)}; Path=/; SameSite=Lax; Max-Age=${SCOUT_COOKIE_MAX_AGE_SEC}${secure}`;
  return generated;
}

export interface SideStageScoutPageContext {
  eventId?: string;
  cartId?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

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

export interface CreateSideStageScoutTransportOptions {
  fetchImpl?: typeof fetch;
  cookieDocument?: ScoutCookieDocument | null;
  randomId?: () => string;
}

export function createSideStageScoutTransport(
  options: CreateSideStageScoutTransportOptions = {},
): ChatTransport {
  ensureScoutBuyerCookie(
    options.cookieDocument === undefined
      ? (typeof document === 'undefined' ? null : document)
      : options.cookieDocument,
    options.randomId,
  );
  const transport = createHttpChatTransport({
    chatUrl: '/api/scout/chat/stream',
    transcriptUrl: (sessionId) => `/api/scout/session/${encodeURIComponent(sessionId)}`,
    buildBody: buildSideStageScoutBody,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return {
    ...transport,
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
    subtitle: nonEmptyString(product.description) ?? 'Verified SideStage catalog item',
    priceCents: Math.max(0, Math.round(product.priceCents!)),
    availableQty: Math.max(0, Math.floor(product.availableQty!)),
    ...(nonEmptyString(product.imageUrl) ? { imageUrl: product.imageUrl!.trim() } : {}),
  };
}
