export type CatalogAvailabilityFilter = 'all' | 'in-stock';

export interface CatalogRow {
  id: string;
  groupId: string;
  title: string;
  brand: string;
  productType: string;
  sku: string;
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
  items: Array<{
    catalogId: string;
    groupId: string;
    eventPriceCents: number;
    quantityLimit: number;
  }>;
}

/**
 * The clean-clone catalog fixture keeps the event flow useful before the API
 * catalog read model is wired. Consumers can pass API rows through the same
 * shape when that seam is ready.
 */
export const DEMO_CATALOG: readonly CatalogRow[] = [
  {
    id: 'demo-espresso-new',
    groupId: 'demo-espresso-machine',
    title: 'Barista Pro Espresso Machine',
    brand: 'BrewHaus',
    productType: 'Kitchen appliance',
    sku: 'BH-ESP-200-NEW',
    condition: 'New',
    handlingDays: 2,
    priceCents: 49999,
    availableQty: 12,
    imageUrl: 'https://placehold.co/96x96/142a4b/9feaff?text=Espresso',
  },
  {
    id: 'demo-espresso-refurbished',
    groupId: 'demo-espresso-machine',
    title: 'Barista Pro Espresso Machine',
    brand: 'BrewHaus',
    productType: 'Kitchen appliance',
    sku: 'BH-ESP-200-REF',
    condition: 'Refurbished',
    handlingDays: 4,
    priceCents: 34999,
    availableQty: 4,
    imageUrl: 'https://placehold.co/96x96/142a4b/9feaff?text=Espresso',
  },
  {
    id: 'demo-headphones-black',
    groupId: 'demo-wireless-headphones',
    title: 'Cloud ANC Wireless Headphones',
    brand: 'Northstar Audio',
    productType: 'Audio',
    sku: 'NSA-CLOUD-BLK',
    condition: 'New',
    handlingDays: 2,
    priceCents: 19999,
    availableQty: 24,
    imageUrl: 'https://placehold.co/96x96/142a4b/9feaff?text=Cloud',
  },
  {
    id: 'demo-headphones-sand',
    groupId: 'demo-wireless-headphones',
    title: 'Cloud ANC Wireless Headphones',
    brand: 'Northstar Audio',
    productType: 'Audio',
    sku: 'NSA-CLOUD-SND',
    condition: 'New',
    handlingDays: 2,
    priceCents: 20999,
    availableQty: 8,
    imageUrl: 'https://placehold.co/96x96/142a4b/9feaff?text=Cloud',
  },
  {
    id: 'demo-camera-body',
    groupId: 'demo-creator-camera',
    title: 'Creator 4K Mirrorless Camera',
    brand: 'FrameForge',
    productType: 'Camera',
    sku: 'FF-C4K-BODY',
    condition: 'New',
    handlingDays: 3,
    priceCents: 89999,
    availableQty: 6,
    imageUrl: 'https://placehold.co/96x96/142a4b/9feaff?text=Camera',
  },
  {
    id: 'demo-camera-kit',
    groupId: 'demo-creator-camera',
    title: 'Creator 4K Mirrorless Camera',
    brand: 'FrameForge',
    productType: 'Camera',
    sku: 'FF-C4K-KIT',
    condition: 'New',
    handlingDays: 5,
    priceCents: 109999,
    availableQty: 3,
    imageUrl: 'https://placehold.co/96x96/142a4b/9feaff?text=Camera',
  },
  {
    id: 'demo-desk-bamboo',
    groupId: 'demo-standing-desk',
    title: 'Lift Electric Standing Desk',
    brand: 'Field Office',
    productType: 'Office furniture',
    sku: 'FO-LIFT-BAMBOO',
    condition: 'New',
    handlingDays: 7,
    priceCents: 54999,
    availableQty: 10,
    imageUrl: 'https://placehold.co/96x96/142a4b/9feaff?text=Desk',
  },
  {
    id: 'demo-desk-open-box',
    groupId: 'demo-standing-desk',
    title: 'Lift Electric Standing Desk',
    brand: 'Field Office',
    productType: 'Office furniture',
    sku: 'FO-LIFT-OPEN',
    condition: 'Open box',
    handlingDays: 9,
    priceCents: 39999,
    availableQty: 2,
    imageUrl: 'https://placehold.co/96x96/142a4b/9feaff?text=Desk',
  },
];

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
    return [row.title, row.brand, row.productType, row.sku, row.condition]
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
): EventCreationPayload | null {
  const trimmedName = name.trim();
  if (!trimmedName || drafts.length === 0) return null;
  return {
    name: trimmedName,
    items: drafts.map((draft) => ({
      catalogId: draft.catalogId,
      groupId: draft.groupId,
      eventPriceCents: Math.max(0, Math.floor(draft.eventPriceCents)),
      quantityLimit: clampQuantity(draft.quantityLimit, draft.availableQty),
    })),
  };
}
