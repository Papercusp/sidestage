import { resolveApiBaseUrl, type CatalogVariant } from '../catalog';
import type { EventCreationPayload } from '../event-creation/catalog';

export type SellerActionKind = 'markdown' | 'targeted-offer' | 'push' | 'swap' | 'stock-adjust';

export interface SellerEventItem {
  eventId: string;
  eventItemId: string;
  productId: string;
  title: string;
  description?: string;
  priceCents: number;
  availableQty: number;
  quantity: number;
  onStage?: boolean;
  attributes: Record<string, string | number | boolean>;
}

export interface SellerEventPolicy {
  automationLevel: 'suggest' | 'confirm' | 'auto';
  allowAutoActions: boolean;
  priceFloorCentsByProduct: Record<string, number>;
  maxMarkdownPercent: number;
  blockedActionKinds: readonly string[];
  tone: 'concise' | 'warm' | 'professional';
}

export interface SellerEventSetup {
  eventId: string;
  name: string;
  policy: SellerEventPolicy;
  items: SellerEventItem[];
}

export interface SellerActionResult {
  auditId: string;
  status: 'executed';
  state: SellerEventItem;
  offer?: {
    id: string;
    eventId: string;
    eventItemId: string;
    productId: string;
    buyerId: string;
    priceCents: number;
    quantity: number;
    status: 'pending' | 'accepted' | 'expired' | 'cancelled';
  };
}

export interface SellerAuction {
  id: string;
  eventId: string;
  eventItemId: string;
  productId: string;
  quantity: number;
  startingPriceCents: number;
  currentPriceCents: number;
  status: 'active' | 'closed';
  startedAt: string;
  endsAt: string;
}

interface EventConfigResponse {
  eventId: string;
  name: string;
  /** Absent when the seller never uploaded one — the renderer falls back. */
  thumbnailUrl?: string;
  policy: SellerEventPolicy;
}

interface ActionProposal {
  kind: SellerActionKind;
  productId: string;
  buyerId?: string;
  quantity?: number;
  priceCents?: number;
  swapToProductId?: string;
  reason: string;
}

/**
 * A failed event-API response, carrying the HTTP status STRUCTURALLY.
 *
 * Callers need to tell "this event has no config" (a 404 — ordinary, expected)
 * apart from "the API is broken" (a 5xx — an outage). Before this, the status
 * existed only inside a message string, so the one caller that swallows errors
 * could not distinguish them and swallowed both. See fetchEventThumbnailUrl.
 */
export class EventApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EventApiError';
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: unknown } | null;
    const message = typeof body?.message === 'string'
      ? body.message
      : `Seller event request failed: HTTP ${response.status}`;
    throw new EventApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export function sellerEventId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'new-event';
}

function eventUrl(path: string, apiBaseUrl?: string): string {
  return `${resolveApiBaseUrl(apiBaseUrl)}${path}`;
}

async function fetchEventConfig(eventId: string, apiBaseUrl?: string): Promise<EventConfigResponse> {
  return requestJson<EventConfigResponse>(
    eventUrl(`/events/${encodeURIComponent(eventId)}/config`, apiBaseUrl),
  );
}

/**
 * The event's thumbnail, for buyer-facing surfaces.
 *
 * A thumbnail is decoration, so this NEVER rejects: an unreachable API or an
 * event with no config yet resolves to undefined and the caller renders its
 * placeholder. Letting it throw would put a failed decoration fetch on the same
 * footing as a failed inventory hold, and the buyer view would surface an error
 * for a missing picture.
 *
 * But NEVER REJECTING IS NOT THE SAME AS NEVER REPORTING, and conflating the two
 * cost real time: GET /events/:id/config once 500'd for every event on the site
 * (the database was missing the P-114 policy tables) and this function returned
 * undefined for all of them. A total API outage rendered as the placeholder glyph
 * and read as "these events have no thumbnails". Nothing anywhere said otherwise.
 *
 * So the swallow now discriminates. A 4xx is the expected, boring case — no
 * config for this event — and stays silent. A 5xx or a transport failure is the
 * app telling us something is broken, and gets reported to the console while the
 * UI still degrades gracefully.
 */
export async function fetchEventThumbnailUrl(
  eventId: string,
  apiBaseUrl?: string,
): Promise<string | undefined> {
  try {
    return (await fetchEventConfig(eventId, apiBaseUrl)).thumbnailUrl;
  } catch (error) {
    const status = error instanceof EventApiError ? error.status : undefined;
    // 4xx: this event simply has no config. Expected — say nothing.
    if (status !== undefined && status < 500) return undefined;
    // 5xx or a transport error: the API is failing. Never let that pass silently
    // as decoration — it is the shape of an outage.
    console.error(
      `[events] thumbnail fetch failed for "${eventId}" — the events API is not healthy` +
        `${status !== undefined ? ` (HTTP ${status})` : ''}. ` +
        'Rendering the placeholder, but this is an API failure, not a missing image.',
      error,
    );
    return undefined;
  }
}

/* ── The event directory, for the buyer Channel Guide (P-118 / D-019) ─────── */

/** One row of the "What's on" guide, as served by GET /events. */
export interface GuideEvent {
  eventId: string;
  title: string;
  sellerId: string;
  sellerName: string;
  /** Only the buyer-visible states reach the client; `draft` is filtered API-side. */
  status: 'live' | 'scheduled' | 'ended';
  startsAt: string | null;
  endedAt: string | null;
  thumbnailUrl?: string;
  /** Live chat presence, read at request time — never a stored counter. */
  viewers: number;
}

interface EventListResponse {
  events: GuideEvent[];
}

/**
 * Every event a buyer may browse, already grouped-ordered by the API
 * (Live now → Up next → Ended).
 *
 * Unlike the thumbnail read above this DOES reject: the guide is the only way
 * to reach another seller's event, so a silent empty list would look like
 * "nothing is on" — a confident wrong answer — rather than "we could not ask".
 * The caller distinguishes the two and says so.
 */
export async function fetchEventGuide(apiBaseUrl?: string): Promise<GuideEvent[]> {
  const response = await requestJson<EventListResponse>(eventUrl('/events', apiBaseUrl));
  return Array.isArray(response?.events) ? response.events : [];
}

async function fetchVariant(productId: string, apiBaseUrl?: string): Promise<CatalogVariant> {
  return requestJson<CatalogVariant>(
    eventUrl(`/catalog/variants/${encodeURIComponent(productId)}`, apiBaseUrl),
  );
}

async function holdInventory(
  eventId: string,
  productId: string,
  quantity: number,
  apiBaseUrl?: string,
): Promise<void> {
  const endpoint = quantity > 0 ? 'hold' : 'release';
  await requestJson(
    eventUrl(`/inventory/${encodeURIComponent(productId)}/${endpoint}`, apiBaseUrl),
    {
      method: 'POST',
      body: JSON.stringify({
        ...(quantity > 0 ? { quantity } : {}),
        sourceKind: 'event',
        sourceId: eventId,
      }),
    },
  );
}

function itemFromVariant(
  eventId: string,
  variant: CatalogVariant,
  priceCents: number,
  quantity: number,
): SellerEventItem {
  return {
    eventId,
    eventItemId: `${eventId}:${variant.id}`,
    productId: variant.id,
    title: variant.title,
    description: variant.description,
    priceCents,
    availableQty: variant.availableQty,
    quantity,
    onStage: false,
    attributes: {
      sku: variant.sku,
      brand: variant.brand,
      productType: variant.productType,
      condition: variant.condition ?? 'NEW',
      basePriceCents: variant.priceCents,
      groupId: variant.groupId ?? variant.id,
    },
  };
}

function policyWithVerifiedFloors(
  policy: SellerEventPolicy,
  items: readonly SellerEventItem[],
): SellerEventPolicy {
  const floors = { ...policy.priceFloorCentsByProduct };
  for (const item of items) {
    if (Number.isSafeInteger(floors[item.productId])) continue;
    floors[item.productId] = Math.max(
      1,
      Math.ceil(item.priceCents * (1 - policy.maxMarkdownPercent / 100)),
    );
  }
  return { ...policy, priceFloorCentsByProduct: floors };
}

async function registerItems(
  eventId: string,
  policy: SellerEventPolicy,
  items: readonly SellerEventItem[],
  apiBaseUrl?: string,
): Promise<SellerEventItem[]> {
  const result = await requestJson<{ items: SellerEventItem[] }>(
    eventUrl(`/actions/events/${encodeURIComponent(eventId)}/register`, apiBaseUrl),
    {
      method: 'POST',
      body: JSON.stringify({ policy: policyWithVerifiedFloors(policy, items), items }),
    },
  );
  return result.items;
}

export async function fetchSellerEvent(
  eventId: string,
  apiBaseUrl?: string,
): Promise<SellerEventSetup> {
  const [config, actionState] = await Promise.all([
    fetchEventConfig(eventId, apiBaseUrl),
    requestJson<{ items: SellerEventItem[] }>(
      eventUrl(`/actions/events/${encodeURIComponent(eventId)}/items`, apiBaseUrl),
    ),
  ]);
  return { eventId, name: config.name, policy: config.policy, items: actionState.items };
}

async function reserveAndRegister(
  eventId: string,
  payload: EventCreationPayload,
  apiBaseUrl?: string,
): Promise<SellerEventSetup> {
  const config = await fetchEventConfig(eventId, apiBaseUrl);
  const variants = await Promise.all(
    payload.items.map((item) => fetchVariant(item.catalogId, apiBaseUrl)),
  );
  const items = payload.items.map((draft, index) => (
    itemFromVariant(
      eventId,
      variants[index],
      draft.eventPriceCents,
      draft.quantityLimit,
    )
  ));
  const held: SellerEventItem[] = [];
  try {
    for (const item of items) {
      await holdInventory(eventId, item.productId, item.quantity, apiBaseUrl);
      held.push(item);
    }
    const registered = await registerItems(eventId, config.policy, items, apiBaseUrl);
    return { eventId, name: config.name, policy: config.policy, items: registered };
  } catch (error) {
    await Promise.allSettled(
      held.map((item) => holdInventory(eventId, item.productId, 0, apiBaseUrl)),
    );
    throw error;
  }
}

export async function setupSellerEvent(
  payload: EventCreationPayload,
  apiBaseUrl?: string,
): Promise<SellerEventSetup> {
  const eventId = sellerEventId(payload.name);
  await requestJson(
    eventUrl(`/events/${encodeURIComponent(eventId)}/config`, apiBaseUrl),
    {
      method: 'PUT',
      // `thumbnailUrl` is tri-state server-side (absent keeps, null/'' clears,
      // a string replaces). JSON.stringify DROPS an undefined value, so an
      // event created without a thumbnail sends `{name}` exactly as before —
      // the absent case reaches the API as absent, not as a null that clears.
      body: JSON.stringify({ name: payload.name, thumbnailUrl: payload.thumbnailUrl }),
    },
  );
  return reserveAndRegister(eventId, payload, apiBaseUrl);
}

export async function addItemsToSellerEvent(
  eventId: string,
  payload: EventCreationPayload,
  apiBaseUrl?: string,
): Promise<SellerEventSetup> {
  return reserveAndRegister(eventId, payload, apiBaseUrl);
}

export async function executeSellerAction(
  eventId: string,
  action: ActionProposal,
  apiBaseUrl?: string,
): Promise<SellerActionResult> {
  return requestJson<SellerActionResult>(
    eventUrl(`/actions/events/${encodeURIComponent(eventId)}/execute`, apiBaseUrl),
    {
      method: 'POST',
      body: JSON.stringify({ actorId: 'seller-demo', action }),
    },
  );
}

export async function startSellerAuction(
  eventId: string,
  item: SellerEventItem,
  quantity: number,
  startingPriceCents: number,
  apiBaseUrl?: string,
): Promise<SellerAuction> {
  return requestJson<SellerAuction>(eventUrl('/auctions/start', apiBaseUrl), {
    method: 'POST',
    body: JSON.stringify({
      eventId,
      eventItemId: item.eventItemId,
      productId: item.productId,
      quantity,
      startingPriceCents,
      availableQty: item.availableQty,
    }),
  });
}

export async function adjustSellerEventStock(
  eventId: string,
  item: SellerEventItem,
  quantity: number,
  apiBaseUrl?: string,
): Promise<SellerActionResult> {
  await holdInventory(eventId, item.productId, quantity, apiBaseUrl);
  try {
    return await executeSellerAction(eventId, {
      kind: 'stock-adjust',
      productId: item.productId,
      quantity,
      reason: 'Seller adjusted the live-event quantity against verified inventory',
    }, apiBaseUrl);
  } catch (error) {
    await holdInventory(eventId, item.productId, item.quantity, apiBaseUrl).catch(() => undefined);
    throw error;
  }
}
