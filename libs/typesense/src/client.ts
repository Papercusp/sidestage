import { Client } from 'typesense';

export interface StorefrontDoc {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  priceCents: number;
  minPriceCents?: number;
  maxPriceCents?: number;
  imageUrl: string;
  active: boolean;
  groupId?: string;
  brand?: string;
  /**
   * Legacy single-condition field. Still accepted on write so older documents
   * don't fail schema validation, but new filter queries use `conditions`.
   */
  condition?: string;
  /**
   * Set of all distinct condition codes (`NEW`, `REF`, `B`, `C`, …) available
   * across the group's variants. Indexed as a string[] facet so Typesense
   * queries can express "match any group that has variants in X, Y, or Z".
   */
  conditions?: string[];
  qty?: number;
  /**
   * Per-groupId volume discount tiers (tier1..tier5) + their discount
   * percentages (tier1Discount..tier5Discount, basis-points style —
   * integer percent × 100). Mirrored from product_catalog so the wholesale
   * grid can render tiers from the Typesense snapshot alone, without a
   * separate Zero catalog subscription.
   */
  tier1?: number;
  tier2?: number;
  tier3?: number;
  tier4?: number;
  tier5?: number;
  tier1Discount?: number;
  tier2Discount?: number;
  tier3Discount?: number;
  tier4Discount?: number;
  tier5Discount?: number;
  /**
   * Per-variant stock/price snapshot for the wholesale grid.
   *
   * Shipped as a JSON object field so the grid can paint a complete row set
   * on the initial Typesense response (wave 1) — no Zero subscription is
   * required to render variants. Zero still streams live deltas on top, but
   * first paint does not depend on it.
   *
   * Stored as a single string (JSON-encoded) rather than typed object[],
   * because Typesense `object[]` fields require strict homogeneous shape and
   * we want to roll variant rows in and out without schema churn. Consumers
   * JSON.parse on read.
   */
  variants?: string;
  /**
   * Auto-generated 384-dim embedding of (name || ' ' || description) via
   * Typesense's built-in model. NEVER written by the app — Typesense
   * generates it server-side on insert/update using the `embed.from` +
   * `embed.model_config` we declared in COLLECTION_SCHEMA. Present on the
   * type only so it's readable from SearchHit if we ever want to inspect
   * vectors in debug tooling.
   */
  embedding?: number[];
}

export type SearchHit = StorefrontDoc;

const COLLECTION_NAME = 'storefront_products';
const CONV_HISTORY_COLLECTION = 'conversation_history';

// Phase 3 query understanding: a query's embedding is matched against the
// embedded product-type labels in this collection to predict its category
// (built by scripts/typesense-build-categories.ts). Predicted-category products
// are then boosted in the main search — the way Algolia does category
// prediction (a vector model, not an LLM).
const CATEGORIES_COLLECTION = 'product_categories';
// Only boost when the nearest category is CONFIDENT. Empirically, category-
// intent queries cluster well below this (camera lens 0.14, "laptop bag" 0.37,
// "del laptop" 0.39, "ssd hard drive" 0.44) while brand/ambiguous queries sit
// above it ("dell" 0.57, "hp" 0.59) — so this gate fixes "del laptop"-style
// queries without re-ranking "dell". Tunable via the eval harness.
const CATEGORY_PREDICT_MAX_DISTANCE = 0.45;
const CATEGORY_PREDICT_TOP_N = 3;

// Hybrid rank-fusion weight for the vector ranker (0..1). Typesense's default
// is 0.3 (keyword-heavy), which let strong-keyword junk (a RAM module "for Dell
// laptop") beat actual laptops for "dell laptop". Bumping it follows papercusp's
// memory search, which fuses keyword + vector with EQUAL weight via RRF. Tuned
// against scripts/search-eval (the eval harness), not by eyeballing one query.
const HYBRID_VECTOR_ALPHA = Number(process.env.SEARCH_VECTOR_ALPHA ?? '0.6');

/**
 * Build the per-field Typesense `num_typos` CSV. Field order matches `query_by`:
 * name, description, brand — plus an embedding placeholder `0` in semantic mode
 * (the vector field ignores num_typos but needs a slot for CSV alignment).
 *
 * When `maxTypos` is set, every field is clamped DOWN to it — latency-critical
 * type-ahead passes a low cap (e.g. 1) to trim fuzzy-match expansion. `Math.min`
 * against the per-field defaults keeps the embedding placeholder at 0 and never
 * raises a field above its default.
 */
export function buildNumTypos(useSemantic: boolean, maxTypos?: number): string {
  const base = useSemantic ? [2, 2, 1, 0] : [2, 2, 1];
  const fields = typeof maxTypos === 'number' ? base.map((n) => Math.min(n, maxTypos)) : base;
  return fields.join(',');
}

/**
 * One Typesense collection per region. US stays on the legacy
 * `storefront_products` collection for backwards compat; other regions get
 * `storefront_products_<lower>` (e.g. `storefront_products_fr`).
 */
export function collectionNameForRegion(region = 'US'): string {
  const r = region.toUpperCase();
  if (r === 'US' || r === '') return COLLECTION_NAME;
  return `${COLLECTION_NAME}_${r.toLowerCase()}`;
}

/** Filterable catalog-search facets, projected to Typesense `filter_by` clauses. */
export interface CatalogFilterParams {
  category?: string;
  categories?: string[];
  conditions?: string[];
  priceMinCents?: number;
  priceMaxCents?: number;
  inStockOnly?: boolean;
}

/**
 * Build the Typesense `filter_by` clause list for a catalog search. Always gated
 * to `active:true`. `categories` (array) is backtick-quoted (names may contain
 * spaces); `conditions` (string[] field) uses array-contains-any `field:[a,b]`;
 * a non-finite priceMax is simply omitted (no upper bound).
 */
export function buildFilterBy(params: CatalogFilterParams): string[] {
  const filters: string[] = ['active:true'];
  if (params.category) filters.push(`category:${params.category}`);
  if (params.categories && params.categories.length > 0) {
    const joined = params.categories.map((c) => `\`${c}\``).join(',');
    filters.push(`category:[${joined}]`);
  }
  if (params.conditions && params.conditions.length > 0) {
    filters.push(`conditions:[${params.conditions.join(',')}]`);
  }
  if (typeof params.priceMinCents === 'number') filters.push(`priceCents:>=${params.priceMinCents}`);
  if (typeof params.priceMaxCents === 'number' && isFinite(params.priceMaxCents)) {
    filters.push(`priceCents:<=${params.priceMaxCents}`);
  }
  if (params.inStockOnly) filters.push('qty:>0');
  return filters;
}

/** Cap an open-ended (Infinity) price-bucket max at 1e12 cents for Typesense range filters. */
export function capPriceCents(maxCents: number): number {
  return isFinite(maxCents) ? maxCents : 1_000_000_000_000;
}

/**
 * Embedding provider for the auto-embedding field. Selected EXPLICITLY via
 * TYPESENSE_EMBEDDING_PROVIDER rather than sniffed from key presence.
 *
 *   - 'local'  (DEFAULT) ts/all-MiniLM-L12-v2 — 384 dim, in-process, ~90MB
 *     one-time download. Free, offline-capable, no remote dependency in the
 *     collection-creation path.
 *   - 'openai' openai/text-embedding-3-small — 1536 dim, remote API,
 *     ~$0.02/1M tokens. Requires OPENAI_API_KEY. Historically the default on
 *     a host where Typesense's built-in-model memory check misread swap as
 *     'used' and refused to load MiniLM even with real RAM free; keep this
 *     escape hatch for hosts that reproduce that.
 *   - 'none'   no embedding field at all — keyword-only search.
 *
 * WHY THIS IS EXPLICIT (2026-07-09 incident): selection used to be
 * `if (process.env.OPENAI_API_KEY)`. A *present but quota-exhausted* key
 * therefore pinned the schema to a provider that 400s, and because the
 * embedding field lives inside COLLECTION_SCHEMA, collection CREATION failed
 * outright — so typesense-sync aborted, the collection never existed, and the
 * storefront's search box returned nothing. A remote embedding outage must
 * degrade semantic RANKING, never take down the entire index. Pair this with
 * the keyword-only fallback in ensureCollection().
 */
export type EmbeddingProvider = 'local' | 'openai' | 'none';

export function resolveEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const explicit = env.TYPESENSE_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (explicit === 'local' || explicit === 'openai' || explicit === 'none') {
    // 'openai' without a key is unsatisfiable — fall back rather than build a
    // schema that cannot be created.
    if (explicit === 'openai' && !env.OPENAI_API_KEY) return 'local';
    return explicit;
  }
  return 'local';
}

/**
 * Build the auto-embedding field config for COLLECTION_SCHEMA, or `null` when
 * the provider is 'none' (keyword-only). Resolved once at module load.
 */
export function buildEmbeddingField(env: NodeJS.ProcessEnv = process.env) {
  const provider = resolveEmbeddingProvider(env);
  if (provider === 'none') return null;

  const base = {
    name: 'embedding',
    type: 'float[]' as const,
    optional: true,
  };
  if (provider === 'openai') {
    return {
      ...base,
      embed: {
        from: ['name', 'description'],
        model_config: {
          model_name: 'openai/text-embedding-3-small',
          api_key: env.OPENAI_API_KEY,
        },
      },
    };
  }
  return {
    ...base,
    embed: {
      from: ['name', 'description'],
      model_config: {
        model_name: 'ts/all-MiniLM-L12-v2',
      },
    },
  };
}

/** Resolved once at module load; `null` when provider is 'none'. */
const EMBEDDING_FIELD = buildEmbeddingField();

const COLLECTION_SCHEMA = {
  name: COLLECTION_NAME,
  fields: [
    { name: 'id', type: 'string' as const },
    { name: 'slug', type: 'string' as const },
    { name: 'name', type: 'string' as const },
    { name: 'description', type: 'string' as const },
    { name: 'category', type: 'string' as const, facet: true },
    { name: 'priceCents', type: 'int32' as const },
    { name: 'minPriceCents', type: 'int32' as const, optional: true },
    { name: 'maxPriceCents', type: 'int32' as const, optional: true },
    { name: 'imageUrl', type: 'string' as const, optional: true },
    { name: 'active', type: 'bool' as const },
    { name: 'groupId', type: 'string' as const, optional: true },
    { name: 'brand', type: 'string' as const, facet: true, optional: true },
    { name: 'condition', type: 'string' as const, facet: true, optional: true },
    { name: 'conditions', type: 'string[]' as const, facet: true, optional: true },
    { name: 'qty', type: 'int32' as const, optional: true },
    // Volume discount tiers (mirrored from product_catalog.tier* columns).
    // Enables the wholesale grid to render tiers from the Typesense snapshot
    // alone — the catalog.byGroupIds Zero subscription is no longer required.
    { name: 'tier1', type: 'int32' as const, optional: true },
    { name: 'tier2', type: 'int32' as const, optional: true },
    { name: 'tier3', type: 'int32' as const, optional: true },
    { name: 'tier4', type: 'int32' as const, optional: true },
    { name: 'tier5', type: 'int32' as const, optional: true },
    { name: 'tier1Discount', type: 'int32' as const, optional: true },
    { name: 'tier2Discount', type: 'int32' as const, optional: true },
    { name: 'tier3Discount', type: 'int32' as const, optional: true },
    { name: 'tier4Discount', type: 'int32' as const, optional: true },
    { name: 'tier5Discount', type: 'int32' as const, optional: true },
    // Per-variant snapshot (JSON-encoded array of {id, condition, handling,
    // priceCents, qty, reservedQty, availableQty}). Grid parses on read.
    { name: 'variants', type: 'string' as const, optional: true, index: false },
    // Auto-embedding field — see buildEmbeddingField() above for provider
    // selection logic. Typesense generates the vector server-side on
    // insert/update and vectorizes the query text at search time; no app
    // code writes this field. Absent entirely when the provider is 'none'.
    ...(EMBEDDING_FIELD ? [EMBEDDING_FIELD as any] : []),
  ],
  default_sorting_field: 'priceCents',
};

/** COLLECTION_SCHEMA with the embedding field stripped — the keyword-only
 *  fallback used when the embedding provider is unreachable at create time. */
const COLLECTION_SCHEMA_NO_EMBEDDING = {
  ...COLLECTION_SCHEMA,
  fields: COLLECTION_SCHEMA.fields.filter((f: any) => f.name !== 'embedding'),
};

/** True when the schema this process would CREATE carries an embedding field. */
const SCHEMA_HAS_EMBEDDING = EMBEDDING_FIELD !== null;

/**
 * Does this creation error come from the embedding provider (remote API
 * rejected us, or the local model failed to load) rather than from the
 * schema/collection itself? Typesense surfaces provider failures as a 400
 * whose message quotes the upstream error.
 */
export function isEmbeddingProviderError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /openai api error|exceeded your current quota|api_key|embedding|model_config|model_name|could not (?:load|find) model/i.test(
    msg,
  );
}

export class TypesenseService {
  private client: Client;
  private collectionReady = false;
  private readonly readyRegions = new Set<string>();
  /**
   * Whether the live collection actually carries an embedding field. Starts as
   * whatever this process's schema declares, then is corrected against reality
   * in ensureCollection() — a collection created during a provider outage, or
   * by an older/newer build, may not have one. search() consults this before
   * putting `embedding` in query_by; asking Typesense to vector-search a field
   * that does not exist is a hard 400 on every query.
   */
  private embeddingsAvailable = SCHEMA_HAS_EMBEDDING;

  /** True when semantic (vector) ranking is usable against the live collection. */
  get semanticAvailable(): boolean {
    return this.embeddingsAvailable;
  }
  // Console-style logger kept minimal — libs/typesense has no NestJS dep.
  // Callers (shop-api) surface these via pino logs since stdout bubbles up
  // through overmind.
  private log = {
    warn: (msg: string) => console.warn(`[typesense] ${msg}`),
    error: (msg: string) => console.error(`[typesense] ${msg}`),
  };

  constructor() {
    this.client = new Client({
      nodes: [
        {
          host: process.env.TYPESENSE_HOST ?? 'localhost',
          port: parseInt(process.env.TYPESENSE_PORT ?? '8108', 10),
          protocol: 'http',
        },
      ],
      apiKey: process.env.TYPESENSE_API_KEY ?? 'restart-typesense-dev',
      connectionTimeoutSeconds: 5,
      // Fail fast — don't retry when Typesense is down. The catalog service
      // has a SQL fallback; retries just add 100ms * numRetries of sleep
      // latency before that fallback kicks in.
      numRetries: 1,
    });
  }

  async ensureCollection(region = 'US'): Promise<void> {
    const name = collectionNameForRegion(region);

    if (name === COLLECTION_NAME) {
      if (this.collectionReady) return;
    } else if (this.readyRegions.has(name)) {
      return;
    }

    try {
      const existing = await this.client.collections(name).retrieve();
      // Patch in any new fields that were added to the schema.
      // Existing docs are NOT backfilled here — operators must run
      // scripts/typesense-sync.ts after a schema change to populate new fields.
      const existingFieldNames = new Set((existing.fields ?? []).map((f: any) => f.name));
      // Reality check: a collection built during a provider outage (or by a
      // build configured for 'none') has no embedding field. Vector-searching
      // it would 400 every query, so degrade this process to keyword-only.
      if (!existingFieldNames.has('embedding')) {
        if (this.embeddingsAvailable) {
          this.log.warn(
            `Collection '${name}' has no 'embedding' field — serving KEYWORD-ONLY search. ` +
              `Semantic ranking is off until a resync rebuilds the collection with an ` +
              `embedding provider available (see TYPESENSE_EMBEDDING_PROVIDER).`,
          );
        }
        this.embeddingsAvailable = false;
      }
      // Typesense's built-in primary key ('id') is implicit and not listed
      // in collection.fields on retrieval — but it's in COLLECTION_SCHEMA.
      // Filtering it out prevents a 400 ("Field `id` cannot be altered") that
      // would otherwise abort the entire additive patch.
      const newFields = COLLECTION_SCHEMA.fields.filter((f) => f.name !== 'id' && !existingFieldNames.has(f.name));
      if (newFields.length > 0) {
        const newFieldNames = newFields.map((f) => f.name).join(', ');
        try {
          await this.client.collections(name).update({ fields: newFields } as any);
          this.log.warn(
            `Collection '${name}' schema patched with new fields [${newFieldNames}]; ` +
              `existing docs won't have these fields until a full resync runs — ` +
              `execute \`scripts/typesense-sync.ts\` to backfill.`,
          );
          // The patch may have restored the embedding field (provider recovered).
          if (newFields.some((f: any) => f.name === 'embedding')) this.embeddingsAvailable = true;
        } catch (err) {
          this.log.error(
            `Failed to patch collection '${name}' with new fields [${newFieldNames}]: ` +
              `${(err as Error).message}. Schema update may be unsupported by this Typesense version. ` +
              `Search will continue with existing schema; new filters on these fields will return zero until resync.`,
          );
        }
      }
      if (name === COLLECTION_NAME) this.collectionReady = true;
      else this.readyRegions.add(name);
    } catch {
      // Collection does not exist — create it under the region-specific name.
      await this.createCollectionWithFallback(name);
      if (name === COLLECTION_NAME) this.collectionReady = true;
      else this.readyRegions.add(name);
    }
  }

  /**
   * Create the collection, degrading to a keyword-only schema when the
   * embedding provider is the thing that failed.
   *
   * The auto-embedding field makes collection CREATION depend on a live
   * embedding provider: Typesense validates `model_config` by actually calling
   * the remote API (or loading the local model) and 400s if that fails. Before
   * this fallback existed, an exhausted OpenAI quota meant the collection was
   * never created at all — typesense-sync aborted and the storefront's search
   * box returned nothing, because a *ranking* dependency had been allowed to
   * become an *index* dependency (2026-07-09).
   *
   * A provider failure must cost semantic ranking only. Anything else (bad
   * schema, Typesense down, auth) still throws.
   */
  private async createCollectionWithFallback(name: string): Promise<void> {
    try {
      await this.client.collections().create({ ...COLLECTION_SCHEMA, name });
      this.embeddingsAvailable = SCHEMA_HAS_EMBEDDING;
    } catch (err) {
      if (!SCHEMA_HAS_EMBEDDING || !isEmbeddingProviderError(err)) throw err;
      this.log.error(
        `Embedding provider rejected collection '${name}' creation: ${(err as Error).message}. ` +
          `Falling back to a KEYWORD-ONLY collection so the index still builds and search still works. ` +
          `Semantic ranking is DISABLED until the provider is healthy and a resync rebuilds the ` +
          `collection (fix the provider, then re-run scripts/typesense-sync.ts).`,
      );
      await this.client.collections().create({ ...COLLECTION_SCHEMA_NO_EMBEDDING, name });
      this.embeddingsAvailable = false;
    }
  }

  /**
   * Predict the product categories a free-text query is about, by vector-
   * matching the query against the embedded product-type labels in the
   * `product_categories` collection. Returns the productType codes of the
   * nearest categories whose vector distance is within
   * CATEGORY_PREDICT_MAX_DISTANCE (confidence gate) — empty when the query
   * isn't confidently about a category (e.g. a brand like "dell"), so callers
   * apply no category boost in that case. Fail-safe: returns [] on any error
   * (e.g. the categories collection not built yet).
   */
  async predictCategories(q: string): Promise<string[]> {
    if (!q.trim()) return [];
    try {
      const res = await this.client
        .collections(CATEGORIES_COLLECTION)
        .documents()
        .search({
          q,
          query_by: 'embedding',
          prefix: false,
          per_page: CATEGORY_PREDICT_TOP_N,
          include_fields: 'productType',
          exclude_fields: 'embedding',
        } as any);
      const hits = (res.hits ?? []) as Array<{ document: { productType?: string }; vector_distance?: number }>;
      return hits
        .filter((h) => typeof h.vector_distance === 'number' && h.vector_distance <= CATEGORY_PREDICT_MAX_DISTANCE)
        .map((h) => h.document.productType)
        .filter((c): c is string => typeof c === 'string' && c.length > 0);
    } catch {
      return [];
    }
  }

  async search(params: {
    q: string;
    category?: string;
    categories?: string[];
    conditions?: string[];
    priceMinCents?: number;
    priceMaxCents?: number;
    inStockOnly?: boolean;
    sort?: 'relevance' | 'price_asc' | 'price_desc' | 'name';
    limit?: number;
    /**
     * 1-indexed page number for pagination. Typesense default is 1. Note that
     * Typesense caps `page * per_page` at 250 by default (and 10_000 overall
     * without `exhaustive_search`) — not a concern for typical catalog queries
     * with per_page=100.
     */
    page?: number;
    /**
     * Include the embedding field in query_by (hybrid keyword + semantic).
     * Defaults to `true` — callers that need consumer-intent matching
     * (/shop storefront search, Scout's product-search tool) get rank
     * fusion over name/description/brand PLUS semantic recall.
     *
     * Pass `false` for professional / exact-match audiences (wholesale
     * procurement grid + its autocomplete) where the OpenAI embedding
     * round-trip (~80–200ms per unique query) is pure latency cost with
     * minimal recall benefit — buyers there search SKUs and brand+model
     * combinations, not paraphrased intent.
     */
    semantic?: boolean;
    /**
     * Cap the per-field typo tolerance (Typesense `num_typos`). Each field's
     * default (name/desc 2, brand 1, embedding 0) is clamped DOWN to this value.
     * Omit for the defaults. Latency-critical type-ahead passes a low cap
     * (e.g. 1) to trim fuzzy-match expansion.
     */
    maxTypos?: number;
    /**
     * Post-filter mode (the /search relevance path). When true, the MAIN
     * results sub-query applies ONLY the base filter (`active:true`) — NOT the
     * structured category/condition/price/in-stock `filter_by` — so it returns
     * the base hybrid ranking, which the caller then filters in memory. The
     * disjunctive `facet_by` sub-queries still apply their own exclude-own
     * filters, so the returned facet counts stay exact. Avoids the hybrid
     * `filter_by` re-broadening where a category click surfaces vector
     * neighbours absent from the base results (the 203-vs-278 divergence).
     * Requires `facets` (multi_search). Default false (every other caller keeps
     * the constrained `filter_by` behaviour).
     */
    mainUnfiltered?: boolean;
    /**
     * When set, issue a multi_search that also computes disjunctive facet
     * counts (category, conditions, price buckets, in-stock) across the
     * global filtered corpus. Each facet count is computed with that facet's
     * own filter *excluded*, so a category row shows "how many results you'd
     * get if you toggled to this category". Pass `priceBuckets` to size the
     * range facet.
     */
    facets?: {
      priceBuckets?: Array<{ id: string; min: number; max: number }>;
    };
    /** ISO 3166-1 alpha-2 region. Determines which Typesense collection is queried. */
    region?: string;
    /**
     * Restrict the returned document fields (Typesense `include_fields`).
     * Callers that only need a ranked list of `groupId`s to cross-reference
     * against Postgres (the wholesale/procurement grids) pass a slim list to
     * avoid shipping the full document — critically the stored `embedding`
     * vector, which makes a per_page=100 response ~3MB and dominates latency.
     * Omit to return the whole document (consumer search / Scout render
     * `name`/`slug` straight off the hit).
     */
    includeFields?: string[];
  }): Promise<{
    hits: SearchHit[];
    found: number;
    facets?: {
      categories: Array<{ value: string; count: number }>;
      conditions: Array<{ value: string; count: number }>;
      priceBuckets: Array<{ id: string; count: number }>;
      inStockCount: number;
    };
  }> {
    const region = params.region ?? 'US';
    const collectionName = collectionNameForRegion(region);
    await this.ensureCollection(region);
    const filters = buildFilterBy(params);

    // Default to semantic on. Callers opt out with `semantic: false` to
    // skip the embedding round-trip (see prop doc above). Additionally forced
    // off when the live collection carries no embedding field — putting a
    // nonexistent field in query_by 400s every single query, which would turn
    // a degraded-ranking condition into a total search outage.
    const useSemantic = params.semantic !== false && this.embeddingsAvailable;

    // Phase 3 — query→category prediction. When the query is confidently about
    // a category (and the caller hasn't already constrained to one), boost
    // products in that category so e.g. "del laptop" ranks actual laptops above
    // laptop *accessories*. Confidence-gated in predictCategories(), so brand/
    // ambiguous queries ("dell") predict nothing and get no boost (no regression).
    // NOTE: the distance-threshold category boost is DISABLED — the eval harness
    // (scripts/search-eval) proved it brittle: any single gate that fixed
    // "dell laptop" broke "del laptop" (they sit on opposite sides of the
    // threshold) and regressed mean nDCG@10 (0.808 → 0.737). Type-intent ranking
    // is being moved to a reranker instead. predictCategories() is kept for that.
    const categoryBoost = '';

    // Per-field typo tolerance, clamped by maxTypos (see buildNumTypos).
    const numTypos = buildNumTypos(useSemantic, params.maxTypos);

    const searchParams: Record<string, string | number | boolean> = {
      q: params.q,
      // Hybrid search (useSemantic=true): keyword ranking over
      // name/description/brand PLUS semantic vector ranking over the
      // auto-embedding field, combined via Rank Fusion (default
      // 0.7*keyword + 0.3*semantic).
      // Keyword-only (useSemantic=false): skip the embedding field — no
      // OpenAI RTT, no vector-scoring overhead. Typo tolerance, prefix
      // matching, multi-field ranking all still work.
      query_by: useSemantic
        ? 'name,description,brand,embedding'
        : 'name,description,brand',
      // Field weights, aligned positionally with query_by. Name ≫ brand ≫
      // description — a hit in the product name or brand outranks an incidental
      // mention buried in a description (mirrors Shopify's TfIdf-Title /
      // ExactMatch-Brand emphasis). With the default text_match_type (max_score)
      // these act as the tie-breaker between docs with equal token scores, so a
      // name/brand match wins over a description-only match. (embedding gets a
      // placeholder weight in semantic mode; hybrid fusion is tuned separately
      // via alpha in the semantic path — see Phase 2.)
      query_by_weights: useSemantic ? '4,1,3,1' : '4,1,3',
      // Boost documents where a field value exactly equals the query over mere
      // prefix/typo matches (Typesense default, made explicit).
      prioritize_exact_match: true,
      // Prefix matching is per-field. When embedding is in query_by we
      // must disable prefix on it (Typesense forbids prefix search via a
      // remote embedder). Keyword-only mode needs no trailing override.
      prefix: useSemantic ? 'true,true,true,false' : 'true,true,true',
      // Per-field typo tolerance (clamped by maxTypos above).
      num_typos: numTypos,
      // Hybrid fusion weight toward the vector ranker (see HYBRID_VECTOR_ALPHA).
      // Empty vector `[]` = use the auto-embedded query text. Only valid when
      // the embedding field is in query_by (semantic mode).
      ...(useSemantic ? { vector_query: `embedding:([], alpha: ${HYBRID_VECTOR_ALPHA})` } : {}),
      // Typesense defaults (threshold=1) stop typo/drop-token expansion as soon
      // as one exact match exists — which silently kills typo tolerance for
      // queries with any exact hit at all ("delll" returned 1 hit instead of
      // broadening to all "dell" products).
      //
      // A very large threshold over-corrects: when filter_by narrows exact
      // matches below the threshold, Typesense pulls in unrelated typo/drop
      // variants that happen to match the filter, making condition-filtered
      // searches return MORE hits than unfiltered. 10 is the sweet spot —
      // enough to always rescue typo-only queries like "delll" (1 exact hit),
      // low enough to avoid filter-paradox broadening once a real query like
      // "dell" (thousands of hits) is in play.
      typo_tokens_threshold: 10,
      drop_tokens_threshold: 10,
      // Typesense has a per-node in-memory result cache; it's off by default
      // and trivially safe to enable for read-only product search. 60s TTL
      // turns repeat queries ("dell" typed once while typing, then submitted)
      // from ~400ms cold into ~1ms cache hits.
      use_cache: true,
      cache_ttl: 60,
      per_page: params.limit ?? 24,
      page: params.page ?? 1,
      // Post-filter mode (used for deep base-page fetches): drop the structured
      // filters here too — only the base `active:true` constraint applies.
      filter_by: params.mainUnfiltered ? (filters[0] ?? 'active:true') : filters.join(' && '),
    };
    // Trim the response to the fields the caller actually reads. Without this
    // a per_page=100 query returns the full document for every hit — including
    // the 1536-float OpenAI `embedding` vector — totalling ~3MB and ~110ms of
    // download+parse, even though the server-side query cache returns in ~5ms.
    if (params.includeFields?.length) {
      searchParams.include_fields = params.includeFields.join(',');
    }
    if (params.sort && params.sort !== 'relevance') {
      const sortMap = {
        price_asc:  'priceCents:asc',
        price_desc: 'priceCents:desc',
        name:       'name:asc',
      } as const;
      searchParams['sort_by'] = sortMap[params.sort];
    } else {
      // Relevance sort = textual relevance, then price desc as the tiebreaker
      // (current behaviour, now explicit). Deliberately NO `_text_match(buckets:N)`:
      // bucketing flattens near-equal scores into ties so the secondary sort
      // dominates large groups — which is exactly what let price-desc surface
      // "$9k holy card"-style junk for short queries. Without buckets, price only
      // breaks genuine ties between equally-relevant items. When the query
      // confidently maps to a category, that boost leads (so category-intent
      // queries surface the right product type), then text relevance, then price.
      searchParams['sort_by'] = `${categoryBoost}_text_match:desc,priceCents:desc`;
    }

    // ── Disjunctive-facet branch ──────────────────────────────────────
    //
    // When the caller asks for facets, we run ONE multi_search with the
    // main query plus one sub-query per facet. Each facet sub-query omits
    // its own filter so the counts answer "how many results if I toggled
    // this on?" rather than "how many remain after my current selection".
    // Typesense parallelises the sub-queries server-side; wire cost is one
    // HTTP round-trip regardless of facet count.
    if (params.facets) {
      // Build filter fragments without joining so we can selectively
      // exclude one when computing its disjunctive count.
      const frags: Record<string, string | null> = {
        active: 'active:true',
        categories: params.categories && params.categories.length > 0
          ? `category:[${params.categories.map(c => `\`${c}\``).join(',')}]`
          : (params.category ? `category:${params.category}` : null),
        conditions: params.conditions && params.conditions.length > 0
          ? `conditions:[${params.conditions.join(',')}]`
          : null,
        price: (typeof params.priceMinCents === 'number' || (typeof params.priceMaxCents === 'number' && isFinite(params.priceMaxCents)))
          ? [
              typeof params.priceMinCents === 'number' ? `priceCents:>=${params.priceMinCents}` : null,
              typeof params.priceMaxCents === 'number' && isFinite(params.priceMaxCents) ? `priceCents:<=${params.priceMaxCents}` : null,
            ].filter(Boolean).join(' && ')
          : null,
        inStock: params.inStockOnly ? 'qty:>0' : null,
      };
      const buildFilter = (exclude: keyof typeof frags | null, extra?: string) => {
        const parts: string[] = [];
        for (const [key, frag] of Object.entries(frags)) {
          if (key === exclude || !frag) continue;
          parts.push(frag);
        }
        if (extra) parts.push(extra);
        return parts.join(' && ');
      };

      // Price-bucket counts are computed as one filter query per bucket,
      // not via Typesense's range-facet (priceCents is not declared as a
      // facet field in the collection schema, so facet_by would 404). Each
      // sub-query reuses the base filter minus the price filter, AND adds
      // that bucket's price range. `found` on each sub-response is the
      // global count for that bucket.
      const priceRanges = params.facets.priceBuckets ?? [];

      const baseCommon: Record<string, string | number | boolean> = {
        q: params.q,
        query_by: searchParams.query_by,
        query_by_weights: searchParams.query_by_weights,
        prioritize_exact_match: searchParams.prioritize_exact_match,
        ...(searchParams.vector_query ? { vector_query: searchParams.vector_query } : {}),
        prefix: searchParams.prefix,
        num_typos: searchParams.num_typos,
        typo_tokens_threshold: 10,
        drop_tokens_threshold: 10,
        use_cache: true,
        cache_ttl: 60,
      };
      if (searchParams['sort_by']) baseCommon['sort_by'] = searchParams['sort_by'];

      const searches: Array<Record<string, string | number | boolean>> = [
        // 1. Main results. Normally all filters applied + paged. In post-filter
        //    mode the structured filters are dropped here (base ranking only) —
        //    the caller filters the returned pool in memory; `exhaustive_search`
        //    keeps the deep pool + `found` accurate so counts/slicing are right.
        params.mainUnfiltered
          ? {
              ...baseCommon,
              // per_page is the base pool depth (≤250, Typesense's default
              // page*per_page cap at page 1 — no exhaustive_search needed, which
              // would full-scan the corpus and blow the client timeout).
              per_page: params.limit ?? 24,
              page: 1,
              filter_by: frags.active ?? 'active:true',
            }
          : {
              ...baseCommon,
              per_page: params.limit ?? 24,
              page: params.page ?? 1,
              filter_by: buildFilter(null),
            },
        // 2. Category facet — exclude categories filter for disjunctive count.
        {
          ...baseCommon,
          per_page: 0,
          filter_by: buildFilter('categories'),
          facet_by: 'category',
          max_facet_values: 200,
        },
        // 3. Conditions facet — exclude conditions filter.
        {
          ...baseCommon,
          per_page: 0,
          filter_by: buildFilter('conditions'),
          facet_by: 'conditions',
          max_facet_values: 50,
        },
      ];
      // 4. Price-bucket counts — one sub-query per bucket (all filters
      //    except price, plus this bucket's own range). `found` is the
      //    global count for that bucket.
      for (const b of priceRanges) {
        const maxCents = capPriceCents(b.max);
        searches.push({
          ...baseCommon,
          per_page: 0,
          filter_by: buildFilter('price', `priceCents:>=${b.min} && priceCents:<${maxCents}`),
        });
      }
      // 5. In-stock count — apply all filters except inStockOnly, force qty>0.
      searches.push({
        ...baseCommon,
        per_page: 0,
        filter_by: buildFilter('inStock', 'qty:>0'),
      });

      // Typesense's node client exposes multi_search via `.multiSearch`.
      const multi: any = await (this.client as any).multiSearch.perform(
        { searches },
        { collection: collectionName },
      );
      const results = multi.results ?? [];

      // Layout of `results`: [main, categories, conditions, ...priceBuckets, inStock]
      const mainRes = results[0];
      const catRes = results[1];
      const condRes = results[2];
      const priceStart = 3;
      const priceEnd = priceStart + priceRanges.length;
      const stockRes = results[priceEnd];

      const extractFacet = (res: any, name: string): Array<{ value: string; count: number }> => {
        const fc = (res?.facet_counts ?? []).find((f: any) => f.field_name === name);
        return (fc?.counts ?? []).map((c: any) => ({ value: String(c.value), count: Number(c.count) ?? 0 }));
      };

      const categoriesFacet = extractFacet(catRes, 'category');
      const conditionsFacet = extractFacet(condRes, 'conditions');

      const priceBucketsFacet = priceRanges.map((b, i) => {
        const res = results[priceStart + i];
        return { id: b.id, count: typeof res?.found === 'number' ? res.found : 0 };
      });

      const inStockCount = typeof stockRes?.found === 'number' ? stockRes.found : 0;

      return {
        hits: (mainRes?.hits ?? []).map((hit: any) => hit.document as SearchHit),
        found: typeof mainRes?.found === 'number' ? mainRes.found : 0,
        facets: {
          categories: categoriesFacet,
          conditions: conditionsFacet,
          priceBuckets: priceBucketsFacet,
          inStockCount,
        },
      };
    }

    // ── Single-search branch (no facets) ──────────────────────────────
    const result = await this.client
      .collections<StorefrontDoc>(collectionName)
      .documents()
      .search(searchParams);

    return {
      hits: (result.hits ?? []).map((hit) => hit.document as SearchHit),
      // `found` is Typesense's true match count across the whole corpus,
      // independent of `per_page` — this is what the UI's "N matching" pill
      // wants to show.
      found: typeof result.found === 'number' ? result.found : 0,
    };
  }

  async indexDocument(doc: StorefrontDoc, region = 'US'): Promise<void> {
    await this.ensureCollection(region);
    await this.client
      .collections<StorefrontDoc>(collectionNameForRegion(region))
      .documents()
      .upsert(doc);
  }

  async indexDocuments(docs: StorefrontDoc[], region = 'US'): Promise<void> {
    if (docs.length === 0) return;
    await this.ensureCollection(region);
    await this.client
      .collections<StorefrontDoc>(collectionNameForRegion(region))
      .documents()
      .import(docs, { action: 'upsert' });
  }

  /**
   * Upsert a single group's document. Never throws — a failed index
   * is logged but must not block the stock write path that called us.
   * `doc.id` must be the groupId (consistent with scripts/typesense-sync.ts).
   */
  async indexGroup(doc: StorefrontDoc, region = 'US'): Promise<void> {
    try {
      await this.ensureCollection(region);
      await this.client
        .collections<StorefrontDoc>(collectionNameForRegion(region))
        .documents()
        .upsert(doc);
    } catch (err) {
      this.log.warn(`indexGroup(${doc.id}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Remove a group's document by id (groupId). Never throws — a 404 on
   * delete is a no-op, other errors are logged but must not block callers.
   */
  async deleteGroup(groupId: string, region = 'US'): Promise<void> {
    try {
      await this.ensureCollection(region);
      await this.client
        .collections<StorefrontDoc>(collectionNameForRegion(region))
        .documents(groupId)
        .delete();
    } catch (err) {
      // 404 Not Found is fine — doc already absent.
      const msg = (err as Error).message ?? '';
      if (!/not\s*found|404/i.test(msg)) {
        this.log.warn(`deleteGroup(${groupId}) failed: ${msg}`);
      }
    }
  }

  // ── Conversational search (RAG) ────────────────────────────────────────
  //
  // Typesense 28+ exposes `conversation: true` on the search endpoint. The
  // engine retrieves top-k hits, forwards them to an LLM along with the
  // question, and returns a synthesized answer grounded in the hits — all
  // in one call. Conversation history is auto-persisted into a collection
  // we pre-declare (CONV_HISTORY_COLLECTION) and continued across calls via
  // `conversation_id`.
  //
  // Provider: any OpenAI-compatible chat endpoint. We default to Groq since
  // GROQ_API_KEY is already wired into the stack for Scout.

  private convReady = false;
  private convModelId: string | null = null;

  /**
   * Idempotent: ensures both the conversation-history collection and the
   * conversation model exist. Returns the model id (stable across restarts
   * because we pin it to `restart-catalog-rag`).
   *
   * Env:
   *   GROQ_API_KEY  — required. Uses Groq's OpenAI-compatible endpoint.
   *   GROQ_RAG_MODEL — optional override, default llama-3.1-8b-instant.
   */
  async ensureConversationModel(): Promise<string> {
    if (this.convReady && this.convModelId) return this.convModelId;

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      throw new Error('GROQ_API_KEY not set — conversational search disabled');
    }
    const ragModel = process.env.GROQ_RAG_MODEL ?? 'llama-3.1-8b-instant';

    // 1. Ensure the conversation-history collection. Schema is fixed by
    //    Typesense (field names + types are checked on model create).
    try {
      await this.client.collections(CONV_HISTORY_COLLECTION).retrieve();
    } catch {
      await this.client.collections().create({
        name: CONV_HISTORY_COLLECTION,
        fields: [
          { name: 'conversation_id', type: 'string' as const },
          { name: 'model_id',        type: 'string' as const },
          { name: 'timestamp',       type: 'int32'  as const },
          { name: 'role',            type: 'string' as const, index: false },
          { name: 'message',         type: 'string' as const, index: false },
        ],
      });
    }

    // 2. Ensure the conversation model. We pin a stable id so boot is a
    //    get-or-create, not a create-every-time (which would leak models).
    const desiredModelId = 'restart-catalog-rag';
    try {
      const existing = await (this.client as any).conversations().models(desiredModelId).retrieve();
      this.convModelId = existing.id ?? desiredModelId;
    } catch {
      const created = await (this.client as any).conversations().models().create({
        id: desiredModelId,
        model_name: `openai/${ragModel}`,
        history_collection: CONV_HISTORY_COLLECTION,
        api_key: groqKey,
        openai_url: 'https://api.groq.com',
        openai_path: '/openai/v1/chat/completions',
        system_prompt:
          'You are a helpful product assistant for a wholesale electronics ' +
          'catalog. Answer questions about the products that were retrieved ' +
          'and included in context. When the data does not support an ' +
          'answer, say so plainly. Prefer concrete specs, prices, and ' +
          'condition grades over marketing language. Keep answers under ' +
          '120 words.',
        max_bytes: 16384,
      });
      this.convModelId = created.id ?? desiredModelId;
    }

    this.convReady = true;
    return this.convModelId!;
  }

  /**
   * Same shape as search(), but also runs a RAG pass: top-k hits are fed to
   * the conversation model and a synthesized answer is returned alongside
   * the raw hits. Pass `conversationId` to continue a prior exchange —
   * Typesense will include that history as LLM context.
   *
   * Never throws on the conversation layer: if the model setup fails, we
   * fall back to a plain search and return `{ ..., answer: null }`. The
   * keyword/semantic retrieval path is the source of truth.
   */
  async searchWithConversation(params: Parameters<TypesenseService['search']>[0] & {
    conversationId?: string;
  }): Promise<{
    hits: SearchHit[];
    found: number;
    answer: string | null;
    conversationId: string | null;
  }> {
    let modelId: string;
    try {
      modelId = await this.ensureConversationModel();
    } catch (err) {
      this.log.warn(`ensureConversationModel failed: ${(err as Error).message}`);
      const plain = await this.search(params);
      return { ...plain, answer: null, conversationId: null };
    }

    await this.ensureCollection();
    const filters: string[] = ['active:true'];
    if (params.category) filters.push(`category:${params.category}`);
    if (params.conditions?.length) {
      filters.push(`conditions:[${params.conditions.join(',')}]`);
    }
    if (typeof params.priceMinCents === 'number') {
      filters.push(`priceCents:>=${params.priceMinCents}`);
    }
    if (typeof params.priceMaxCents === 'number' && isFinite(params.priceMaxCents)) {
      filters.push(`priceCents:<=${params.priceMaxCents}`);
    }
    if (params.inStockOnly) filters.push('qty:>0');

    const searchParams: Record<string, string | number | boolean> = {
      q: params.q,
      query_by: 'name,description,brand,embedding',
      prefix: 'true,true,true,false',
      num_typos: '2,2,1,0',
      per_page: Math.min(params.limit ?? 8, 20),
      filter_by: filters.join(' && '),
      conversation: true,
      conversation_model_id: modelId,
    };
    if (params.conversationId) {
      searchParams['conversation_id'] = params.conversationId;
    }

    try {
      const result: any = await this.client
        .collections<StorefrontDoc>(COLLECTION_NAME)
        .documents()
        .search(searchParams as any);

      return {
        hits: (result.hits ?? []).map((h: any) => h.document as SearchHit),
        found: typeof result.found === 'number' ? result.found : 0,
        answer: result.conversation?.answer ?? null,
        conversationId: result.conversation?.conversation_id ?? null,
      };
    } catch (err) {
      this.log.warn(`searchWithConversation failed: ${(err as Error).message}`);
      const plain = await this.search(params);
      return { ...plain, answer: null, conversationId: null };
    }
  }
}

export const typesenseService = new TypesenseService();
