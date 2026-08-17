/**
 * Domain contract for the SideStage grounded-reply pipeline.
 *
 * The pipeline deliberately knows nothing about Nest, Postgres, Typesense, or
 * an LLM vendor. Adapters provide the retrieval/model/action seams so the
 * contest entry can keep grounding and automation policy testable in-process.
 */

export type AutomationLevel = 'suggest' | 'confirm' | 'auto';

/**
 * Provider-neutral reply voices supported by every Copilot generation path.
 * `professional` remains available to published policies even though the
 * event Settings surface currently exposes Warm, Playful, and Minimal.
 */
export const COPILOT_TONES = ['concise', 'warm', 'playful', 'professional'] as const;
export type CopilotTone = (typeof COPILOT_TONES)[number];

export function isCopilotTone(value: unknown): value is CopilotTone {
  return typeof value === 'string' && COPILOT_TONES.includes(value as CopilotTone);
}

export type CopilotActionKind =
  | 'markdown'
  | 'price-adjust'
  | 'targeted-offer'
  | 'push'
  | 'swap'
  | 'stock-adjust';

export interface EventItemContext {
  eventItemId: string;
  productId: string;
  title: string;
  description?: string;
  /** Current event price, in integer cents. */
  priceCents: number;
  availableQty: number;
  /**
   * True when this item is the one on stage. Optional because most grounding
   * paths do not observe stage presence; `listingStateOf` (copilot.claims)
   * reads it to derive a listing state rather than the domain storing one.
   * ActionEventItem already carried this field — declaring it on the base is a
   * de-duplication, not a new concept.
   */
  onStage?: boolean;
  attributes: Record<string, string | number | boolean>;
}

export interface CatalogProductContext {
  productId: string;
  title: string;
  description?: string;
  /** Catalog/base price, in integer cents. */
  priceCents: number;
  attributes: Record<string, string | number | boolean>;
}

/** A provider-neutral fact returned by the research fallback. */
export interface WebResearchFinding {
  findingId: string;
  title: string;
  snippet: string;
  url?: string;
  attributes?: Record<string, string | number | boolean>;
}

/** A seller transcript excerpt that can ground a buyer-facing reply. */
export interface TranscriptGroundingContext {
  transcriptId: string;
  text: string;
  startMs?: number;
  endMs?: number;
  productId?: string;
  productTitle?: string;
}

/** The Config tab's policy snapshot used for one copilot turn. */
export interface CopilotPolicy {
  automationLevel: AutomationLevel;
  allowAutoActions: boolean;
  priceFloorCentsByProduct: Record<string, number>;
  maxMarkdownPercent: number;
  blockedActionKinds: readonly CopilotActionKind[];
  tone: CopilotTone;
  /**
   * Action kinds the seller's always-ask guardrail toggles cap at 'confirm'
   * (WI-38815): buyer-sensitive → targeted-offer; inventory claims →
   * stock-adjust/swap. These kinds never auto-execute, regardless of model
   * confidence — the advertised Config toggles now reach the action boundary.
   */
  alwaysConfirmActionKinds?: readonly CopilotActionKind[];
  /**
   * Seller confidence floor for auto execution. INPUT to the decideAutomation
   * ladder, which stays the single enforcement engine — the platform floor
   * (GUARDRAILS_V1 automation.confidenceFloor.autoFloor) applies regardless,
   * and a draft with NO reported confidence reads as 0: auto never fires
   * unverified (WI-38815 fail-closed rule).
   */
  confidenceFloor?: number;
  /** Seller order-value ceiling for auto execution; platform bound applies regardless. */
  maxOrderValueCents?: number;
}

export interface GroundingSource {
  id: string;
  kind: 'event-item' | 'catalog-product' | 'web-research' | 'transcript' | 'policy';
  label: string;
}

export interface GroundingContext {
  eventItems: readonly EventItemContext[];
  catalogProducts: readonly CatalogProductContext[];
  transcriptMoments?: readonly TranscriptGroundingContext[];
  webFindings?: readonly WebResearchFinding[];
  policy: CopilotPolicy;
  /**
   * The seller's published shipping + returns policy for this turn.
   *
   * `policy` above is the AUTOMATION policy (floors, tone, what may auto-run);
   * it says nothing about shipping or returns, so a reply that answers "do you
   * take returns?" has no grounding without this. Optional because a turn that
   * never touches those subjects does not need it — and its ABSENCE is the
   * correct, checkable reason such a claim is unsupported (WI-39259/P-003),
   * rather than something to paper over with a default.
   */
  sellerPolicy?: {
    returns: import('../policies/policy.types').ReturnPolicy;
    shipping: import('../policies/policy.types').ShippingPolicy;
  };
  sources: readonly GroundingSource[];
}

export interface CopilotRequest {
  eventId: string;
  buyerId?: string;
  message: string;
  /** The seller's configured ladder; policy.automationLevel remains authoritative. */
  requestedAutomation?: AutomationLevel;
  maxSources?: number;
  /** Properties needed to answer a research-style question from the catalog. */
  requiredProperties?: readonly string[];
}

export interface CopilotActionProposal {
  kind: CopilotActionKind;
  productId: string;
  /** Quantity for a targeted offer or a stock adjustment; omitted otherwise. */
  quantity?: number;
  /** Proposed final price, in integer cents (price-bearing kinds only). */
  priceCents?: number;
  buyerId?: string;
  /** For a swap: the verified event item that replaces this one on stage. */
  swapToProductId?: string;
  reason: string;
}

export interface ModelDraft {
  reply: string;
  /** IDs must come from the supplied GroundingContext.sources list. */
  citations: readonly string[];
  action?: CopilotActionProposal;
  confidence?: number;
  /** Optional provider assertion used to fail closed on a tone mismatch. */
  tone?: CopilotPolicy['tone'];
  /** Provider-reported streaming timings, when the adapter can observe them. */
  latency?: {
    ttftMs?: number;
    completeMs?: number;
  };
  /**
   * Which reply engine actually produced this draft (e.g. 'vertex',
   * 'openai', 'deterministic'). Latency/benchmark provenance: without this,
   * a p95 measured against the deterministic fallback is indistinguishable
   * from one measured against the real provider.
   */
  provider?: string;
  /**
   * Set only when a real provider leg failed or returned an unparseable
   * response and this draft is therefore the FALLBACK, not the provider's
   * own answer. Undefined means the provider named by `provider` produced
   * this draft directly. Lets latency/error-rate accounting distinguish a
   * real provider failure from a clean response.
   */
  providerError?: string;
}

export interface RetrievalRequest {
  eventId: string;
  query: string;
  limit: number;
  requiredProperties?: readonly string[];
  /**
   * Shared cancellation for every research provider serving this request. A
   * provider that honours it stops work as soon as the reply no longer needs
   * it — whether the shared deadline expired or the caller went away. Results
   * that arrive after this aborts are discarded rather than merged, which is
   * what keeps a late finding out of a reply that has already been composed.
   */
  signal?: AbortSignal;
}

export interface GroundingRetriever {
  retrieve(request: RetrievalRequest): Promise<GroundingContext>;
}

export interface ReplyGenerationRequest {
  event: CopilotRequest;
  context: GroundingContext;
  /** Stable, provider-neutral prompt/context representation. */
  groundingPrompt: string;
}

export interface ReplyModel {
  generate(request: ReplyGenerationRequest): Promise<ModelDraft>;
}

export type GuardrailCode =
  | 'price-floor'
  | 'markdown-limit'
  | 'availability'
  | 'policy'
  | 'buyer-target'
  | 'tone'
  | 'invalid-action';

export interface GuardrailDecision {
  allowed: boolean;
  code?: GuardrailCode;
  explanation?: string;
}

export interface ActionGuard {
  evaluate(
    action: CopilotActionProposal,
    context: GroundingContext,
  ): Promise<GuardrailDecision>;
}

export interface ReplyGuardInput {
  reply: string;
  declaredTone?: CopilotPolicy['tone'];
}

export interface ReplyGuard {
  evaluate(
    input: ReplyGuardInput,
    context: GroundingContext,
  ): Promise<GuardrailDecision>;
}

export interface ActionExecutionResult {
  auditId: string;
  status: 'executed';
}

export interface ActionExecutor {
  execute(
    action: CopilotActionProposal,
    metadata: { eventId: string; buyerId?: string },
  ): Promise<ActionExecutionResult>;
}

export type ActionDisposition =
  | 'suggested'
  | 'awaiting-confirmation'
  | 'executed'
  | 'blocked';

export interface ActionResult {
  proposal: CopilotActionProposal;
  disposition: ActionDisposition;
  guardrail: GuardrailDecision;
  execution?: ActionExecutionResult;
  /**
   * The automation-ladder decision that produced this disposition (WI-38815):
   * effective level, reason codes (e.g. CONFIDENCE_BELOW_FLOOR) and audit id —
   * so a downgraded action is explainable, not silent.
   */
  automation?: import('../policies/policy.types').AutomationDecision;
}

/** The current request sample plus rolling p50/p95 observations. */
export interface CopilotLatency {
  ttftMs: number | null;
  completeMs: number;
  sampleCount: number;
  p50: {
    ttftMs: number | null;
    completeMs: number | null;
  };
  p95: {
    ttftMs: number | null;
    completeMs: number | null;
  };
  /** Which engine produced THIS sample ('vertex', 'openai', 'deterministic', 'unknown'). */
  provider: string;
  /** Fraction (0..1) of the samples in the current window whose provider leg errored/fell back. */
  errorRate: number;
}

export interface CopilotResponse {
  reply: string;
  grounding: 'grounded' | 'insufficient-context';
  citations: readonly string[];
  context: GroundingContext;
  replyGuardrail?: GuardrailDecision;
  action?: ActionResult;
  latencyMs: number;
  latency: CopilotLatency;
  /**
   * Set when a research round for `requiredProperties` was KNOWINGLY partial —
   * a provider timed out, failed, or was cancelled. It is the reason a reply
   * that otherwise looks well-formed is not `grounded`: the properties the
   * question turned on were never verified, so the seller must not be offered
   * a sendable draft. Carries the per-provider reasons so the block is
   * explainable rather than mysterious.
   */
  researchIncomplete?: ResearchIncompleteReport;
}

/** Why a property-backed reply could not be verified within its budget. */
export interface ResearchIncompleteReport {
  requiredProperties: readonly string[];
  degraded: readonly {
    provider: 'catalog' | 'web';
    reason: 'deadline-exceeded' | 'provider-failed' | 'cancelled';
    detail?: string;
  }[];
}
