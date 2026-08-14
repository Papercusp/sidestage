import type {
  ActionExecutor,
  ActionGuard,
  ActionResult,
  AutomationLevel,
  CopilotActionProposal,
  CopilotRequest,
  CopilotResponse,
  GroundingContext,
  GroundingRetriever,
  ReplyGuard,
  ReplyModel,
} from './copilot.types';
import { decideAutomation, GUARDRAILS_V1 } from '../policies/policy-rules';
import type { AutomationDecision } from '../policies/policy.types';
import { PolicyActionGuard, PolicyReplyGuard } from './guardrail';
import { CopilotLatencyBudget } from './latency';
import { mergeResearchIntoGroundingContext, type ParallelResearchFallback } from './research';
import { sourceSupportsQuestion } from './copilot.relevance';

export interface CopilotPipelineDependencies {
  retriever: GroundingRetriever;
  model: ReplyModel;
  guard?: ActionGuard;
  replyGuard?: ReplyGuard;
  executor?: ActionExecutor;
  now?: () => number;
  latencyBudget?: CopilotLatencyBudget;
  /** Optional property-aware catalog/web fallback for research-style turns. */
  researchFallback?: ParallelResearchFallback;
  /** Cap policy automation for review-queue compositions that never execute during generation. */
  automationCeiling?: AutomationLevel;
}

const FALLBACK_REPLY =
  "I don't have enough verified event or catalog information to answer that yet.";

/**
 * Builds the provider-neutral context sent to the reply model.
 *
 * Keeping this representation deterministic makes prompt snapshots and
 * latency tests independent of the eventual OpenAI SDK adapter.
 */
export function buildGroundingPrompt(context: GroundingContext): string {
  const eventItems = context.eventItems.map((item) => ({
    sourceId: `event-item:${item.eventItemId}`,
    productId: item.productId,
    title: item.title,
    description: item.description ?? null,
    priceCents: item.priceCents,
    availableQty: item.availableQty,
    attributes: item.attributes,
  }));
  const catalogProducts = context.catalogProducts.map((product) => ({
    sourceId: `catalog-product:${product.productId}`,
    productId: product.productId,
    title: product.title,
    description: product.description ?? null,
    priceCents: product.priceCents,
    attributes: product.attributes,
  }));
  const webFindings = (context.webFindings ?? []).map((finding) => ({
    sourceId: `web-research:${finding.findingId}`,
    title: finding.title,
    snippet: finding.snippet,
    url: finding.url ?? null,
    attributes: finding.attributes ?? {},
  }));
  const transcriptMoments = (context.transcriptMoments ?? []).map((moment) => ({
    sourceId: `transcript:${moment.transcriptId}`,
    transcriptId: moment.transcriptId,
    text: moment.text,
    startMs: moment.startMs ?? null,
    productId: moment.productId ?? null,
    productTitle: moment.productTitle ?? null,
  }));

  return [
    'You are the SideStage seller copilot. Answer only from VERIFIED_CONTEXT.',
    'If the context does not support an answer, say that plainly; do not invent price, stock, or product facts.',
    'Return citation IDs for every factual answer. Never execute an action; return a proposal for the caller to gate.',
    `Use the required ${context.policy.tone} tone and return it as tone when the provider supports tone metadata.`,
    'VERIFIED_CONTEXT:',
    JSON.stringify({
      eventItems,
      catalogProducts,
      transcriptMoments,
      webFindings,
      policy: context.policy,
      sources: context.sources,
    }),
  ].join('\n');
}

function validCitations(draftCitations: readonly string[], context: GroundingContext): string[] {
  const known = new Set(context.sources.map((source) => source.id));
  return [...new Set(draftCitations)].filter((citation) => known.has(citation));
}

const AUTOMATION_RANK: Record<AutomationLevel, number> = {
  suggest: 0,
  confirm: 1,
  auto: 2,
};

function effectiveAutomation(
  context: GroundingContext,
  ceiling: AutomationLevel | undefined,
): AutomationLevel {
  // The Config snapshot is authoritative. A caller cannot elevate a seller's
  // policy by sending requestedAutomation:'auto' in a request body.
  if (!ceiling || AUTOMATION_RANK[context.policy.automationLevel] <= AUTOMATION_RANK[ceiling]) {
    return context.policy.automationLevel;
  }
  return ceiling;
}

/** Order value of a price-bearing proposal, for the automation ladder's ceiling. */
function proposalOrderValueCents(action: CopilotActionProposal): number | null {
  if (typeof action.priceCents !== 'number' || !Number.isFinite(action.priceCents)) return null;
  const quantity = typeof action.quantity === 'number' && action.quantity > 0 ? action.quantity : 1;
  return Math.round(action.priceCents * quantity);
}

async function resolveAction(
  request: CopilotRequest,
  context: GroundingContext,
  guard: ActionGuard,
  executor: ActionExecutor | undefined,
  action: CopilotActionProposal,
  modelConfidence: number | undefined,
  automationCeiling: AutomationLevel | undefined,
): Promise<ActionResult> {
  const guardrail = await guard.evaluate(action, context);
  if (!guardrail.allowed) {
    return { proposal: action, disposition: 'blocked', guardrail };
  }

  const policy = context.policy;
  const effectiveLevel = effectiveAutomation(context, automationCeiling);
  // WI-38815: the Config tab's always-ask toggles reach the action boundary —
  // a kind listed there is capped at 'confirm' no matter how confident the model is.
  const alwaysConfirm = policy.alwaysConfirmActionKinds?.includes(action.kind) ?? false;

  // WI-38815: the automation ladder (decideAutomation) is now the ONLY path to
  // 'executed'. Confidence is fail-closed: a draft that reports none reads as 0,
  // so auto never fires unverified; the platform floor applies even when the
  // seller policy carries no explicit floor.
  const decision = decideAutomation(
    {
      automationLevel: alwaysConfirm && effectiveLevel === 'auto' ? 'confirm' : effectiveLevel,
      allowAutoActions: policy.allowAutoActions,
      priceFloorCentsByProduct: { ...policy.priceFloorCentsByProduct },
      maxMarkdownPercent: policy.maxMarkdownPercent,
      blockedActionKinds: [...policy.blockedActionKinds],
      tone: policy.tone,
      confidenceFloor: policy.confidenceFloor ?? GUARDRAILS_V1['automation.confidenceFloor'].autoFloor,
      maxOrderValueCents: policy.maxOrderValueCents ?? GUARDRAILS_V1['automation.maxOrderValueCents'].max,
    },
    {
      requestedLevel: effectiveLevel,
      confidence:
        typeof modelConfidence === 'number' && Number.isFinite(modelConfidence) ? modelConfidence : 0,
      // Price moves are bounded upstream by PolicyActionGuard floors/caps.
      priceDeltaBps: null,
      orderValueCents: proposalOrderValueCents(action),
      hasHardError: false,
    },
    {
      policyRevisionId: null,
      auditId: `pipeline:${request.eventId}:${action.kind}:${action.productId}`,
    },
  );

  if (decision.outcome === 'suggested') {
    return { proposal: action, disposition: 'suggested', guardrail, automation: decision };
  }
  if (decision.outcome === 'awaiting-confirmation' || decision.outcome === 'blocked') {
    return { proposal: action, disposition: 'awaiting-confirmation', guardrail, automation: decision };
  }

  // Auto mode is fail-closed: a missing executor cannot turn an approved
  // proposal into an un-audited side effect.
  if (!context.policy.allowAutoActions || !executor) {
    return {
      proposal: action,
      disposition: 'blocked',
      automation: decision,
      guardrail: {
        allowed: false,
        code: 'policy',
        explanation: !context.policy.allowAutoActions
          ? 'Automatic actions are disabled by seller policy.'
          : 'No audited action executor is configured.',
      },
    };
  }

  const execution = await executor.execute(action, {
    eventId: request.eventId,
    buyerId: request.buyerId,
  });
  return { proposal: action, disposition: 'executed', guardrail, execution, automation: decision };
}

export class GroundedCopilotPipeline {
  private readonly now: () => number;
  private readonly guard: ActionGuard;
  private readonly replyGuard: ReplyGuard;
  private readonly latencyBudget: CopilotLatencyBudget;

  constructor(private readonly dependencies: CopilotPipelineDependencies) {
    this.now = dependencies.now ?? (() => Date.now());
    this.guard = dependencies.guard ?? new PolicyActionGuard();
    this.replyGuard = dependencies.replyGuard ?? new PolicyReplyGuard();
    this.latencyBudget = dependencies.latencyBudget ?? new CopilotLatencyBudget();
  }

  async respond(request: CopilotRequest): Promise<CopilotResponse> {
    const started = this.now();
    const retrievalRequest = {
      eventId: request.eventId,
      query: request.message,
      limit: Math.max(1, Math.min(request.maxSources ?? 8, 20)),
      requiredProperties: request.requiredProperties,
    };
    const [baseContext, research] = await Promise.all([
      this.dependencies.retriever.retrieve(retrievalRequest),
      this.dependencies.researchFallback && request.requiredProperties?.length
        ? this.dependencies.researchFallback.retrieve(retrievalRequest)
        : Promise.resolve(undefined),
    ]);
    const context = research ? mergeResearchIntoGroundingContext(baseContext, research) : baseContext;
    const draft = await this.dependencies.model.generate({
      event: request,
      context,
      groundingPrompt: buildGroundingPrompt(context),
    });
    const citations = validCitations(draft.citations, context).filter((citation) => (
      sourceSupportsQuestion(citation, request, context)
      || Boolean(draft.action && citation === `policy:${request.eventId}`)
    ));
    const replyGuardrail = await this.replyGuard.evaluate({ reply: draft.reply, declaredTone: draft.tone }, context);
    const grounded = replyGuardrail.allowed && draft.reply.trim().length > 0 && citations.length > 0;
    const action = draft.action
      ? replyGuardrail.allowed
        ? await resolveAction(
          request,
          context,
          this.guard,
          this.dependencies.executor,
          draft.action,
          draft.confidence,
          this.dependencies.automationCeiling,
        )
        : undefined
      : undefined;

    const completeMs = draft.latency?.completeMs ?? Math.max(0, this.now() - started);
    const ttftMs = typeof draft.latency?.ttftMs === 'number' && Number.isFinite(draft.latency.ttftMs)
      ? Math.max(0, draft.latency.ttftMs)
      : null;
    const latency = this.latencyBudget.record({ ttftMs, completeMs });

    return {
      reply: grounded
        ? draft.reply.trim()
        : replyGuardrail.allowed
          ? FALLBACK_REPLY
          : `I can't send that yet. ${replyGuardrail.explanation ?? 'The event policy blocked this draft.'}`,
      grounding: grounded ? 'grounded' : 'insufficient-context',
      citations,
      context,
      replyGuardrail,
      action,
      latencyMs: latency.completeMs,
      latency,
    };
  }
}
