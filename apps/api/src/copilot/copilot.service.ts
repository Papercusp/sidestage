import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { GuardedActionService } from '../actions/action.service';
import { ChatService, type ChatMessage } from '../chat/chat.service';
import { AutoResponderJudgeService } from '../judge/judge.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { PolicyReplyGuard } from './guardrail';
import { citedEvidenceDrift } from './copilot.claims';
import { GroundedCopilotPipeline } from './copilot.pipeline';
import type { GroundingContext, GroundingRetriever } from './copilot.types';
import { SideStageGroundingRetriever } from './copilot.grounding';
import {
  COPILOT_PIPELINE,
  COPILOT_PROPOSAL_STORE,
  type ConfirmCopilotActionInput,
  type CopilotProposal,
  type CopilotProposalStore,
  type CopilotQuestion,
  type CreateCopilotTurnInput,
  type ReviewCopilotReplyInput,
} from './copilot.runtime.types';

function groundingFingerprint(context: GroundingContext): string {
  const stable = {
    eventItems: [...context.eventItems].sort((a, b) => a.productId.localeCompare(b.productId)),
    catalogProducts: [...context.catalogProducts].sort((a, b) => a.productId.localeCompare(b.productId)),
    transcriptMoments: [...(context.transcriptMoments ?? [])].sort((a, b) => a.transcriptId.localeCompare(b.transcriptId)),
    policy: context.policy,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function emptyContext(): GroundingContext {
  return {
    eventItems: [],
    catalogProducts: [],
    transcriptMoments: [],
    policy: {
      automationLevel: 'confirm',
      allowAutoActions: false,
      priceFloorCentsByProduct: {},
      maxMarkdownPercent: 0,
      blockedActionKinds: [],
      tone: 'warm',
    },
    sources: [],
  };
}

@Injectable()
export class CopilotProposalService {
  private readonly replyGuard = new PolicyReplyGuard();
  private readonly generationBySource = new Map<string, Promise<CopilotProposal>>();
  private readonly reconciliationByEvent = new Map<string, Promise<void>>();

  constructor(
    @Inject(COPILOT_PIPELINE) private readonly pipeline: GroundedCopilotPipeline,
    @Inject(COPILOT_PROPOSAL_STORE) private readonly store: CopilotProposalStore,
    @Inject(SideStageGroundingRetriever) private readonly retriever: GroundingRetriever,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(AutoResponderJudgeService) private readonly judge: AutoResponderJudgeService,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
  ) {}

  async list(eventId: string): Promise<CopilotProposal[]> {
    await this.reconcileQueuedQuestions(eventId);
    return this.store.list(eventId);
  }

  /** Lookup seam used only to owner-check secondary proposal identifiers. */
  find(id: string): Promise<CopilotProposal | undefined> {
    return this.store.get(id);
  }

  async createFromChat(message: ChatMessage): Promise<CopilotProposal> {
    return this.generateOnce({
      id: message.id,
      eventId: message.eventId,
      buyerId: message.userId,
      buyerName: message.displayName,
      text: message.text,
      createdAt: message.createdAt,
    });
  }

  async createManual(eventId: string, input: CreateCopilotTurnInput): Promise<CopilotProposal> {
    const text = input?.message?.trim();
    if (!text) throw new BadRequestException('message is required');
    const now = new Date().toISOString();
    // Blank/whitespace entries are dropped rather than passed through: an empty
    // property name can never be satisfied by any source, so keeping one would
    // permanently force the incomplete-research block on for that turn.
    const requiredProperties = (input.requiredProperties ?? [])
      .map((property) => property.trim())
      .filter((property) => property.length > 0);
    return this.generateOnce({
      id: input.sourceMessageId?.trim() || `manual-${randomUUID()}`,
      eventId,
      buyerId: input.buyerId?.trim() || 'seller-research',
      buyerName: input.buyerName?.trim() || 'Seller research',
      text,
      createdAt: now,
      ...(requiredProperties.length ? { requiredProperties } : {}),
    });
  }

  async approve(id: string, input: ReviewCopilotReplyInput): Promise<CopilotProposal> {
    const proposal = await this.required(id);
    if ((proposal.status === 'approved' || proposal.status === 'executed') && proposal.decision?.sentMessageId) {
      await this.syncQuestionState(proposal);
      return proposal;
    }
    this.requireReviewable(proposal, 'reply');
    const fresh = await this.freshContext(proposal);
    await this.blockIfStale(proposal, fresh);
    const reply = input?.reply?.trim() || proposal.reply;
    const guardrail = await this.replyGuard.evaluate({ reply }, fresh);
    if (!guardrail.allowed) throw new BadRequestException(guardrail.explanation);
    const report = await this.judge.run({
      cases: [{
        id: proposal.id,
        question: proposal.question.text,
        reply,
        citations: proposal.citations,
        context: fresh,
      }],
    });
    if (!report.passed) {
      const failures = Object.values(report.cases[0]!.dimensions)
        .filter((dimension) => !dimension.passed)
        .map((dimension) => dimension.rationale)
        .join(' ');
      throw new BadRequestException(`Reply failed grounded review. ${failures}`);
    }
    const actorId = input?.actorId?.trim() || 'seller-copilot-review';
    const sent = await this.chat.addCopilotReply(proposal.eventId, {
      actorId,
      text: reply,
      proposalId: proposal.id,
      sourceMessageId: proposal.sourceMessageId,
      edited: reply !== proposal.reply,
      citationSourceIds: proposal.citations,
    });
    const updated = await this.transition(proposal, {
      ...proposal,
      reply,
      context: fresh,
      groundingFingerprint: groundingFingerprint(fresh),
      replyGuardrail: guardrail,
      status: proposal.status === 'executed' ? 'executed' : 'approved',
      decision: { ...proposal.decision, actorId, decidedAt: new Date().toISOString(), sentMessageId: sent.id },
    });
    await this.syncQuestionState(updated);
    return updated;
  }

  async skip(id: string, input: ReviewCopilotReplyInput): Promise<CopilotProposal> {
    const proposal = await this.required(id);
    if (proposal.status === 'skipped') {
      await this.syncQuestionState(proposal);
      return proposal;
    }
    this.requirePending(proposal);
    const actorId = input?.actorId?.trim() || 'seller-copilot-review';
    const updated = await this.transition(proposal, {
      ...proposal,
      status: 'skipped',
      decision: { actorId, decidedAt: new Date().toISOString() },
    });
    await this.syncQuestionState(updated);
    return updated;
  }

  async confirmAction(id: string, input: ConfirmCopilotActionInput): Promise<CopilotProposal> {
    const proposal = await this.required(id);
    if (proposal.status === 'executed' && proposal.decision?.auditId) return proposal;
    this.requireReviewable(proposal, 'action');
    if (!proposal.action || proposal.action.disposition === 'blocked') {
      throw new BadRequestException('This proposal has no executable guarded action');
    }
    const fresh = await this.freshContext(proposal);
    await this.blockIfStale(proposal, fresh);
    const actorId = input?.actorId?.trim() || 'seller-copilot-review';
    const execution = await this.actions.apply({
      eventId: proposal.eventId,
      actorId,
      action: proposal.action.proposal,
      clientRequestId: `copilot-proposal:${proposal.id}:action`,
    });
    return this.transition(proposal, {
      ...proposal,
      context: fresh,
      groundingFingerprint: groundingFingerprint(fresh),
      status: 'executed',
      decision: { ...proposal.decision, actorId, decidedAt: new Date().toISOString(), auditId: execution.auditId },
    });
  }

  private async generateOnce(question: CopilotQuestion): Promise<CopilotProposal> {
    const key = `${question.eventId}\u0000${question.id}`;
    const active = this.generationBySource.get(key);
    if (active) return active;
    const generation = this.generate(question).finally(() => {
      if (this.generationBySource.get(key) === generation) this.generationBySource.delete(key);
    });
    this.generationBySource.set(key, generation);
    return generation;
  }

  private async generate(question: CopilotQuestion): Promise<CopilotProposal> {
    const existing = await this.store.findBySourceMessage(question.eventId, question.id);
    if (existing) {
      await this.syncQuestionState(existing);
      return existing;
    }
    const now = new Date().toISOString();
    try {
      const response = await this.pipeline.respond({
        eventId: question.eventId,
        buyerId: question.buyerId,
        message: question.text,
        ...(question.requiredProperties?.length
          ? { requiredProperties: question.requiredProperties }
          : {}),
      });
      const proposal: CopilotProposal = {
        id: randomUUID(),
        eventId: question.eventId,
        sourceMessageId: question.id,
        question,
        reply: response.reply,
        citations: [...response.citations],
        context: response.context,
        groundingFingerprint: groundingFingerprint(response.context),
        replyGuardrail: response.replyGuardrail ?? { allowed: false, explanation: 'Reply guard did not run.' },
        action: response.action,
        latencyMs: response.latencyMs,
        status: response.grounding === 'grounded' && response.replyGuardrail?.allowed ? 'pending' : 'blocked',
        revision: 1,
        ...(
          response.grounding === 'grounded'
            ? {}
            : { error: 'Verified context was insufficient to produce a buyer-facing reply.' }
        ),
        createdAt: now,
        updatedAt: now,
      };
      await this.store.put(proposal);
      const persisted = await this.store.findBySourceMessage(question.eventId, question.id) ?? proposal;
      await this.syncQuestionState(persisted);
      this.invalidate(question.eventId);
      return persisted;
    } catch (error) {
      const context = emptyContext();
      const proposal: CopilotProposal = {
        id: randomUUID(),
        eventId: question.eventId,
        sourceMessageId: question.id,
        question,
        reply: "I couldn't prepare a verified reply yet.",
        citations: [],
        context,
        groundingFingerprint: groundingFingerprint(context),
        replyGuardrail: { allowed: false, code: 'policy', explanation: 'Copilot generation failed closed.' },
        status: 'blocked',
        revision: 1,
        error: error instanceof Error ? error.message : String(error),
        createdAt: now,
        updatedAt: now,
      };
      await this.store.put(proposal);
      const persisted = await this.store.findBySourceMessage(question.eventId, question.id) ?? proposal;
      await this.syncQuestionState(persisted);
      this.invalidate(question.eventId);
      return persisted;
    }
  }

  private async reconcileQueuedQuestions(eventId: string): Promise<void> {
    const active = this.reconciliationByEvent.get(eventId);
    if (active) return active;
    const reconciliation = (async () => {
      for (const message of await this.chat.getQueuedQuestions(eventId)) {
        await this.createFromChat(message);
      }
    })().finally(() => {
      if (this.reconciliationByEvent.get(eventId) === reconciliation) {
        this.reconciliationByEvent.delete(eventId);
      }
    });
    this.reconciliationByEvent.set(eventId, reconciliation);
    return reconciliation;
  }

  private async syncQuestionState(proposal: CopilotProposal): Promise<void> {
    const responseMessageId = proposal.decision?.sentMessageId;
    const status = responseMessageId
      ? 'answered'
      : proposal.status === 'skipped'
        ? 'skipped'
        : proposal.status === 'blocked'
          ? 'blocked'
          : 'seller-queue';
    await this.chat.setCopilotQuestionState(proposal.eventId, proposal.sourceMessageId, {
      status,
      proposalId: proposal.id,
      ...(responseMessageId ? { responseMessageId } : {}),
    });
  }

  private async freshContext(proposal: CopilotProposal): Promise<GroundingContext> {
    return this.retriever.retrieve({
      eventId: proposal.eventId,
      query: proposal.question.text,
      limit: 8,
    });
  }

  /**
   * Block a send when the evidence THIS reply rests on has moved — not when
   * anything anywhere in the grounding context differs (plan D-010).
   *
   * The previous test was `groundingFingerprint(fresh) !== proposal.grounding-
   * Fingerprint`, a hash over every event item, catalog product, transcript
   * moment and the policy. On a live event some other product's stock moves
   * constantly, so a reply about product A was blocked because product B sold
   * a unit — and the block is destructive (status 'blocked', the seller must
   * regenerate). It also could not say WHAT changed, while the acceptance
   * clause for this seam explicitly requires seller-readable reasons.
   *
   * A reply citing NOTHING is blocked outright rather than allowed through.
   * Under the old rule such a reply was blocked only incidentally, whenever
   * unrelated context happened to drift; narrowing the comparison would
   * otherwise have quietly turned "usually blocked" into "always sent".
   */
  private async blockIfStale(proposal: CopilotProposal, fresh: GroundingContext): Promise<void> {
    const reasons = proposal.citations.length === 0
      ? ['This reply cites no verified source, so nothing backs up what it says.']
      : citedEvidenceDrift(proposal.citations, proposal.context, fresh).map((drift) => drift.explanation);
    if (reasons.length === 0) return;
    const reason = reasons.join(' ');
    const blocked = await this.transition(proposal, {
      ...proposal,
      context: fresh,
      groundingFingerprint: groundingFingerprint(fresh),
      status: 'blocked',
      error: `${reason} Create a fresh proposal before sending.`,
    });
    await this.syncQuestionState(blocked);
    throw new ConflictException(reason);
  }

  private async transition(current: CopilotProposal, next: CopilotProposal): Promise<CopilotProposal> {
    const updated: CopilotProposal = {
      ...next,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (!(await this.store.replace(updated, current.revision))) {
      const winner = await this.required(current.id);
      if (winner.status === updated.status) return winner;
      throw new ConflictException('Copilot proposal changed in another request');
    }
    this.invalidate(updated.eventId);
    return updated;
  }

  private async required(id: string): Promise<CopilotProposal> {
    const proposal = await this.store.get(id);
    if (!proposal) throw new NotFoundException(`Copilot proposal ${id} was not found`);
    return proposal;
  }

  private requirePending(proposal: CopilotProposal): void {
    if (proposal.status !== 'pending') {
      throw new ConflictException(`Copilot proposal is ${proposal.status}, not pending`);
    }
  }

  private requireReviewable(proposal: CopilotProposal, review: 'reply' | 'action'): void {
    const allowed = review === 'reply'
      ? proposal.status === 'pending' || proposal.status === 'executed'
      : proposal.status === 'pending' || proposal.status === 'approved';
    if (!allowed) {
      throw new ConflictException(`Copilot proposal is ${proposal.status}; its ${review} is not reviewable`);
    }
  }

  private invalidate(eventId: string): void {
    this.invalidations.invalidate('event.copilot.proposals', { eventId });
  }
}
