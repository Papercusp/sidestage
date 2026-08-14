import { resolveApiBaseUrl, type CatalogVariant } from '../catalog';
import type { EventCreationPayload } from '../event-creation/catalog';

export type SellerActionKind = 'markdown' | 'push' | 'swap' | 'stock-adjust';

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
  quantity?: number;
  priceCents?: number;
  swapToProductId?: string;
  reason: string;
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
    throw new Error(message);
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
 */
export async function fetchEventThumbnailUrl(
  eventId: string,
  apiBaseUrl?: string,
): Promise<string | undefined> {
  try {
    return (await fetchEventConfig(eventId, apiBaseUrl)).thumbnailUrl;
  } catch {
    return undefined;
  }
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
