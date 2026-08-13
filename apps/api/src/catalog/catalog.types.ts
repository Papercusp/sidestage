export const CATALOG_SOURCE = Symbol('CATALOG_SOURCE');

/** One sellable variant, priced and counted — the unit the UI lists and holds. */
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

export type CatalogAvailability = 'all' | 'in-stock';

export interface CatalogQuery {
  q?: string;
  productType?: string;
  availability?: CatalogAvailability;
  page?: number;
  pageSize?: number;
}

export interface CatalogPage {
  rows: CatalogVariant[];
  page: number;
  pageSize: number;
  /** Bounded count: capped at totalCap, with totalIsFloor set when the cap hit. */
  total: number;
  totalIsFloor: boolean;
}

/**
 * The ONE product source. PgCatalogSource serves the real (Restart-imported)
 * catalog; FixtureCatalogSource serves the clean-clone demo fixture. Scout's
 * SCOUT_CATALOG is adapted from this same source — no parallel catalogs.
 */
export interface CatalogSource {
  search(query: CatalogQuery): Promise<CatalogPage>;
  productTypes(limit?: number): Promise<string[]>;
  variant(id: string): Promise<CatalogVariant | undefined>;
}
