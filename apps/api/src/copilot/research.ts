import type {
  CatalogProductContext,
  GroundingContext,
  GroundingRetriever,
  GroundingSource,
  RetrievalRequest,
  WebResearchFinding,
} from './copilot.types';

export interface CatalogResearchResult {
  products: readonly CatalogProductContext[];
}

/** Catalog adapter contract. The capability probe is synchronous metadata. */
export interface CatalogResearchSource {
  supportsProperties(requiredProperties: readonly string[]): boolean;
  search(request: RetrievalRequest): Promise<CatalogResearchResult>;
}

export interface WebResearchSource {
  search(request: RetrievalRequest): Promise<readonly WebResearchFinding[]>;
}

export interface ResearchFallbackResult {
  catalogProducts: readonly CatalogProductContext[];
  webFindings: readonly WebResearchFinding[];
  usedWebFallback: boolean;
}

/**
 * Runs the catalog search alone when its indexed properties are sufficient.
 * When they are not, both source calls are started together so a slow web
 * provider does not add a second catalog round trip to the latency budget.
 */
export class ParallelResearchFallback {
  constructor(
    private readonly catalog: CatalogResearchSource,
    private readonly web: WebResearchSource,
  ) {}

  async retrieve(request: RetrievalRequest): Promise<ResearchFallbackResult> {
    const requiredProperties = request.requiredProperties ?? [];
    const catalogPromise = this.catalog.search(request);
    const needsWebFallback =
      requiredProperties.length > 0 && !this.catalog.supportsProperties(requiredProperties);

    if (!needsWebFallback) {
      const catalog = await catalogPromise;
      return {
        catalogProducts: catalog.products,
        webFindings: [],
        usedWebFallback: false,
      };
    }

    const [catalog, webFindings] = await Promise.all([
      catalogPromise,
      this.web.search(request),
    ]);
    return {
      catalogProducts: catalog.products,
      webFindings,
      usedWebFallback: true,
    };
  }
}

function catalogSource(product: CatalogProductContext): GroundingSource {
  return {
    id: `catalog-product:${product.productId}`,
    kind: 'catalog-product',
    label: `${product.title} catalog record`,
  };
}

function webSource(finding: WebResearchFinding): GroundingSource {
  return {
    id: `web-research:${finding.findingId}`,
    kind: 'web-research',
    label: finding.title,
  };
}

/** Merge provider-neutral research results into the context sent to the model. */
export function mergeResearchIntoGroundingContext(
  context: GroundingContext,
  result: ResearchFallbackResult,
): GroundingContext {
  const catalogById = new Map(context.catalogProducts.map((product) => [product.productId, product]));
  const addedCatalogSources: GroundingSource[] = [];
  for (const product of result.catalogProducts) {
    if (catalogById.has(product.productId)) continue;
    catalogById.set(product.productId, product);
    addedCatalogSources.push(catalogSource(product));
  }

  const existingFindingIds = new Set((context.webFindings ?? []).map((finding) => finding.findingId));
  const addedFindings = result.webFindings.filter((finding) => !existingFindingIds.has(finding.findingId));
  const existingSourceIds = new Set(context.sources.map((source) => source.id));
  const addedSources = [...addedCatalogSources, ...addedFindings.map(webSource)]
    .filter((source) => !existingSourceIds.has(source.id));

  return {
    ...context,
    catalogProducts: [...catalogById.values()],
    webFindings: [...(context.webFindings ?? []), ...addedFindings],
    sources: [...context.sources, ...addedSources],
  };
}

/**
 * Adapter helper for existing grounded pipelines. The base retriever supplies
 * event/policy context while the optional fallback adds research facts.
 */
export function withResearchFallback(
  base: GroundingRetriever,
  fallback: ParallelResearchFallback,
): GroundingRetriever {
  return {
    retrieve: async (request) => {
      const [context, result] = await Promise.all([
        base.retrieve(request),
        fallback.retrieve(request),
      ]);
      return mergeResearchIntoGroundingContext(context, result);
    },
  };
}
