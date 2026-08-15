import type { CatalogSource, CatalogVariant } from '../catalog/catalog.types';
import type { StoredActionEventItem } from './action-item.store';
import type { ActionItemStageState } from './action.types';

/** Public projection of one persisted event-lineup row. */
export interface BuyerLineupItem {
  eventId: string;
  eventItemId: string;
  productId: string;
  title: string;
  description?: string;
  referencePriceCents: number;
  priceCents: number;
  quantity: number;
  availableQty: number;
  position: number;
  stageState: ActionItemStageState;
  imageUrl?: string;
  brand?: string;
  productType?: string;
  sku?: string;
  color?: string;
  size?: string;
  condition?: string | null;
}

function projectBuyerLineupItem(
  item: StoredActionEventItem,
  variant: CatalogVariant | undefined,
): BuyerLineupItem {
  return {
    eventId: item.eventId,
    eventItemId: item.eventItemId,
    productId: item.productId,
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    referencePriceCents: item.referencePriceCents,
    priceCents: item.priceCents,
    quantity: item.quantity,
    availableQty: item.availableQty,
    position: item.position,
    stageState: item.stageState,
    ...(variant?.imageUrl ? { imageUrl: variant.imageUrl } : {}),
    ...(variant?.brand ? { brand: variant.brand } : {}),
    ...(variant?.productType ? { productType: variant.productType } : {}),
    ...(variant?.sku ? { sku: variant.sku } : {}),
    ...(variant?.color ? { color: variant.color } : {}),
    ...(variant?.size ? { size: variant.size } : {}),
    ...(variant ? { condition: variant.condition } : {}),
  };
}

/**
 * Enrich presentation only. Event price, allocation, order, and stage state
 * always come from the persisted lineup authority, never the global catalog.
 */
export async function projectBuyerLineupItems(
  items: readonly StoredActionEventItem[],
  catalog: CatalogSource,
): Promise<BuyerLineupItem[]> {
  return Promise.all(items.map(async (item) => (
    projectBuyerLineupItem(item, await catalog.variant(item.productId))
  )));
}
