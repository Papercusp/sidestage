import type { StoredActionEventItem } from './action-item.store';
import type { ActionItemStageState } from './action.types';

/**
 * Public projection of one persisted event-lineup row — exactly the replicated
 * `event_lineup_item` row, nothing more.
 *
 * D-036: this deliberately carries NO catalog enrichment. It used to spread
 * seven conditional keys off a `CatalogVariant` (imageUrl, brand, productType,
 * sku, color, size, condition), which the Zero rung could not reproduce: ZQL
 * has no projection layer, so its leaf served a NESTED `product` relation
 * instead and the two transports disagreed about the shape of the same query.
 *
 * Catalog data reaches clients by COMPOSITION, which is what the buyer surface
 * already does — it reads `catalog.page` as its own query (BuyerTab.tsx) and
 * never consumed these keys. Relating this query to `storefront_product` would
 * also have put `qty`, `reserved_qty`, `price_cents` and `active` — the
 * seller's inventory position and base-price structure — on a PUBLIC buyer
 * read, since that table is published whole.
 *
 * ⚠ Do not re-add a catalog field here without changing the Zero leaf in the
 * same commit. The differential parity harness will catch it, but the cheaper
 * moment to notice is now.
 */
export interface BuyerLineupItem {
  eventId: string;
  eventItemId: string;
  productId: string;
  title: string;
  description?: string;
  referencePriceCents: number;
  /**
   * D-024: these three carry the `event_lineup_item` column names because the
   * Zero rung replicates that table verbatim and ZQL has no projection layer —
   * so the REST rung must spell them the same way or the two transports serve
   * different shapes for the same query.
   */
  currentPriceCents: number;
  listedQuantity: number;
  currentQuantity: number;
  position: number;
  stageState: ActionItemStageState;
  /**
   * D-037: the last four columns of the replicated row. REST serves them
   * because it has no choice: `event_lineup_item` is published WITHOUT a
   * column list, and ZQL has no projection layer — so the Zero rung serves
   * every published column and a leaf CANNOT opt out of one. Withholding them
   * here would just re-open the drift D-024 closed.
   *
   * None is sensitive: `attributes` are buyer-facing descriptors (already
   * served on `event.actions.items`), `version` is the optimistic-concurrency
   * token a client needs to write safely, and the timestamps are integer epoch
   * millis per D-026. If one ever DOES become sensitive, the fix is to drop it
   * from the publication — the publication is the privacy boundary (D-027) —
   * not to quietly omit it from this DTO.
   */
  attributes: Record<string, string | number | boolean>;
  version: number;
  createdAt: number;
  updatedAt: number;
}

function projectBuyerLineupItem(item: StoredActionEventItem): BuyerLineupItem {
  return {
    eventId: item.eventId,
    eventItemId: item.eventItemId,
    productId: item.productId,
    title: item.title,
    ...(item.description ? { description: item.description } : {}),
    referencePriceCents: item.referencePriceCents,
    currentPriceCents: item.currentPriceCents,
    listedQuantity: item.listedQuantity,
    currentQuantity: item.currentQuantity,
    position: item.position,
    stageState: item.stageState,
    attributes: { ...item.attributes },
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Event price, allocation, order, and stage state always come from the
 * persisted lineup authority, never the global catalog. D-036 removed the
 * catalog lookup entirely, so this no longer needs a `CatalogSource` — and is
 * no longer async-per-row.
 */
export function projectBuyerLineupItems(
  items: readonly StoredActionEventItem[],
): BuyerLineupItem[] {
  return items.map(projectBuyerLineupItem);
}
