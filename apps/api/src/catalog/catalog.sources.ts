import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { memoryRelevanceTokens } from '../scout/scout-memory';
import { DEMO_CATALOG_FIXTURE } from './catalog.fixture';
import type {
  CatalogPage,
  CatalogQuery,
  CatalogSource,
  CatalogVariant,
} from './catalog.types';

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;
export const EVENT_DEMO_COLLECTION = 'event-demo-200';

/** Lazy-load @papercusp/typesense: the lib is TS-source-only (main: src/index.ts),
 * so the compiled prod image cannot require it — a static import crash-looped prod
 * on 2026-08-13 (WI-38629 incident). Search already degrades to SQL on any
 * Typesense failure; a failed module load is just the earliest such failure. */
type TypesenseModule = {
  typesenseService: {
    search(args: Record<string, unknown>): Promise<{
      hits: Array<{ id: string; groupId?: string }>;
      found: number;
    }>;
  };
};
let typesenseLoad: Promise<TypesenseModule | null> | null = null;
function loadTypesense(logger: Logger): Promise<TypesenseModule | null> {
  typesenseLoad ??= (import('@papercusp/typesense') as Promise<TypesenseModule>).catch((error: unknown) => {
    logger.warn(`@papercusp/typesense unavailable — catalog search uses SQL fallback (${(error as { code?: string })?.code ?? error})`);
    return null;
  });
  return typesenseLoad;
}
/** Counting 1.1M matching rows on every keystroke is waste; report a floor. */
const TOTAL_CAP = 10_000;

/**
 * Words already represented by typed catalog filters must not participate in
 * lexical ranking. In particular, `in-stock` tokenizes to `in`, `stock`; the
 * former is conversational filler and the latter is redundant once the query
 * carries `availability: 'in-stock'`. Leaving either in an OR-prefix tsquery
 * lets a generic description outrank the buyer's brand/model terms.
 */
function catalogSearchTokens(
  query: string,
  availability: Required<CatalogQuery>['availability'],
): string[] {
  const tokens = memoryRelevanceTokens(query);
  return availability === 'in-stock'
    ? tokens.filter((token) => token !== 'stock')
    : tokens;
}

export function normalizeQuery(query: CatalogQuery): Required<CatalogQuery> {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE)));
  const productTypes = [...new Set([
    query.productType,
    ...(query.productTypes ?? []),
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  return {
    q: (query.q ?? '').trim(),
    productType: productTypes.length === 1 ? productTypes[0] : '',
    productTypes,
    availability: query.availability === 'in-stock' ? 'in-stock' : 'all',
    page: Math.max(1, Math.floor(query.page ?? 1)),
    pageSize,
  };
}

function collectionPredicate(
  collection: string,
  params: unknown[],
  propertiesColumn = 'c.properties',
): string | null {
  if (!collection) return null;
  params.push(collection);
  return `${propertiesColumn} @> jsonb_build_object('sidestageCollection', $${params.length}::text)`;
}

/**
 * The one variant projection, shared by all three reads so a column added here
 * cannot reach two of them and silently skip the third.
 *
 * `color` is the SideStage variant axis. It is read from the normalized option
 * model (product_option_axes.slug = 'color') rather than parsed back out of
 * storefront_product.option_signature, because the option tables carry the
 * display label and the signature is only their denormalized cache. The
 * correlated scalar subquery cannot fan the result out the way a join to
 * storefront_product_option would for a multi-axis product (a hoodie has both
 * a colour and a size row), and UNIQUE (variant_id, axis_id) makes it at most
 * one row per variant.
 */
const VARIANT_COLUMNS = `v.id, v.group_id AS "groupId", c.title, c.brand, c.product_type AS "productType",
              v.sku, v.condition, v.handling AS "handlingDays", v.price_cents AS "priceCents", v.qty,
              v.reserved_qty AS "reservedQty", v."availableQty",
              -- A colour variant that ships its own photo must show THAT photo:
              -- falling straight through to the group image rendered both
              -- colorways of a product identically, and left every seeded
              -- variant_images row unread (WI-38716). Empty '[]' yields NULL,
              -- so an imported variant with no photo still gets the group's.
              COALESCE(v.variant_images->0->>'url', c.images->0->>'url') AS "imageUrl",
              c.description,
              c.weight, c.dimensions,
              (SELECT value.label
                 FROM storefront_product_option selected
                 JOIN product_option_axes axis
                   ON axis.id = selected.axis_id AND axis.slug = 'color'
                 JOIN product_option_values value
                   ON value.id = selected.value_id AND value.axis_id = axis.id
                WHERE selected.variant_id = v.id
                LIMIT 1) AS "color",
              (SELECT value.label
                 FROM storefront_product_option selected
                 JOIN product_option_axes axis
                   ON axis.id = selected.axis_id AND axis.slug = 'size'
                 JOIN product_option_values value
                   ON value.id = selected.value_id AND value.axis_id = axis.id
                WHERE selected.variant_id = v.id
                LIMIT 1) AS "size"`;

interface VariantRow {
  id: string;
  groupId: string | null;
  title: string | null;
  brand: string | null;
  productType: string | null;
  sku: string;
  color: string | null;
  size: string | null;
  condition: string | null;
  handlingDays: number | null;
  priceCents: number;
  qty: number;
  reservedQty: number;
  availableQty: number;
  imageUrl: string | null;
  description: string | null;
  weight: CatalogVariant['weight'] | null;
  dimensions: CatalogVariant['dimensions'] | null;
}

interface SqlSearchQuery {
  predicate: string;
  value: string | string[];
  rank?: string;
}

function rowToVariant(row: VariantRow): CatalogVariant {
  return {
    id: row.id,
    groupId: row.groupId,
    title: row.title ?? row.sku,
    brand: row.brand ?? '',
    productType: row.productType ?? 'OTHER',
    sku: row.sku,
    color: row.color ?? undefined,
    size: row.size ?? undefined,
    condition: row.condition,
    handlingDays: row.handlingDays,
    priceCents: row.priceCents,
    qty: row.qty,
    reservedQty: row.reservedQty,
    availableQty: row.availableQty,
    imageUrl: row.imageUrl ?? undefined,
    description: row.description ?? undefined,
    weight: row.weight ?? undefined,
    dimensions: row.dimensions ?? undefined,
  };
}

/** The real catalog: storefront variants joined to their catalog groups. */
@Injectable()
export class PgCatalogSource implements CatalogSource {
  private readonly logger = new Logger(PgCatalogSource.name);

  constructor(
    private readonly pool: Pool,
    private readonly collection: string = EVENT_DEMO_COLLECTION,
  ) {}

  async search(query: CatalogQuery): Promise<CatalogPage> {
    // Catalog inventory is the seller's live stock view. Sweep expired buyer
    // holds before projecting reservedQty/availableQty so an abandoned cart
    // cannot remain visibly reserved just because that buyer stopped polling.
    await this.pool.query('SELECT expire_inventory_reservations()', []);
    const { q, productTypes, availability, page, pageSize } = normalizeQuery(query);
    // The SAME search the Restart wholesale grid uses (@papercusp/typesense):
    // typo-tolerant, one hit per product group, true corpus match count — with
    // graceful SQL degradation when Typesense is unavailable (spec parity,
    // sidestage-code-quality P-110).
    const typesense = q && !this.collection ? await loadTypesense(this.logger) : null;
    if (q && typesense) {
      try {
        const { hits, found } = await typesense.typesenseService.search({
          q,
          categories: productTypes.length > 0 ? productTypes : undefined,
          inStockOnly: availability === 'in-stock',
          limit: pageSize,
          page,
          // This adapter only consumes the ranking keys, then hydrates the
          // sellable variants from Postgres below. Returning the full search
          // document makes an uncached Scout request cross the 2s product-
          // research budget before hydration even begins.
          includeFields: ['id', 'groupId'],
        });
        if (hits.length > 0) {
          const groupKeys = hits.map((hit) => hit.groupId ?? hit.id);
          const rows = await this.pool.query<VariantRow>(
            `SELECT ${VARIANT_COLUMNS}
             FROM storefront_product v
             LEFT JOIN product_catalog c ON c.group_id = v.group_id AND c.region = v.region
             WHERE v.active
               AND (
                 v.group_id = ANY($1)
                 OR (v.group_id IS NULL AND v.id = ANY($1))
               )
             ORDER BY array_position($1, COALESCE(v.group_id, v.id)), v."availableQty" > 0 DESC, v.id`,
            [groupKeys],
          );
          return {
            rows: rows.rows.map(rowToVariant),
            page,
            pageSize,
            // `found` is Typesense's true group-match count across the corpus.
            total: Math.min(found, TOTAL_CAP),
            totalIsFloor: found > TOTAL_CAP,
          };
        }
      } catch (err) {
        this.logger.warn(`Typesense search unavailable, falling back to SQL: ${(err as Error).message}`);
      }
    }
    // SQL path: the GIN-indexed tsvector. An OR with a slug ILIKE defeats both
    // indexes and full-scans 1.1M rows, so the slug match is a FALLBACK query
    // (own gin_trgm index) used only when the text search finds nothing.
    const tokens = catalogSearchTokens(q, availability);
    if (q && tokens.length === 0) {
      return { rows: [], page, pageSize, total: 0, totalIsFloor: false };
    }
    // `search_tsv` intentionally uses the `simple` dictionary so imported
    // brands/product codes are preserved. The QUERY uses English stemming to
    // discard conversational stopwords, then prefix-matches the simple
    // lexemes so plural "kettles" (`kettl:*`) still matches title "Kettle".
    // Tokens come from Scout memory's injection-safe relevance seam, so
    // conversational filler and typed availability words cannot dilute the
    // product terms and raw user text can never become tsquery syntax.
    const tsQuery = `to_tsquery('english', array_to_string($Q::text[], ':* | ') || ':*')`;
    const primary = await this.runSearch(query, q ? {
      predicate: `c.search_tsv @@ ${tsQuery}`,
      rank: `ts_rank(c.search_tsv, ${tsQuery})`,
      value: tokens,
    } : null);
    if (primary.rows.length > 0 || !q) return primary;
    return this.runSearch(query, {
      predicate: `v.slug ILIKE '%' || $Q || '%'`,
      value: q,
    });
  }

  async searchOwned(query: CatalogQuery, sellerId: string): Promise<CatalogPage> {
    await this.pool.query('SELECT expire_inventory_reservations()', []);
    const { q, availability } = normalizeQuery(query);
    const tokens = catalogSearchTokens(q, availability);
    if (q && tokens.length === 0) {
      return { rows: [], page: normalizeQuery(query).page, pageSize: normalizeQuery(query).pageSize, total: 0, totalIsFloor: false };
    }
    const tsQuery = `to_tsquery('english', array_to_string($Q::text[], ':* | ') || ':*')`;
    const primary = await this.runSearch(query, q ? {
      predicate: `c.search_tsv @@ ${tsQuery}`,
      rank: `ts_rank(c.search_tsv, ${tsQuery})`,
      value: tokens,
    } : null, sellerId);
    if (primary.rows.length > 0 || !q) return primary;
    return this.runSearch(query, {
      predicate: `v.slug ILIKE '%' || $Q || '%'`,
      value: q,
    }, sellerId);
  }

  private async runSearch(query: CatalogQuery, search: SqlSearchQuery | null, sellerId?: string): Promise<CatalogPage> {
    const { q, productTypes, availability, page, pageSize } = normalizeQuery(query);
    const where: string[] = ['v.active'];
    const params: unknown[] = [];
    const collectionWhere = collectionPredicate(this.collection, params);
    if (collectionWhere) where.push(collectionWhere);
    if (sellerId) {
      params.push(sellerId);
      where.push(`v.seller_id = $${params.length}`);
    }

    let rankSql: string | undefined;
    if (q && search) {
      params.push(search.value);
      const qParam = `$${params.length}`;
      where.push(search.predicate.replaceAll('$Q', qParam));
      rankSql = search.rank?.replaceAll('$Q', qParam);
    }
    if (productTypes.length > 0) {
      params.push(productTypes);
      where.push(`c.product_type = ANY($${params.length}::text[])`);
    }
    if (availability === 'in-stock') {
      where.push('v."availableQty" > 0');
    }

    const whereSql = where.join(' AND ');
    const fromSql = `FROM storefront_product v
      LEFT JOIN product_catalog c ON c.group_id = v.group_id AND c.region = v.region`;

    params.push(TOTAL_CAP + 1);
    const totalResult = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM (SELECT 1 ${fromSql} WHERE ${whereSql} LIMIT $${params.length}) bounded`,
      params,
    );
    params.pop();
    const boundedTotal = Number(totalResult.rows[0]?.n ?? 0);
    const totalIsFloor = boundedTotal > TOTAL_CAP;
    const total = totalIsFloor ? TOTAL_CAP : boundedTotal;

    params.push(pageSize, (page - 1) * pageSize);
    const rows = await this.pool.query<VariantRow>(
      `SELECT ${VARIANT_COLUMNS}
       ${fromSql}
       WHERE ${whereSql}
       ORDER BY ${rankSql ? `${rankSql} DESC, ` : ''}v."availableQty" > 0 DESC, v.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows: rows.rows.map(rowToVariant), page, pageSize, total, totalIsFloor };
  }

  async productTypes(limit = 40): Promise<string[]> {
    const params: unknown[] = [Math.min(200, Math.max(1, limit))];
    const collectionWhere = collectionPredicate(this.collection, params, 'properties');
    const result = await this.pool.query<{ productType: string }>(
      `SELECT product_type AS "productType" FROM product_catalog
       ${collectionWhere ? `WHERE ${collectionWhere}` : ''}
       GROUP BY product_type ORDER BY count(*) DESC LIMIT $1`,
      params,
    );
    return result.rows.map((row) => row.productType);
  }

  async variant(id: string): Promise<CatalogVariant | undefined> {
    const params: unknown[] = [id];
    const collectionWhere = collectionPredicate(this.collection, params);
    const result = await this.pool.query<VariantRow>(
      `SELECT ${VARIANT_COLUMNS}
       FROM storefront_product v
       LEFT JOIN product_catalog c ON c.group_id = v.group_id AND c.region = v.region
       WHERE v.id = $1
         ${collectionWhere ? `AND ${collectionWhere}` : ''}`,
      params,
    );
    const row = result.rows[0];
    return row ? rowToVariant(row) : undefined;
  }
}

/** Clean-clone fallback: the same eight variants demo.sql seeds. */
@Injectable()
export class FixtureCatalogSource implements CatalogSource {
  private readonly fixture: CatalogVariant[];

  constructor(fixture: readonly CatalogVariant[] = DEMO_CATALOG_FIXTURE) {
    // The exported fixture is immutable shared test/demo data. Each source gets
    // its own rows so a Studio intake mutation cannot leak between app boots.
    this.fixture = fixture.map((variant) => ({ ...variant }));
  }

  async search(query: CatalogQuery): Promise<CatalogPage> {
    const { q, productTypes, availability, page, pageSize } = normalizeQuery(query);
    const needle = q.toLowerCase();
    const matches = this.fixture.filter((variant) => {
      if (productTypes.length > 0 && !productTypes.includes(variant.productType)) return false;
      if (availability === 'in-stock' && variant.availableQty < 1) return false;
      if (!needle) return true;
      return [variant.title, variant.brand, variant.sku, variant.productType, variant.color ?? '', variant.description ?? '']
        .some((field) => field.toLowerCase().includes(needle));
    });
    const start = (page - 1) * pageSize;
    return {
      rows: matches.slice(start, start + pageSize),
      page,
      pageSize,
      total: matches.length,
      totalIsFloor: false,
    };
  }

  async searchOwned(query: CatalogQuery, sellerId: string): Promise<CatalogPage> {
    if (sellerId !== 'demo-seller') {
      const { page, pageSize } = normalizeQuery(query);
      return { rows: [], page, pageSize, total: 0, totalIsFloor: false };
    }
    return this.search(query);
  }

  async productTypes(): Promise<string[]> {
    return [...new Set(this.fixture.map((variant) => variant.productType))];
  }

  async variant(id: string): Promise<CatalogVariant | undefined> {
    return this.fixture.find((variant) => variant.id === id);
  }

  async saveInventory(id: string, quantity: number, priceCents: number): Promise<CatalogVariant | undefined> {
    const index = this.fixture.findIndex((variant) => variant.id === id);
    if (index < 0) return undefined;
    const current = this.fixture[index];
    if (quantity < current.reservedQty) {
      throw new ConflictException(`Quantity cannot be lower than ${current.reservedQty} reserved units for ${id}`);
    }
    const next: CatalogVariant = {
      ...current,
      qty: quantity,
      availableQty: Math.max(0, quantity - current.reservedQty),
      priceCents,
    };
    this.fixture[index] = next;
    return { ...next };
  }
}

/** Production no-source state: fail honestly instead of inventing inventory. */
@Injectable()
export class UnavailableCatalogSource implements CatalogSource {
  private unavailable(): never {
    throw new Error('Catalog data source unavailable: durable catalog storage is not connected.');
  }

  async search(): Promise<CatalogPage> {
    return this.unavailable();
  }

  async searchOwned(): Promise<CatalogPage> {
    return this.unavailable();
  }

  async productTypes(): Promise<string[]> {
    return this.unavailable();
  }

  async variant(): Promise<CatalogVariant | undefined> {
    return this.unavailable();
  }
}
