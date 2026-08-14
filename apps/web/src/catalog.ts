import { useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { CatalogRow } from './event-creation/catalog';
import type { BuyerProduct } from './buyer';

/**
 * The web side of the ONE product source (sidestage-code-quality P-102).
 * Everything product-shaped on this app flows through fetchCatalog() against
 * the API's /catalog read model (which serves the real Restart-imported
 * catalog, or the API's own seed fixture in memory mode). The fixture below is
 * the offline-fallback rendering of the same eight demo.sql products, used
 * only when the API is unreachable — every other demo product array is gone.
 */
export interface CatalogVariant {
  id: string;
  groupId: string | null;
  title: string;
  brand: string;
  productType: string;
  sku: string;
  /** The SideStage variant axis — what separates one variant from its siblings. */
  color?: string;
  /** Normalized size option when this product has a size axis. */
  size?: string;
  /** Restart import compatibility (resale grade + lead time), never the axis. */
  condition: string | null;
  handlingDays: number | null;
  priceCents: number;
  availableQty: number;
  imageUrl?: string;
  description?: string;
}

export interface CatalogPage {
  rows: CatalogVariant[];
  page: number;
  pageSize: number;
  total: number;
  totalIsFloor: boolean;
}

// A type alias, not an interface: interfaces have no implicit index signature,
// so `interface CatalogSearch` is not assignable to useSyncQuery's
// `args?: Record<string, unknown>`. An object type alias is.
export type CatalogSearch = {
  q?: string;
  productType?: string;
  availability?: 'all' | 'in-stock';
  page?: number;
  pageSize?: number;
};

export function resolveApiBaseUrl(explicit?: string): string {
  return (explicit ?? import.meta.env.VITE_API_URL ?? 'http://localhost:3100').replace(/\/$/, '');
}

/** Demo inventory is available only in an explicit development build. */
export function catalogDemoDataEnabled(isDevelopment: boolean = import.meta.env.DEV): boolean {
  return isDevelopment;
}

export async function fetchCatalog(search: CatalogSearch, apiBaseUrl?: string): Promise<CatalogPage> {
  const params = new URLSearchParams();
  if (search.q) params.set('q', search.q);
  if (search.productType && search.productType !== 'all') params.set('type', search.productType);
  if (search.availability === 'in-stock') params.set('availability', 'in-stock');
  if (search.page) params.set('page', String(search.page));
  if (search.pageSize) params.set('pageSize', String(search.pageSize));
  const response = await fetch(`${resolveApiBaseUrl(apiBaseUrl)}/catalog?${params.toString()}`);
  if (!response.ok) throw new Error(`Catalog request failed: HTTP ${response.status}`);
  return (await response.json()) as CatalogPage;
}

export async function fetchProductTypes(apiBaseUrl?: string): Promise<string[]> {
  const response = await fetch(`${resolveApiBaseUrl(apiBaseUrl)}/catalog/types`);
  if (!response.ok) throw new Error(`Catalog types request failed: HTTP ${response.status}`);
  return (await response.json()) as string[];
}

export interface UseCatalogState {
  rows: CatalogVariant[];
  total: number;
  totalIsFloor: boolean;
  loading: boolean;
  /** Set whenever the catalog transport is unavailable. */
  offline: boolean;
  /** True only when a development build is deliberately showing demo rows. */
  showingDemo: boolean;
  /** Production source loss: no rows are shown and consumers must alert. */
  unavailable: boolean;
  productTypes: string[];
}

// Loading sync queries have no data yet. These module-level fallbacks must be
// identity-stable: returning a fresh [] from the hook on every render makes a
// consumer effect that indexes rows look like its dependency changed forever.
const EMPTY_CATALOG_ROWS: CatalogVariant[] = [];
const EMPTY_PRODUCT_TYPES: string[] = [];

export function resolveCatalogRows(
  offline: boolean,
  offlineRows: CatalogVariant[],
  pageResult?: CatalogPage,
  allowDemoData: boolean = catalogDemoDataEnabled(),
): CatalogVariant[] {
  if (offline) return allowDemoData ? offlineRows : EMPTY_CATALOG_ROWS;
  return pageResult?.rows ?? EMPTY_CATALOG_ROWS;
}

export function filterOfflineCatalog(search: CatalogSearch): CatalogVariant[] {
  const {
    q = '', productType = 'all', availability = 'all', page = 1, pageSize = 24,
  } = search;
  const needle = q.trim().toLowerCase();
  const filtered = OFFLINE_FIXTURE.filter((row) => {
    if (productType !== 'all' && row.productType !== productType) return false;
    if (availability === 'in-stock' && row.availableQty < 1) return false;
    if (!needle) return true;
    return [row.title, row.brand, row.sku].some((field) => field.toLowerCase().includes(needle));
  });
  const start = Math.max(0, page - 1) * pageSize;
  return filtered.slice(start, start + pageSize);
}

/** Debounced catalog search hook — the single client path to product data. */
export function useCatalog(
  search: CatalogSearch,
  apiBaseUrl?: string,
  debounceMs = 250,
  allowDemoData: boolean = catalogDemoDataEnabled(),
): UseCatalogState {
  const { q = '', productType = 'all', availability = 'all', page = 1, pageSize = 24 } = search;
  const [debouncedSearch, setDebouncedSearch] = useState<CatalogSearch>(() => ({
    q, productType, availability, page, pageSize,
  }));

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch({ q, productType, availability, page, pageSize });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [q, productType, availability, page, pageSize, debounceMs]);

  const pageQuery = useSyncQuery<CatalogPage>({
    queryName: 'catalog.page',
    args: { ...debouncedSearch },
    pollIntervalMs: 10_000,
  });
  const typesQuery = useSyncQuery<string>({
    queryName: 'catalog.types',
    pollIntervalMs: 60_000,
  });
  const offlineRows = useMemo(
    () => filterOfflineCatalog(debouncedSearch),
    [debouncedSearch],
  );
  const pageResult = pageQuery.data?.[0];
  const offline = Boolean(pageQuery.error);
  const showingDemo = offline && allowDemoData;
  const productTypes = typesQuery.error
    ? allowDemoData
      ? [...new Set(OFFLINE_FIXTURE.map((row) => row.productType))]
      : EMPTY_PRODUCT_TYPES
    : typesQuery.data ?? EMPTY_PRODUCT_TYPES;

  // The app-wide provider owns the transport URL. Keep apiBaseUrl in the
  // signature for embedders that still pass it to the REST helper functions.
  void apiBaseUrl;

  return {
    rows: resolveCatalogRows(offline, offlineRows, pageResult, allowDemoData),
    total: showingDemo ? offlineRows.length : pageResult?.total ?? 0,
    totalIsFloor: offline ? false : pageResult?.totalIsFloor ?? false,
    loading: pageQuery.loading || pageQuery.fetching,
    offline,
    showingDemo,
    unavailable: offline && !allowDemoData,
    productTypes,
  };
}

export function variantToCatalogRow(variant: CatalogVariant): CatalogRow {
  return {
    id: variant.id,
    groupId: variant.groupId ?? variant.id,
    title: variant.title,
    brand: variant.brand,
    productType: variant.productType,
    sku: variant.sku,
    color: variant.color,
    size: variant.size,
    condition: variant.condition ?? 'NEW',
    handlingDays: variant.handlingDays,
    priceCents: variant.priceCents,
    availableQty: variant.availableQty,
    imageUrl: variant.imageUrl,
  };
}

export function variantToBuyerProduct(variant: CatalogVariant): BuyerProduct {
  // Colour is the variant axis, so it is what the subtitle must carry: two
  // colorways of one product are otherwise the same line twice. An imported
  // row with no colour axis falls back to its Restart grade (WI-38716).
  const subtitleParts = [variant.brand, variant.color ?? variant.condition ?? undefined].filter(Boolean);
  return {
    id: variant.id,
    title: variant.title,
    subtitle: subtitleParts.join(' · ') || variant.sku,
    priceCents: variant.priceCents,
    availableQty: variant.availableQty,
    imageUrl: variant.imageUrl,
    badge: variant.availableQty <= 0 ? 'Sold out' : undefined,
  };
}

/** The eight demo.sql products, for explicit development rendering and tests. */
export const OFFLINE_FIXTURE: readonly CatalogVariant[] = [
  { id: 'demo-espresso-matte-black', groupId: 'demo-espresso-machine', title: 'Barista Pro Espresso Machine', brand: 'BrewHaus', productType: 'KITCHEN_APPLIANCE', sku: 'BH-ESP-200-BLK', color: 'Matte Black', condition: 'NEW', handlingDays: 2, priceCents: 49999, availableQty: 12, imageUrl: 'https://placehold.co/640x640/2f3033/ffffff/png?text=Barista+Pro+Matte+Black' },
  { id: 'demo-espresso-cream', groupId: 'demo-espresso-machine', title: 'Barista Pro Espresso Machine', brand: 'BrewHaus', productType: 'KITCHEN_APPLIANCE', sku: 'BH-ESP-200-CRM', color: 'Cream', condition: 'NEW', handlingDays: 2, priceCents: 49999, availableQty: 5, imageUrl: 'https://placehold.co/640x640/efe6d5/3a352c/png?text=Barista+Pro+Cream' },
  { id: 'demo-headphones-midnight', groupId: 'demo-wireless-headphones', title: 'Cloud ANC Wireless Headphones', brand: 'Northstar Audio', productType: 'AUDIO', sku: 'NSA-CLOUD-MID', color: 'Midnight', condition: 'NEW', handlingDays: 2, priceCents: 19999, availableQty: 24, imageUrl: 'https://placehold.co/640x640/1b2033/ffffff/png?text=Cloud+ANC+Midnight' },
  { id: 'demo-headphones-sand', groupId: 'demo-wireless-headphones', title: 'Cloud ANC Wireless Headphones', brand: 'Northstar Audio', productType: 'AUDIO', sku: 'NSA-CLOUD-SND', color: 'Sand', condition: 'NEW', handlingDays: 2, priceCents: 19999, availableQty: 8, imageUrl: 'https://placehold.co/640x640/d8c6a8/3a3226/png?text=Cloud+ANC+Sand' },
  { id: 'demo-camera-black', groupId: 'demo-creator-camera', title: 'Creator 4K Mirrorless Camera', brand: 'FrameForge', productType: 'CAMERA', sku: 'FF-C4K-BLK', color: 'Black', condition: 'NEW', handlingDays: 3, priceCents: 89999, availableQty: 6, imageUrl: 'https://placehold.co/640x640/26262a/ffffff/png?text=Creator+4K+Black' },
  { id: 'demo-camera-silver', groupId: 'demo-creator-camera', title: 'Creator 4K Mirrorless Camera', brand: 'FrameForge', productType: 'CAMERA', sku: 'FF-C4K-SLV', color: 'Silver', condition: 'NEW', handlingDays: 3, priceCents: 89999, availableQty: 3, imageUrl: 'https://placehold.co/640x640/c9ccd1/2b2e33/png?text=Creator+4K+Silver' },
  { id: 'demo-desk-natural-oak', groupId: 'demo-standing-desk', title: 'Lift Electric Standing Desk', brand: 'Field Office', productType: 'OFFICE_FURNITURE', sku: 'FO-LIFT-OAK', color: 'Natural Oak', condition: 'NEW', handlingDays: 7, priceCents: 54999, availableQty: 10, imageUrl: 'https://placehold.co/640x640/c8a97a/3a2c18/png?text=Lift+Desk+Natural+Oak' },
  { id: 'demo-desk-walnut', groupId: 'demo-standing-desk', title: 'Lift Electric Standing Desk', brand: 'Field Office', productType: 'OFFICE_FURNITURE', sku: 'FO-LIFT-WAL', color: 'Walnut', condition: 'NEW', handlingDays: 7, priceCents: 54999, availableQty: 2, imageUrl: 'https://placehold.co/640x640/5b3a2a/ffffff/png?text=Lift+Desk+Walnut' },
];
