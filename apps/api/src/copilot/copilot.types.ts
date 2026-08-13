/**
 * Domain contract for the SideStage grounded-reply pipeline.
 *
 * The pipeline deliberately knows nothing about Nest, Postgres, Typesense, or
 * an LLM vendor. Adapters provide the retrieval/model/action seams so the
 * contest entry can keep grounding and automation policy testable in-process.
 */

export type AutomationLevel = 'suggest' | 'confirm' | 'auto';

export type CopilotActionKind = 'markdown' | 'price-adjust' | 'targeted-offer';

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

/** The Config tab's policy snapshot used for one copilot turn. */
export interface CopilotPolicy {
  automationLevel: AutomationLevel;
  allowAutoActions: boolean;
  priceFloorCentsByProduct: Record<string, number>;
  maxMarkdownPercent: number;
  blockedActionKinds: readonly CopilotActionKind[];
  tone: 'concise' | 'warm' | 'professional';
}

export interface GroundingSource {
  id: string;
  kind: 'event-item' | 'catalog-product' | 'policy';
  label: string;
}

export interface GroundingContext {
  eventItems: readonly EventItemContext[];
  catalogProducts: readonly CatalogProductContext[];
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
}

export interface CopilotActionProposal {
  kind: CopilotActionKind;
  productId: string;
  /** Quantity for a targeted offer; omitted for a pure price/markdown change. */
  quantity?: number;
  /** Proposed final price, in integer cents. */
  priceCents?: number;
  buyerId?: string;
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
}

export interface RetrievalRequest {
  eventId: string;
  query: string;
  limit: number;
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
}

export interface CopilotResponse {
  reply: string;
  grounding: 'grounded' | 'insufficient-context';
  citations: readonly string[];
  context: GroundingContext;
  replyGuardrail?: GuardrailDecision;
  action?: ActionResult;
  latencyMs: number;
}
