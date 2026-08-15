import { resolveApiBaseUrl, type CatalogVariant } from '../catalog';
import { DEMO_PRINCIPAL_HEADER } from '@papercusp/sync';
import type { EventCreationPayload } from '../event-creation/catalog';
import type { RunOfShowEntry, RunOfShowPlan } from '../run-of-show';

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
  tone: 'concise' | 'warm' | 'playful' | 'professional';
}

export interface SellerEventSetup {
  eventId: string;
  name: string;
  policy: SellerEventPolicy;
  items: SellerEventItem[];
}

export interface SellerIdentity {
  sellerId: string;
  sellerName: string;
  /** Canonical app-wide identity transported to the server trust boundary. */
  principal?: string;
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
  closedAt?: string;
  winnerOrder?: {
    bidderId: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    status: 'pending';
  };
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
 * could not distinguish them and swallowed both. Callers can now branch on
 * the structured status rather than parsing an error message.
 */
export class EventApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EventApiError';
  }
}

/** Carry the app-wide demo principal across seller-private request fallbacks. */
export function sellerPrivateRequestHeaders(principal?: string): Record<string, string> {
  const normalizedPrincipal = principal?.trim();
  return {
    ...(normalizedPrincipal ? { [DEMO_PRINCIPAL_HEADER]: normalizedPrincipal } : {}),
  };
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
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

async function fetchEventConfig(
  eventId: string,
  apiBaseUrl?: string,
  principal?: string,
): Promise<EventConfigResponse> {
  return requestJson<EventConfigResponse>(
    eventUrl(`/events/${encodeURIComponent(eventId)}/config`, apiBaseUrl),
    principal ? { headers: { [DEMO_PRINCIPAL_HEADER]: principal } } : undefined,
  );
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
  principal?: string,
): Promise<void> {
  const endpoint = quantity > 0 ? 'hold' : 'release';
  await requestJson(
    eventUrl(`/inventory/${encodeURIComponent(productId)}/${endpoint}`, apiBaseUrl),
    {
      method: 'POST',
      headers: sellerPrivateRequestHeaders(principal),
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
      // Colour is the variant axis: a staged item without it is indistinguishable
      // from its sibling colorway in the buyer rail and the transcript (WI-38716).
      ...(variant.color ? { color: variant.color } : {}),
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
  principal?: string,
): Promise<SellerEventItem[]> {
  const result = await requestJson<{ items: SellerEventItem[] }>(
    eventUrl(`/actions/events/${encodeURIComponent(eventId)}/register`, apiBaseUrl),
    {
      method: 'POST',
      headers: principal ? { [DEMO_PRINCIPAL_HEADER]: principal } : undefined,
      body: JSON.stringify({ policy: policyWithVerifiedFloors(policy, items), items }),
    },
  );
  return result.items;
}

export async function fetchSellerEvent(
  eventId: string,
  apiBaseUrl?: string,
  principal?: string,
): Promise<SellerEventSetup> {
  const [config, actionState] = await Promise.all([
    fetchEventConfig(eventId, apiBaseUrl, principal),
    requestJson<{ items: SellerEventItem[] }>(
      eventUrl(`/actions/events/${encodeURIComponent(eventId)}/items`, apiBaseUrl),
      principal ? { headers: { [DEMO_PRINCIPAL_HEADER]: principal } } : undefined,
    ),
  ]);
  return { eventId, name: config.name, policy: config.policy, items: actionState.items };
}

async function reserveAndRegister(
  eventId: string,
  payload: EventCreationPayload,
  apiBaseUrl?: string,
  principal?: string,
): Promise<SellerEventSetup> {
  const config = await fetchEventConfig(eventId, apiBaseUrl, principal);
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
      await holdInventory(eventId, item.productId, item.quantity, apiBaseUrl, principal);
      held.push(item);
    }
    const registered = await registerItems(eventId, config.policy, items, apiBaseUrl, principal);
    return { eventId, name: config.name, policy: config.policy, items: registered };
  } catch (error) {
    await Promise.allSettled(
      held.map((item) => holdInventory(eventId, item.productId, 0, apiBaseUrl, principal)),
    );
    throw error;
  }
}

export async function setupSellerEvent(
  payload: EventCreationPayload,
  seller: SellerIdentity,
  apiBaseUrl?: string,
): Promise<SellerEventSetup> {
  const eventId = sellerEventId(payload.name);
  await requestJson(
    eventUrl(`/events/${encodeURIComponent(eventId)}/config`, apiBaseUrl),
    {
      method: 'PUT',
      headers: {
        [DEMO_PRINCIPAL_HEADER]: seller.principal ?? seller.sellerId,
        'x-seller-name': seller.sellerName,
      },
      // `thumbnailUrl` is tri-state server-side (absent keeps, null/'' clears,
      // a string replaces). JSON.stringify DROPS an undefined value, so an
      // event created without a thumbnail sends `{name}` exactly as before —
      // the absent case reaches the API as absent, not as a null that clears.
      body: JSON.stringify({ name: payload.name, thumbnailUrl: payload.thumbnailUrl }),
    },
  );
  return reserveAndRegister(eventId, payload, apiBaseUrl, seller.principal ?? seller.sellerId);
}

export async function addItemsToSellerEvent(
  eventId: string,
  payload: EventCreationPayload,
  apiBaseUrl?: string,
  principal?: string,
): Promise<SellerEventSetup> {
  return reserveAndRegister(eventId, payload, apiBaseUrl, principal);
}

export async function executeSellerAction(
  eventId: string,
  actorId: string,
  action: ActionProposal,
  apiBaseUrl?: string,
  principal?: string,
): Promise<SellerActionResult> {
  return requestJson<SellerActionResult>(
    eventUrl(`/actions/events/${encodeURIComponent(eventId)}/execute`, apiBaseUrl),
    {
      method: 'POST',
      headers: principal ? { [DEMO_PRINCIPAL_HEADER]: principal } : undefined,
      body: JSON.stringify({ actorId, action }),
    },
  );
}

export async function startSellerAuction(
  eventId: string,
  item: SellerEventItem,
  quantity: number,
  startingPriceCents: number,
  apiBaseUrl?: string,
  principal?: string,
  durationSec?: number,
): Promise<SellerAuction> {
  return requestJson<SellerAuction>(eventUrl('/auctions/start', apiBaseUrl), {
    method: 'POST',
    headers: principal?.trim() ? { [DEMO_PRINCIPAL_HEADER]: principal.trim() } : undefined,
    body: JSON.stringify({
      eventId,
      eventItemId: item.eventItemId,
      productId: item.productId,
      quantity,
      startingPriceCents,
      ...(durationSec === undefined ? {} : { durationSec }),
      availableQty: item.availableQty,
    }),
  });
}

export async function closeSellerAuction(
  auctionId: string,
  apiBaseUrl?: string,
  principal?: string,
): Promise<SellerAuction> {
  return requestJson<SellerAuction>(
    eventUrl(`/auctions/${encodeURIComponent(auctionId)}/close`, apiBaseUrl),
    {
      method: 'POST',
      headers: principal?.trim() ? { [DEMO_PRINCIPAL_HEADER]: principal.trim() } : undefined,
    },
  );
}

/**
 * Run-of-show client (plan sidestage-run-of-show-planner-2026-08-14).
 *
 * These live HERE, not in run-of-show.ts, on purpose: this module is the one
 * budgeted HTTP transport for event surfaces (sync-contract.test.ts — every
 * helper funnels through the single requestJson fetch). run-of-show.ts stays
 * pure logic. Reads should prefer useSyncQuery('event.runOfShow'); this GET
 * exists for non-hook callers, and the PUT is the useSyncMutate REST fallback.
 */
export async function fetchRunOfShowPlan(
  eventId: string,
  apiBaseUrl?: string,
  principal?: string,
): Promise<RunOfShowPlan> {
  return requestJson<RunOfShowPlan>(
    eventUrl(`/events/${encodeURIComponent(eventId)}/run-of-show`, apiBaseUrl),
    principal ? { headers: { [DEMO_PRINCIPAL_HEADER]: principal } } : undefined,
  );
}

export async function saveRunOfShowPlan(
  eventId: string,
  entries: readonly RunOfShowEntry[],
  apiBaseUrl?: string,
  principal?: string,
): Promise<RunOfShowPlan> {
  return requestJson<RunOfShowPlan>(
    eventUrl(`/events/${encodeURIComponent(eventId)}/run-of-show`, apiBaseUrl),
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(principal ? { [DEMO_PRINCIPAL_HEADER]: principal } : {}),
      },
      body: JSON.stringify({ entries }),
    },
  );
}

export async function adjustSellerEventStock(
  eventId: string,
  actorId: string,
  item: SellerEventItem,
  quantity: number,
  apiBaseUrl?: string,
  principal?: string,
): Promise<SellerActionResult> {
  await holdInventory(eventId, item.productId, quantity, apiBaseUrl, principal);
  try {
    return await executeSellerAction(eventId, actorId, {
      kind: 'stock-adjust',
      productId: item.productId,
      quantity,
      reason: 'Seller adjusted the live-event quantity against verified inventory',
    }, apiBaseUrl, principal);
  } catch (error) {
    await holdInventory(eventId, item.productId, item.quantity, apiBaseUrl, principal).catch(() => undefined);
    throw error;
  }
}
