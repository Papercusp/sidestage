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

  constructor(
    @Inject(COPILOT_PIPELINE) private readonly pipeline: GroundedCopilotPipeline,
    @Inject(COPILOT_PROPOSAL_STORE) private readonly store: CopilotProposalStore,
    @Inject(SideStageGroundingRetriever) private readonly retriever: GroundingRetriever,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(GuardedActionService) private readonly actions: GuardedActionService,
    @Inject(AutoResponderJudgeService) private readonly judge: AutoResponderJudgeService,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
  ) {}

  list(eventId: string): Promise<CopilotProposal[]> {
    return this.store.list(eventId);
  }

  async createFromChat(message: ChatMessage): Promise<CopilotProposal> {
    return this.generate({
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
    return this.generate({
      id: input.sourceMessageId?.trim() || `manual-${randomUUID()}`,
      eventId,
      buyerId: input.buyerId?.trim() || 'seller-research',
      buyerName: input.buyerName?.trim() || 'Seller research',
      text,
      createdAt: now,
    });
  }

  async approve(id: string, input: ReviewCopilotReplyInput): Promise<CopilotProposal> {
    const proposal = await this.required(id);
    if ((proposal.status === 'approved' || proposal.status === 'executed') && proposal.decision?.sentMessageId) {
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
    const sent = this.chat.addMessage(proposal.eventId, {
      userId: actorId,
      displayName: 'Host',
      role: 'seller',
      text: reply,
      clientRequestId: `copilot-proposal:${proposal.id}`,
    });
    return this.transition(proposal, {
      ...proposal,
      reply,
      context: fresh,
      groundingFingerprint: groundingFingerprint(fresh),
      replyGuardrail: guardrail,
      status: proposal.status === 'executed' ? 'executed' : 'approved',
      decision: { ...proposal.decision, actorId, decidedAt: new Date().toISOString(), sentMessageId: sent.id },
    });
  }

  async skip(id: string, input: ReviewCopilotReplyInput): Promise<CopilotProposal> {
    const proposal = await this.required(id);
    if (proposal.status === 'skipped') return proposal;
    this.requirePending(proposal);
    const actorId = input?.actorId?.trim() || 'seller-copilot-review';
    return this.transition(proposal, {
      ...proposal,
      status: 'skipped',
      decision: { actorId, decidedAt: new Date().toISOString() },
    });
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

  private async generate(question: CopilotQuestion): Promise<CopilotProposal> {
    const existing = await this.store.findBySourceMessage(question.eventId, question.id);
    if (existing) return existing;
    const now = new Date().toISOString();
    try {
      const response = await this.pipeline.respond({
        eventId: question.eventId,
        buyerId: question.buyerId,
        message: question.text,
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
      this.invalidate(question.eventId);
      return proposal;
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
      this.invalidate(question.eventId);
      return proposal;
    }
  }

  private async freshContext(proposal: CopilotProposal): Promise<GroundingContext> {
    return this.retriever.retrieve({
      eventId: proposal.eventId,
      query: proposal.question.text,
      limit: 8,
    });
  }

  private async blockIfStale(proposal: CopilotProposal, fresh: GroundingContext): Promise<void> {
    if (groundingFingerprint(fresh) === proposal.groundingFingerprint) return;
    await this.transition(proposal, {
      ...proposal,
      context: fresh,
      groundingFingerprint: groundingFingerprint(fresh),
      status: 'blocked',
      error: 'Grounding changed after this reply was generated. Create a fresh proposal before sending.',
    });
    throw new ConflictException('Grounding changed after this reply was generated; the stale proposal was blocked');
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
