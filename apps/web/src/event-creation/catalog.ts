import { OFFLINE_FIXTURE, variantToCatalogRow } from '../catalog';

export type CatalogAvailabilityFilter = 'all' | 'in-stock';

export interface CatalogRow {
  id: string;
  groupId: string;
  title: string;
  brand: string;
  productType: string;
  sku: string;
  /** The variant axis the picker shows — see CatalogVariant.color. */
  color?: string;
  size?: string;
  condition: string;
  handlingDays: number | null;
  priceCents: number;
  availableQty: number;
  imageUrl?: string;
}

export interface EventItemDraft {
  catalogId: string;
  groupId: string;
  title: string;
  sku: string;
  eventPriceCents: number;
  quantityLimit: number;
  availableQty: number;
}

export interface EventCreationPayload {
  name: string;
  /**
   * Optional buyer-facing thumbnail for the event, as a `data:` URL produced by
   * readThumbnailFile() or an ordinary http(s) URL. Absent means the seller did
   * not pick one and every renderer falls back to its placeholder — it is never
   * an empty string, so `thumbnailUrl ? … : placeholder` is the whole contract.
   */
  thumbnailUrl?: string;
  items: Array<{
    catalogId: string;
    groupId: string;
    eventPriceCents: number;
    quantityLimit: number;
  }>;
}

/**
 * Offline-only rendering of the single demo fixture (see ../catalog.ts).
 * Live consumers use useCatalog() against the API read model; this derived
 * constant exists for tests and API-unreachable fallbacks. The hand-written
 * rows that used to live here were one of four parallel demo catalogs —
 * deleted in sidestage-code-quality-2026-08-13 P-102.
 */
export const DEMO_CATALOG: readonly CatalogRow[] = OFFLINE_FIXTURE.map(variantToCatalogRow);

export function formatPrice(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

export function parsePriceCents(value: string): number | null {
  const normalized = value.trim().replace(/^\$/, '');
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(`${whole}${fraction.padEnd(2, '0')}`);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function clampQuantity(value: number, availableQty: number): number {
  const max = Math.max(0, Math.floor(availableQty));
  if (max === 0) return 0;
  return Math.min(max, Math.max(1, Math.floor(Number.isFinite(value) ? value : 1)));
}

export function filterCatalog(
  rows: readonly CatalogRow[],
  query: string,
  productType: string,
  availability: CatalogAvailabilityFilter,
): CatalogRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (productType !== 'all' && row.productType !== productType) return false;
    if (availability === 'in-stock' && row.availableQty < 1) return false;
    if (!normalizedQuery) return true;
    return [row.title, row.brand, row.productType, row.sku, row.color ?? '', row.size ?? '', row.condition]
      .some((field) => field.toLowerCase().includes(normalizedQuery));
  });
}

export function draftFromCatalog(row: CatalogRow): EventItemDraft {
  return {
    catalogId: row.id,
    groupId: row.groupId,
    title: row.title,
    sku: row.sku,
    eventPriceCents: row.priceCents,
    quantityLimit: clampQuantity(1, row.availableQty),
    availableQty: row.availableQty,
  };
}

export function createEventPayload(
  name: string,
  drafts: readonly EventItemDraft[],
  thumbnailUrl?: string,
): EventCreationPayload | null {
  const trimmedName = name.trim();
  if (!trimmedName || drafts.length === 0) return null;
  // A blank/whitespace thumbnail is normalized AWAY rather than forwarded: the
  // absent case is the one every renderer already handles, so there is no
  // second "empty but present" state for a caller to get wrong.
  const trimmedThumbnail = thumbnailUrl?.trim();
  return {
    name: trimmedName,
    ...(trimmedThumbnail ? { thumbnailUrl: trimmedThumbnail } : {}),
    items: drafts.map((draft) => ({
      catalogId: draft.catalogId,
      groupId: draft.groupId,
      eventPriceCents: Math.max(0, Math.floor(draft.eventPriceCents)),
      quantityLimit: clampQuantity(draft.quantityLimit, draft.availableQty),
    })),
  };
}
