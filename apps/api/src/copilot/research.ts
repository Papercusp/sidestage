import type {
  CatalogProductContext,
  GroundingContext,
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

/** Which research provider a degradation is about. */
export type ResearchProvider = 'catalog' | 'web';

/**
 * Why a provider contributed nothing. Kept distinct because they are not the
 * same operational fault: `deadline-exceeded` means the budget was too small
 * (or the provider too slow), `provider-failed` means it errored, `cancelled`
 * means the caller abandoned the reply. Collapsing them would hide which one
 * is happening in production.
 */
export type ResearchDegradationReason = 'deadline-exceeded' | 'provider-failed' | 'cancelled';

export interface ResearchDegradation {
  provider: ResearchProvider;
  reason: ResearchDegradationReason;
  detail?: string;
}

export interface ResearchFallbackResult {
  catalogProducts: readonly CatalogProductContext[];
  webFindings: readonly WebResearchFinding[];
  usedWebFallback: boolean;
  /**
   * True when at least one provider was dropped, so the grounding context is
   * KNOWINGLY partial. Callers must not read an empty result as "researched
   * and found nothing" — that conflation is what lets an unverified reply
   * look grounded.
   */
  incomplete: boolean;
  /** Provenance for every provider that was dropped, and why. */
  degraded: readonly ResearchDegradation[];
}

/**
 * Shared wall-clock budget for a whole research round. It is deliberately a
 * budget for BOTH providers together rather than per-provider: a per-provider
 * timeout lets a two-provider round take twice as long as the number anyone
 * reasoned about.
 */
export const DEFAULT_RESEARCH_DEADLINE_MS = 2_500;

export interface ResearchFallbackOptions {
  /** Shared budget for the whole round. Defaults to DEFAULT_RESEARCH_DEADLINE_MS. */
  deadlineMs?: number;
}

/** Marks the abort that OUR deadline caused, so it is distinguishable from a caller cancel. */
class ResearchDeadlineExceeded extends Error {
  constructor(readonly deadlineMs: number) {
    super(`Research deadline of ${deadlineMs}ms exceeded`);
    this.name = 'ResearchDeadlineExceeded';
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the catalog search alone when its indexed properties are sufficient.
 * When they are not, both source calls are started together so a slow web
 * provider does not add a second catalog round trip to the latency budget.
 *
 * Three properties this class is responsible for, all of which a seller-facing
 * reply depends on:
 *
 *  - SHARED DEADLINE. One budget covers the whole round and is handed to every
 *    provider as one AbortSignal, so research cannot silently become the
 *    slowest thing in the request.
 *  - SAFE INCOMPLETE CONTEXT. A provider that fails or times out contributes
 *    nothing and is REPORTED; it never rejects the round. Research is an
 *    enrichment, so a dead web provider must degrade the reply's grounding,
 *    not delete the reply.
 *  - NO LATE RESULTS. A value that arrives after the deadline (or a cancel) is
 *    discarded rather than merged. Without this, a slow provider could land a
 *    finding in a context that had already been judged complete, and the reply
 *    would cite something that was never verified against the budget.
 */
export class ParallelResearchFallback {
  private readonly deadlineMs: number;

  constructor(
    private readonly catalog: CatalogResearchSource,
    private readonly web: WebResearchSource,
    options: ResearchFallbackOptions = {},
  ) {
    this.deadlineMs = options.deadlineMs ?? DEFAULT_RESEARCH_DEADLINE_MS;
  }

  /**
   * The capability probe is synchronous adapter metadata, but a broken adapter
   * can still throw. Fail towards the WEB FALLBACK rather than towards the
   * catalog: an unanswerable probe means we cannot prove the catalog covers
   * the properties, and answering from a catalog that may not cover them is
   * exactly the unverified-reply failure this class exists to prevent.
   */
  private supportsProperties(
    requiredProperties: readonly string[],
    degraded: ResearchDegradation[],
  ): boolean {
    try {
      return this.catalog.supportsProperties(requiredProperties);
    } catch (error) {
      degraded.push({ provider: 'catalog', reason: 'provider-failed', detail: detailOf(error) });
      return false;
    }
  }

  async retrieve(request: RetrievalRequest): Promise<ResearchFallbackResult> {
    const requiredProperties = request.requiredProperties ?? [];
    const controller = new AbortController();
    const degraded: ResearchDegradation[] = [];
    let deadlineHit = false;

    const forwardCallerAbort = () => controller.abort(request.signal?.reason);
    if (request.signal) {
      if (request.signal.aborted) controller.abort(request.signal.reason);
      else request.signal.addEventListener('abort', forwardCallerAbort, { once: true });
    }

    const timer = setTimeout(() => {
      deadlineHit = true;
      controller.abort(new ResearchDeadlineExceeded(this.deadlineMs));
    }, this.deadlineMs);
    // A pending research timer must never hold the process open on its own.
    (timer as { unref?: () => void }).unref?.();

    const signal = controller.signal;
    // Every provider gets the SAME signal — that is what makes the budget shared.
    const scoped: RetrievalRequest = { ...request, signal };

    /**
     * Resolve to the provider's value, or to `undefined` with a recorded
     * degradation. Never rejects, and never resolves with a value produced
     * after the signal aborted.
     */
    const settle = <T>(provider: ResearchProvider, work: Promise<T>): Promise<T | undefined> =>
      new Promise<T | undefined>((resolve) => {
        let settled = false;
        const finish = (value: T | undefined) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        };
        function onAbort() {
          degraded.push({
            provider,
            reason: deadlineHit ? 'deadline-exceeded' : 'cancelled',
            detail: detailOf(signal.reason),
          });
          finish(undefined);
        }

        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });

        work.then(
          (value) => {
            // LATE. The round already closed; merging this now would put an
            // unbudgeted finding into an already-composed reply.
            if (signal.aborted) return;
            finish(value);
          },
          (error) => {
            if (!signal.aborted) {
              degraded.push({ provider, reason: 'provider-failed', detail: detailOf(error) });
            }
            finish(undefined);
          },
        );
      });

    try {
      // `Promise.resolve().then(...)` so a provider that throws SYNCHRONOUSLY is
      // funnelled into settle()'s degradation path like any other failure,
      // instead of escaping past it and rejecting the whole round.
      const catalogPromise = settle('catalog', Promise.resolve().then(() => this.catalog.search(scoped)));
      const needsWebFallback =
        requiredProperties.length > 0 && !this.supportsProperties(requiredProperties, degraded);

      if (!needsWebFallback) {
        const catalog = await catalogPromise;
        return {
          catalogProducts: catalog?.products ?? [],
          webFindings: [],
          usedWebFallback: false,
          incomplete: degraded.length > 0,
          degraded,
        };
      }

      const [catalog, webFindings] = await Promise.all([
        catalogPromise,
        settle('web', Promise.resolve().then(() => this.web.search(scoped))),
      ]);
      return {
        catalogProducts: catalog?.products ?? [],
        webFindings: webFindings ?? [],
        usedWebFallback: true,
        incomplete: degraded.length > 0,
        degraded,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', forwardCallerAbort);
      // Close the round for good: any provider still running is now working on
      // a reply nobody will read, and anything it returns is by definition late.
      controller.abort();
    }
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
