import { useEffect, useRef, useState } from 'react';
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

export interface CatalogSearch {
  q?: string;
  productType?: string;
  availability?: 'all' | 'in-stock';
  page?: number;
  pageSize?: number;
}

export function resolveApiBaseUrl(explicit?: string): string {
  return (explicit ?? import.meta.env.VITE_API_URL ?? 'http://localhost:3100').replace(/\/$/, '');
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
  /** Set when the API was unreachable and the offline fixture is showing. */
  offline: boolean;
  productTypes: string[];
}

/** Debounced catalog search hook — the single client path to product data. */
export function useCatalog(search: CatalogSearch, apiBaseUrl?: string, debounceMs = 250): UseCatalogState {
  const [state, setState] = useState<UseCatalogState>({
    rows: [],
    total: 0,
    totalIsFloor: false,
    loading: true,
    offline: false,
    productTypes: [],
  });
  const requestSeq = useRef(0);
  const { q = '', productType = 'all', availability = 'all', page = 1, pageSize = 24 } = search;

  useEffect(() => {
    let cancelled = false;
    void fetchProductTypes(apiBaseUrl)
      .then((types) => {
        if (!cancelled) setState((current) => ({ ...current, productTypes: types }));
      })
      .catch(() => {
        if (!cancelled) {
          setState((current) => ({
            ...current,
            productTypes: [...new Set(OFFLINE_FIXTURE.map((row) => row.productType))],
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setState((current) => ({ ...current, loading: true }));
    const timer = setTimeout(() => {
      fetchCatalog({ q, productType, availability, page, pageSize }, apiBaseUrl)
        .then((result) => {
          if (requestSeq.current !== seq) return;
          setState((current) => ({
            ...current,
            rows: result.rows,
            total: result.total,
            totalIsFloor: result.totalIsFloor,
            loading: false,
            offline: false,
          }));
        })
        .catch(() => {
          if (requestSeq.current !== seq) return;
          const needle = q.trim().toLowerCase();
          const rows = OFFLINE_FIXTURE.filter((row) => {
            if (productType !== 'all' && row.productType !== productType) return false;
            if (availability === 'in-stock' && row.availableQty < 1) return false;
            if (!needle) return true;
            return [row.title, row.brand, row.sku].some((field) => field.toLowerCase().includes(needle));
          });
          setState((current) => ({
            ...current,
            rows,
            total: rows.length,
            totalIsFloor: false,
            loading: false,
            offline: true,
          }));
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [q, productType, availability, page, pageSize, apiBaseUrl, debounceMs]);

  return state;
}

export function variantToCatalogRow(variant: CatalogVariant): CatalogRow {
  return {
    id: variant.id,
    groupId: variant.groupId ?? variant.id,
    title: variant.title,
    brand: variant.brand,
    productType: variant.productType,
    sku: variant.sku,
    condition: variant.condition ?? 'NEW',
    handlingDays: variant.handlingDays,
    priceCents: variant.priceCents,
    availableQty: variant.availableQty,
    imageUrl: variant.imageUrl,
  };
}

export function variantToBuyerProduct(variant: CatalogVariant): BuyerProduct {
  const subtitleParts = [variant.brand, variant.condition ?? undefined].filter(Boolean);
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

/** The eight demo.sql products, for offline rendering only. */
export const OFFLINE_FIXTURE: readonly CatalogVariant[] = [
  { id: 'demo-espresso-new', groupId: 'demo-espresso-machine', title: 'Barista Pro Espresso Machine', brand: 'BrewHaus', productType: 'KITCHEN_APPLIANCE', sku: 'BH-ESP-200-NEW', condition: 'NEW', handlingDays: 2, priceCents: 49999, availableQty: 12, imageUrl: 'https://placehold.co/640x640/png?text=Barista+Pro' },
  { id: 'demo-espresso-refurbished', groupId: 'demo-espresso-machine', title: 'Barista Pro Espresso Machine', brand: 'BrewHaus', productType: 'KITCHEN_APPLIANCE', sku: 'BH-ESP-200-REF', condition: 'REFURBISHED', handlingDays: 4, priceCents: 34999, availableQty: 4, imageUrl: 'https://placehold.co/640x640/png?text=Barista+Pro' },
  { id: 'demo-headphones-black', groupId: 'demo-wireless-headphones', title: 'Cloud ANC Wireless Headphones', brand: 'Northstar Audio', productType: 'AUDIO', sku: 'NSA-CLOUD-BLK', condition: 'NEW', handlingDays: 2, priceCents: 19999, availableQty: 24, imageUrl: 'https://placehold.co/640x640/png?text=Cloud+ANC' },
  { id: 'demo-headphones-sand', groupId: 'demo-wireless-headphones', title: 'Cloud ANC Wireless Headphones', brand: 'Northstar Audio', productType: 'AUDIO', sku: 'NSA-CLOUD-SND', condition: 'NEW', handlingDays: 2, priceCents: 20999, availableQty: 8, imageUrl: 'https://placehold.co/640x640/png?text=Cloud+ANC' },
  { id: 'demo-camera-body', groupId: 'demo-creator-camera', title: 'Creator 4K Mirrorless Camera', brand: 'FrameForge', productType: 'CAMERA', sku: 'FF-C4K-BODY', condition: 'NEW', handlingDays: 3, priceCents: 89999, availableQty: 6, imageUrl: 'https://placehold.co/640x640/png?text=Creator+4K' },
  { id: 'demo-camera-kit', groupId: 'demo-creator-camera', title: 'Creator 4K Mirrorless Camera', brand: 'FrameForge', productType: 'CAMERA', sku: 'FF-C4K-KIT', condition: 'NEW', handlingDays: 5, priceCents: 109999, availableQty: 3, imageUrl: 'https://placehold.co/640x640/png?text=Creator+4K' },
  { id: 'demo-desk-bamboo', groupId: 'demo-standing-desk', title: 'Lift Electric Standing Desk', brand: 'Field Office', productType: 'OFFICE_FURNITURE', sku: 'FO-LIFT-BAMBOO', condition: 'NEW', handlingDays: 7, priceCents: 54999, availableQty: 10, imageUrl: 'https://placehold.co/640x640/png?text=Lift+Desk' },
  { id: 'demo-desk-open-box', groupId: 'demo-standing-desk', title: 'Lift Electric Standing Desk', brand: 'Field Office', productType: 'OFFICE_FURNITURE', sku: 'FO-LIFT-OPEN', condition: 'USED', handlingDays: 9, priceCents: 39999, availableQty: 2, imageUrl: 'https://placehold.co/640x640/png?text=Lift+Desk' },
];
