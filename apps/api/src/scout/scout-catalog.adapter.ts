import type { CatalogSource, CatalogVariant } from '../catalog/catalog.types';
import type { ProductCard, ScoutCatalog } from './scout.types';

export function variantToProductCard(variant: CatalogVariant): ProductCard {
  const attributes: Record<string, string | number | boolean> = { sku: variant.sku };
  if (variant.brand) attributes.brand = variant.brand;
  // The variant axis: without it two colorways of one product are identical
  // cards, and Scout cannot answer "do you have it in walnut?" (WI-38716).
  if (variant.color) attributes.color = variant.color;
  if (variant.condition) attributes.condition = variant.condition;
  if (variant.handlingDays !== null && variant.handlingDays !== undefined) {
    attributes.handlingDays = variant.handlingDays;
  }
  return {
    productId: variant.id,
    title: variant.title,
    description: variant.description ?? '',
    priceCents: variant.priceCents,
    availableQty: variant.availableQty,
    imageUrl: variant.imageUrl,
    attributes,
  };
}

/**
 * Scout searches the SAME catalog the shop lists — the adapter is the whole
 * bridge, so there is no second product corpus to drift (P-102).
 */
export function scoutCatalogFrom(source: CatalogSource): ScoutCatalog {
  return {
    async search(query: string, limit: number, productTypes?: readonly string[]): Promise<ProductCard[]> {
      const page = await source.search({
        q: query,
        productTypes,
        availability: 'in-stock',
        pageSize: limit,
      });
      return page.rows.map(variantToProductCard);
    },
  };
}
