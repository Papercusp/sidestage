import type { CatalogRow } from '../event-creation/catalog';

export type EventStatus = 'draft' | 'scheduled' | 'live' | 'ended';

export interface EventItem {
  id: string;
  catalogId: string;
  title: string;
  brand: string;
  sku: string;
  imageUrl?: string;
  basePriceCents: number;
  priceCents: number;
  quantity: number;
  availableQty: number;
}

export interface SellerEvent {
  id: string;
  name: string;
  status: EventStatus;
  startsAt: string;
  viewers: number;
  maxMarkdownPercent: number;
  items: EventItem[];
}

export interface EventUpdateResult {
  event: SellerEvent;
  error?: string;
}

export interface EventItemPatch {
  priceCents?: number;
  quantity?: number;
}

function eventItemId(eventId: string, catalogId: string): string {
  return `${eventId}:${catalogId}`;
}

export function eventItemFromCatalog(row: CatalogRow, eventId = 'event'): EventItem {
  return {
    id: eventItemId(eventId, row.id),
    catalogId: row.id,
    title: row.title,
    brand: row.brand,
    sku: row.sku,
    imageUrl: row.imageUrl,
    basePriceCents: row.priceCents,
    priceCents: row.priceCents,
    quantity: Math.min(1, row.availableQty),
    availableQty: row.availableQty,
  };
}

export function markdownPercent(basePriceCents: number, priceCents: number): number {
  if (!Number.isFinite(basePriceCents) || basePriceCents <= 0) return 0;
  const markdown = ((basePriceCents - priceCents) / basePriceCents) * 100;
  return Math.max(0, Math.round(markdown * 10) / 10);
}

export function formatMarkdown(basePriceCents: number, priceCents: number): string {
  return `${markdownPercent(basePriceCents, priceCents).toFixed(1)}%`;
}

export function eventItemFromPatch(
  item: EventItem,
  patch: EventItemPatch,
): EventUpdateResult {
  const nextPrice = patch.priceCents ?? item.priceCents;
  if (!Number.isSafeInteger(nextPrice) || nextPrice < 0) {
    return { event: { ...emptyEventForUpdate(item), items: [item] }, error: 'Price must be a non-negative amount.' };
  }

  const nextQuantity = patch.quantity ?? item.quantity;
  if (!Number.isSafeInteger(nextQuantity) || nextQuantity < 1 || nextQuantity > item.availableQty) {
    return {
      event: { ...emptyEventForUpdate(item), items: [item] },
      error: `Quantity must be between 1 and ${item.availableQty}.`,
    };
  }

  return {
    event: { ...emptyEventForUpdate(item), items: [{ ...item, priceCents: nextPrice, quantity: nextQuantity }] },
  };
}

/**
 * Update one event item while preserving the event-level metadata. Keeping this
 * pure makes the UI's price/quantity controls straightforward to test and gives
 * the future API adapter one validation contract to reuse.
 */
export function updateEventItem(
  event: SellerEvent,
  itemId: string,
  patch: EventItemPatch,
): EventUpdateResult {
  const item = event.items.find((candidate) => candidate.id === itemId);
  if (!item) return { event, error: 'That event item is no longer available.' };

  const nextPrice = patch.priceCents ?? item.priceCents;
  if (!Number.isSafeInteger(nextPrice) || nextPrice < 0) {
    return { event, error: 'Price must be a non-negative amount.' };
  }

  const nextQuantity = patch.quantity ?? item.quantity;
  if (!Number.isSafeInteger(nextQuantity) || nextQuantity < 1 || nextQuantity > item.availableQty) {
    return { event, error: `Quantity must be between 1 and ${item.availableQty}.` };
  }

  return {
    event: {
      ...event,
      items: event.items.map((candidate) => (
        candidate.id === itemId
          ? { ...candidate, priceCents: nextPrice, quantity: nextQuantity }
          : candidate
      )),
    },
  };
}

export function applyMarkdown(
  event: SellerEvent,
  itemId: string,
  percent: number,
): EventUpdateResult {
  if (!Number.isFinite(percent) || percent < 0) return { event, error: 'Markdown must be zero or greater.' };
  if (percent > event.maxMarkdownPercent) {
    return { event, error: `Markdown cannot exceed the ${event.maxMarkdownPercent}% event limit.` };
  }

  const item = event.items.find((candidate) => candidate.id === itemId);
  if (!item) return { event, error: 'That event item is no longer available.' };

  const priceCents = Math.max(0, Math.round(item.basePriceCents * (1 - percent / 100)));
  return updateEventItem(event, itemId, { priceCents });
}

export function addCatalogItems(
  event: SellerEvent,
  catalog: readonly CatalogRow[],
  catalogIds: readonly string[],
): SellerEvent {
  const existing = new Set(event.items.map((item) => item.catalogId));
  const additions = catalog
    .filter((row) => catalogIds.includes(row.id) && row.availableQty > 0 && !existing.has(row.id))
    .map((row) => eventItemFromCatalog(row, event.id));

  return additions.length ? { ...event, items: [...event.items, ...additions] } : event;
}

export function slugifyEventName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'new-event';
}

export function createEmptyEvent(name: string, startsAt = new Date().toISOString()): SellerEvent {
  return {
    id: slugifyEventName(name),
    name: name.trim() || 'Untitled event',
    status: 'draft',
    startsAt,
    viewers: 0,
    maxMarkdownPercent: 20,
    items: [],
  };
}

function emptyEventForUpdate(item: EventItem): SellerEvent {
  return {
    id: 'item-update',
    name: 'item-update',
    status: 'draft',
    startsAt: '',
    viewers: 0,
    maxMarkdownPercent: 20,
    items: [item],
  };
}
