import { resolveApiBaseUrl, type CatalogVariant } from '../catalog';
import { DEMO_PRINCIPAL_HEADER } from '@papercusp/sync';
import type { EventCreationPayload } from '../event-creation/catalog';
import type { RunOfShowEntry, RunOfShowPlan } from '../run-of-show';
import type { EventLifecycleAction, EventLifecycleStatus } from './event-lifecycle';

export type SellerActionKind = 'markdown' | 'targeted-offer' | 'push' | 'swap' | 'stock-adjust';

export type SellerEventStageState = 'queued' | 'on-stage' | 'completed';

/**
 * The web mirror of the API's lineup row.
 *
 * D-024: these field names are the `event_lineup_item` COLUMN names. The Zero
 * rung replicates that table verbatim and ZQL has no projection layer, so the
 * column name IS the wire name on both transports — apps/web declares its own
 * copy of this shape and imports nothing from apps/api, which means tsc CANNOT
 * see a mismatch here. Spelling them identically is what keeps that silent gap
 * closed.
 */
export interface SellerEventItem {
  eventId: string;
  eventItemId: string;
  productId: string;
  title: string;
  description?: string;
  currentPriceCents: number;
  currentQuantity: number;
  listedQuantity: number;
  /** D-024: the one stage truth; the former `onStage` boolean is gone. */
  stageState?: SellerEventStageState;
  attributes: Record<string, string | number | boolean>;
}

/**
 * D-024: stage presence is DERIVED, never stored twice. The API used to serve
 * both `stageState` and an `onStage` boolean projection of it; carrying both
 * let a caller read a stale flag beside a fresh state, so the boolean is gone
 * from the wire and this is how the UI asks the question.
 */
export function isOnStage(item: Pick<SellerEventItem, 'stageState'>): boolean {
  return item.stageState === 'on-stage';
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

/** A failed seller action, classified for the seller rather than quoted at them. */
export interface SellerActionFailure {
  /** What to put on screen. */
  readonly text: string;
  /** True when re-sending the same command is a sensible thing to offer. */
  readonly retryable: boolean;
}

/**
 * Split a server REFUSAL from a server FAULT, because they are owed different
 * copy.
 *
 * A 4xx is the server refusing a specific command for a stated reason ("Close
 * the current auction before starting another"). That sentence was written for
 * the seller, it tells them what to do, and it is the authority — so it is
 * shown verbatim, and there is nothing to retry.
 *
 * A 5xx or a transport failure is different in kind. Nest answers an unhandled
 * exception with the bare string "Internal server error": not a sentence anyone
 * chose to show a seller, not their fault, and not actionable. WI-39837 leaked
 * exactly that into the run of show mid-show. So a fault gets our own copy —
 * naming what did not happen — and a retry, since the command itself was well
 * formed and the next attempt may simply work.
 */
export function describeSellerActionFailure(caught: unknown, faultText: string): SellerActionFailure {
  if (caught instanceof EventApiError && caught.status >= 400 && caught.status < 500) {
    return { text: caught.message, retryable: false };
  }
  return { text: faultText, retryable: true };
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

/**
 * A seller-owned event row, as `GET /events/mine` lists it and as the
 * lifecycle endpoint returns it. Mirrors `EventRecord` in
 * `apps/api/src/events/event.service.ts`.
 */
export interface SellerEventRecord {
  eventId: string;
  title: string;
  sellerId: string;
  sellerName: string;
  status: EventLifecycleStatus;
  startsAt: string | null;
  endedAt: string | null;
  thumbnailUrl?: string;
}

/**
 * Move an event through its lifecycle (D-002): schedule a start time, take the
 * room live, or end it.
 *
 * ONE endpoint rather than three verbs, so the legality table stays server-side.
 * A refused move comes back as a 409 whose body message is the seller-facing
 * reason, which `requestJson` surfaces as `EventApiError.message` — callers
 * show it rather than inventing their own wording.
 */
export async function transitionSellerEvent(
  eventId: string,
  action: EventLifecycleAction,
  options: { startsAt?: string | null } = {},
  apiBaseUrl?: string,
  principal?: string,
): Promise<SellerEventRecord> {
  const result = await requestJson<{ event: SellerEventRecord }>(
    eventUrl(`/events/${encodeURIComponent(eventId)}/lifecycle`, apiBaseUrl),
    {
      method: 'PATCH',
      headers: sellerPrivateRequestHeaders(principal),
      body: JSON.stringify({
        action,
        ...(options.startsAt ? { startsAt: options.startsAt } : {}),
      }),
    },
  );
  return result.event;
}

/**
 * Withdraw an event from every buyer surface. Deliberately an unpublish, not a
 * delete: the row returns to `draft` and its event-scoped history survives.
 */
export async function unpublishSellerEvent(
  eventId: string,
  apiBaseUrl?: string,
  principal?: string,
): Promise<{ eventId: string; status: 'draft' }> {
  return requestJson<{ eventId: string; status: 'draft' }>(
    eventUrl(`/events/${encodeURIComponent(eventId)}`, apiBaseUrl),
    { method: 'DELETE', headers: sellerPrivateRequestHeaders(principal) },
  );
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
    currentPriceCents: priceCents,
    currentQuantity: variant.availableQty,
    listedQuantity: quantity,
    stageState: 'queued',
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
      Math.ceil(item.currentPriceCents * (1 - policy.maxMarkdownPercent / 100)),
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
      await holdInventory(eventId, item.productId, item.listedQuantity, apiBaseUrl, principal);
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
      availableQty: item.currentQuantity,
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
    await holdInventory(eventId, item.productId, item.listedQuantity, apiBaseUrl, principal).catch(() => undefined);
    throw error;
  }
}
