import type { CatalogSource, CatalogVariant } from '../catalog/catalog.types';
import type { CatalogProductContext, RetrievalRequest, WebResearchFinding } from './copilot.types';
import type { CatalogResearchResult, CatalogResearchSource, WebResearchSource } from './research';

/**
 * The properties the catalog can answer FROM ITS OWN COLUMNS.
 *
 * This set is the whole point of the capability probe: it is what lets the
 * fallback decide, without a round trip, whether the catalog alone can ground
 * a property question. It is deliberately a list of the fields
 * `CatalogVariant` actually carries — not an optimistic guess — because every
 * name wrongly added here silently suppresses the web fallback for that
 * property and lets a reply answer from a catalog that never held the fact.
 *
 * Kept in sync with `toProductContext` below: a property is only listed once
 * it is genuinely projected into the grounding attributes.
 */
const CATALOG_INDEXED_PROPERTIES: ReadonlySet<string> = new Set([
  'title',
  'brand',
  'producttype',
  'sku',
  'color',
  'size',
  'condition',
  'handlingdays',
  'price',
  'pricecents',
  'qty',
  'quantity',
  'availablequantity',
  'availableqty',
  'reservedqty',
  'weight',
  'dimensions',
  'length',
  'width',
  'height',
  'description',
  'image',
  'imageurl',
]);

/** `Battery Life` and `battery-life` name the same property to a seller. */
function normalizeProperty(property: string): string {
  return property.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function measurementValue(value: number | { value: number; unit?: string } | undefined): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? value : value.value;
}

function toProductContext(variant: CatalogVariant): CatalogProductContext {
  const attributes: Record<string, string | number | boolean> = {
    brand: variant.brand,
    productType: variant.productType,
    sku: variant.sku,
    qty: variant.qty,
    availableQty: variant.availableQty,
    reservedQty: variant.reservedQty,
  };
  if (variant.color) attributes.color = variant.color;
  if (variant.size) attributes.size = variant.size;
  if (variant.condition) attributes.condition = variant.condition;
  if (variant.handlingDays !== null && variant.handlingDays !== undefined) {
    attributes.handlingDays = variant.handlingDays;
  }
  const weight = measurementValue(variant.weight);
  if (weight !== undefined) attributes.weight = weight;
  const length = measurementValue(variant.dimensions?.length);
  if (length !== undefined) attributes.length = length;
  const width = measurementValue(variant.dimensions?.width);
  if (width !== undefined) attributes.width = width;
  const height = measurementValue(variant.dimensions?.height);
  if (height !== undefined) attributes.height = height;

  return {
    productId: variant.id,
    title: variant.title,
    priceCents: variant.priceCents,
    attributes,
    ...(variant.description ? { description: variant.description } : {}),
  };
}

/**
 * Adapts the ONE product source to the research fallback's contract.
 *
 * Note on cancellation: `CatalogSource.search` takes no AbortSignal, so an
 * in-flight catalog query cannot be torn down early. That is safe but worth
 * stating plainly — the fallback still DISCARDS whatever this returns after
 * the shared deadline, so a slow catalog can waste work but can never land a
 * late row in an already-composed reply.
 */
export class CatalogResearchAdapter implements CatalogResearchSource {
  constructor(private readonly catalog: CatalogSource) {}

  supportsProperties(requiredProperties: readonly string[]): boolean {
    // An empty ask is trivially covered; `every` already returns true, but the
    // fallback never calls us in that case, so this is only for direct callers.
    return requiredProperties.every((property) => (
      CATALOG_INDEXED_PROPERTIES.has(normalizeProperty(property))
    ));
  }

  async search(request: RetrievalRequest): Promise<CatalogResearchResult> {
    const page = await this.catalog.search({
      q: request.query,
      pageSize: Math.max(1, Math.min(request.limit, 20)),
    });
    return { products: page.rows.map(toProductContext) };
  }
}

/**
 * The web provider that is deployed when no real one is configured.
 *
 * It REJECTS rather than returning `[]`, and the difference matters: an empty
 * result is indistinguishable from "we researched and the web knew nothing",
 * which would let an unanswerable property question produce a confident,
 * sendable reply. Rejecting records a `provider-failed` degradation instead,
 * which marks the round incomplete and blocks the draft — the honest outcome
 * when the fact was never actually looked up.
 */
export class UnconfiguredWebResearchSource implements WebResearchSource {
  search(_request: RetrievalRequest): Promise<readonly WebResearchFinding[]> {
    return Promise.reject(new Error(
      'Web research is not configured; the catalog could not answer the required properties.',
    ));
  }
}
