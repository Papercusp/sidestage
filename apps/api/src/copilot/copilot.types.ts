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
}

export interface RetrievalRequest {
  eventId: string;
  query: string;
  limit: number;
  requiredProperties?: readonly string[];
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
}
