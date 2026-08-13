import { Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { typesenseService } from '@papercusp/typesense';
import { DEMO_CATALOG_FIXTURE } from './catalog.fixture';
import type {
  CatalogPage,
  CatalogQuery,
  CatalogSource,
  CatalogVariant,
} from './catalog.types';

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;
/** Counting 1.1M matching rows on every keystroke is waste; report a floor. */
const TOTAL_CAP = 10_000;

export function normalizeQuery(query: CatalogQuery): Required<CatalogQuery> {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE)));
  return {
    q: (query.q ?? '').trim(),
    productType: (query.productType ?? '').trim(),
    availability: query.availability === 'in-stock' ? 'in-stock' : 'all',
    page: Math.max(1, Math.floor(query.page ?? 1)),
    pageSize,
  };
}

interface VariantRow {
  id: string;
  groupId: string | null;
  title: string | null;
  brand: string | null;
  productType: string | null;
  sku: string;
  condition: string | null;
  handlingDays: number | null;
  priceCents: number;
  availableQty: number;
  imageUrl: string | null;
  description: string | null;
}

function rowToVariant(row: VariantRow): CatalogVariant {
  return {
    id: row.id,
    groupId: row.groupId,
    title: row.title ?? row.sku,
    brand: row.brand ?? '',
    productType: row.productType ?? 'OTHER',
    sku: row.sku,
    condition: row.condition,
    handlingDays: row.handlingDays,
    priceCents: row.priceCents,
    availableQty: row.availableQty,
    imageUrl: row.imageUrl ?? undefined,
    description: row.description ?? undefined,
  };
}

/** The real catalog: storefront variants joined to their catalog groups. */
@Injectable()
export class PgCatalogSource implements CatalogSource {
  private readonly logger = new Logger(PgCatalogSource.name);

  constructor(private readonly pool: Pool) {}

  async search(query: CatalogQuery): Promise<CatalogPage> {
    const { q, productType, availability, page, pageSize } = normalizeQuery(query);
    // The SAME search the Restart wholesale grid uses (@papercusp/typesense):
    // typo-tolerant, one hit per product group, true corpus match count — with
    // graceful SQL degradation when Typesense is unavailable (spec parity,
    // sidestage-code-quality P-110).
    if (q) {
      try {
        const { hits, found } = await typesenseService.search({
          q,
          category: productType || undefined,
          inStockOnly: availability === 'in-stock',
          limit: pageSize,
          page,
        });
        if (hits.length > 0) {
          const groupKeys = hits.map((hit) => (hit as { groupId?: string }).groupId ?? hit.id);
          const rows = await this.pool.query<VariantRow>(
            `SELECT v.id, v.group_id AS "groupId", c.title, c.brand, c.product_type AS "productType",
                    v.sku, v.condition, v.handling AS "handlingDays", v.price_cents AS "priceCents",
                    v."availableQty", c.images->0->>'url' AS "imageUrl", c.description
             FROM storefront_product v
             LEFT JOIN product_catalog c ON c.group_id = v.group_id AND c.region = v.region
             WHERE v.active AND COALESCE(v.group_id, v.id) = ANY($1)
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
    const primary = await this.runSearch(query, q ? `c.search_tsv @@ plainto_tsquery('simple', $Q)` : null);
    if (primary.rows.length > 0 || !q) return primary;
    return this.runSearch(query, `v.slug ILIKE '%' || $Q || '%'`);
  }

  private async runSearch(query: CatalogQuery, qClause: string | null): Promise<CatalogPage> {
    const { q, productType, availability, page, pageSize } = normalizeQuery(query);
    const where: string[] = ['v.active'];
    const params: unknown[] = [];

    if (q && qClause) {
      params.push(q);
      where.push(qClause.replaceAll('$Q', `$${params.length}`));
    }
    if (productType) {
      params.push(productType);
      where.push(`c.product_type = $${params.length}`);
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
      `SELECT v.id, v.group_id AS "groupId", c.title, c.brand, c.product_type AS "productType",
              v.sku, v.condition, v.handling AS "handlingDays", v.price_cents AS "priceCents",
              v."availableQty", c.images->0->>'url' AS "imageUrl", c.description
       ${fromSql}
       WHERE ${whereSql}
       ORDER BY v."availableQty" > 0 DESC, v.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows: rows.rows.map(rowToVariant), page, pageSize, total, totalIsFloor };
  }

  async productTypes(limit = 40): Promise<string[]> {
    const result = await this.pool.query<{ productType: string }>(
      `SELECT product_type AS "productType" FROM product_catalog
       GROUP BY product_type ORDER BY count(*) DESC LIMIT $1`,
      [Math.min(200, Math.max(1, limit))],
    );
    return result.rows.map((row) => row.productType);
  }

  async variant(id: string): Promise<CatalogVariant | undefined> {
    const result = await this.pool.query<VariantRow>(
      `SELECT v.id, v.group_id AS "groupId", c.title, c.brand, c.product_type AS "productType",
              v.sku, v.condition, v.handling AS "handlingDays", v.price_cents AS "priceCents",
              v."availableQty", c.images->0->>'url' AS "imageUrl", c.description
       FROM storefront_product v
       LEFT JOIN product_catalog c ON c.group_id = v.group_id AND c.region = v.region
       WHERE v.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToVariant(row) : undefined;
  }
}

/** Clean-clone fallback: the same eight variants demo.sql seeds. */
@Injectable()
export class FixtureCatalogSource implements CatalogSource {
  constructor(private readonly fixture: readonly CatalogVariant[] = DEMO_CATALOG_FIXTURE) {}

  async search(query: CatalogQuery): Promise<CatalogPage> {
    const { q, productType, availability, page, pageSize } = normalizeQuery(query);
    const needle = q.toLowerCase();
    const matches = this.fixture.filter((variant) => {
      if (productType && variant.productType !== productType) return false;
      if (availability === 'in-stock' && variant.availableQty < 1) return false;
      if (!needle) return true;
      return [variant.title, variant.brand, variant.sku, variant.productType, variant.description ?? '']
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

  async productTypes(): Promise<string[]> {
    return [...new Set(this.fixture.map((variant) => variant.productType))];
  }

  async variant(id: string): Promise<CatalogVariant | undefined> {
    return this.fixture.find((variant) => variant.id === id);
  }
}
