export const CATALOG_SOURCE = Symbol('CATALOG_SOURCE');

export interface CatalogMeasurement {
  value: number;
  unit?: string;
}

export interface CatalogDimensions {
  length?: number | CatalogMeasurement;
  width?: number | CatalogMeasurement;
  height?: number | CatalogMeasurement;
  /** Some imported rows store one unit for all three numeric dimensions. */
  unit?: string;
}

/** One sellable variant, priced and counted — the unit the UI lists and holds. */
export interface CatalogVariant {
  id: string;
  groupId: string | null;
  title: string;
  brand: string;
  productType: string;
  sku: string;
  /**
   * The variant axis SideStage sells on. Sourced from the `color` option axis
   * (product_option_axes.slug = 'color'), which is what separates one demo
   * variant from its siblings — NOT condition/handling. Undefined for an
   * imported row that carries no color axis.
   */
  color?: string;
  /** Normalized size option, when the product carries a size axis. */
  size?: string;
  /**
   * Restart import compatibility, not a SideStage variant axis: these describe
   * a resale grade and a fulfilment lead time, so they are carried through the
   * read model but never used to tell two variants of one product apart.
   */
  condition: string | null;
  handlingDays: number | null;
  priceCents: number;
  availableQty: number;
  imageUrl?: string;
  description?: string;
  /** Raw product_catalog values; consumers perform unit-aware conversion. */
  weight?: number | CatalogMeasurement;
  dimensions?: CatalogDimensions;
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
  /** Clean-clone write-through used by the shared inventory authority. */
  restock?(id: string, quantity: number, priceCents?: number): Promise<CatalogVariant | undefined>;
}
