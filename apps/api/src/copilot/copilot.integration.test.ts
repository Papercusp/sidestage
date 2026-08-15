import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GuardedActionService } from '../actions/action.service';
import { ChatService, type ChatMessage } from '../chat/chat.service';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { EventService, InMemoryEventStore } from '../events/event.service';
import type { AutoResponderJudgeService } from '../judge/judge.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { CopilotController } from './copilot.controller';
import type { SideStageGroundingRetriever } from './copilot.grounding';
import {
  BuyerQuestionCopilotSubscriber,
  CopilotSyncQueries,
} from './copilot.module';
import type { GroundedCopilotPipeline } from './copilot.pipeline';
import type { CopilotProposal } from './copilot.runtime.types';
import { CopilotProposalService } from './copilot.service';
import { InMemoryCopilotProposalStore } from './copilot.store';
import type { ActionResult, CopilotResponse, GroundingContext } from './copilot.types';

const context: GroundingContext = {
  eventItems: [{
    eventItemId: 'event-live:mug',
    productId: 'mug',
    title: 'Blue mug',
    priceCents: 1_500,
    availableQty: 5,
    attributes: { color: 'blue' },
  }],
  catalogProducts: [],
  transcriptMoments: [],
  policy: {
    automationLevel: 'confirm',
    allowAutoActions: false,
    priceFloorCentsByProduct: { mug: 1_000 },
    maxMarkdownPercent: 20,
    blockedActionKinds: [],
    tone: 'warm',
  },
  sources: [
    { id: 'event-item:event-live:mug', kind: 'event-item', label: 'Blue mug live event listing' },
    { id: 'policy:event-live', kind: 'policy', label: 'Effective seller policy' },
  ],
};

function response(action?: ActionResult): CopilotResponse {
  return {
    reply: 'Thanks for asking — the blue mug is still available.',
    grounding: 'grounded',
    citations: ['event-item:event-live:mug'],
    context,
    replyGuardrail: { allowed: true },
    ...(action ? { action } : {}),
    latencyMs: 4,
    latency: {
      ttftMs: null,
      completeMs: 4,
      sampleCount: 1,
      p50: { ttftMs: null, completeMs: 4 },
      p95: { ttftMs: null, completeMs: 4 },
    },
  };
}

function integrationRuntime(action?: ActionResult) {
  let freshContext = context;
  const invalidations = new SyncInvalidationService();
  const chat = new ChatService(invalidations);
  const store = new InMemoryCopilotProposalStore();
  const pipeline = {
    respond: vi.fn(async () => response(action)),
  } as unknown as GroundedCopilotPipeline;
  const retriever = {
    retrieve: vi.fn(async () => freshContext),
  } as unknown as SideStageGroundingRetriever;
  const actions = new GuardedActionService();
  const judge = {
    run: vi.fn(async () => ({ passed: true, cases: [] })),
  } as unknown as AutoResponderJudgeService;
  const service = new CopilotProposalService(
    pipeline,
    store,
    retriever,
    chat,
    actions,
    judge,
    invalidations,
  );
  const ownership = new EventOwnershipGuard(new EventService(
    new InMemoryEventStore([{
      eventId: 'event-live',
      title: 'Live event',
      sellerId: 'seller-1',
      sellerName: 'Seller one',
      status: 'live',
      startsAt: null,
      endedAt: null,
    }]),
    chat,
  ));
  const controller = new CopilotController(service, ownership);
  const queries = new SyncQueryRegistry();
  const syncQueries = new CopilotSyncQueries(service, queries, ownership);
  const subscriber = new BuyerQuestionCopilotSubscriber(chat, service);
  syncQueries.onModuleInit();
  subscriber.onModuleInit();

  async function ask(text: string, buyerId = 'buyer-1'): Promise<CopilotProposal> {
    const question = await chat.addMessage('event-live', {
      userId: buyerId,
      displayName: 'Maya',
      role: 'buyer',
      text,
    });
    expect(question.grounding).toEqual({ status: 'seller-queue' });
    await vi.waitFor(async () => {
      expect(await service.list('event-live')).toHaveLength(1);
    });
    const proposals = await queries.resolve(
      'event.copilot.proposals',
      { eventId: 'event-live' },
      { principal: 'seller-1' },
    );
    return (proposals as CopilotProposal[])[0]!;
  }

  return {
    actions,
    ask,
    chat,
    controller,
    queries,
    service,
    setFreshContext(next: GroundingContext) { freshContext = next; },
    destroy() { subscriber.onModuleDestroy(); },
  };
}

function sellerMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === 'seller');
}

async function notFoundResponse(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    expect.unreachable('expected the owner check to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(NotFoundException);
    return (error as NotFoundException).getResponse();
  }
}

describe('seller Copilot integration', () => {
  it('collapses foreign and absent proposal ids across every review action', async () => {
    const runtime = integrationRuntime();
    try {
      const proposal = await runtime.ask('Can this mug ship tomorrow?');
      const calls = [
        (id: string) => runtime.controller.approve(id, { actorId: 'seller-forged' }, 'seller-2'),
        (id: string) => runtime.controller.skip(id, { actorId: 'seller-forged' }, 'seller-2'),
        (id: string) => runtime.controller.confirmAction(id, { actorId: 'seller-forged' }, 'seller-2'),
      ];

      for (const call of calls) {
        const foreign = await notFoundResponse(() => call(proposal.id));
        const absent = await notFoundResponse(() => call('missing-proposal'));
        expect(absent).toEqual(foreign);
      }
      await expect(runtime.service.find(proposal.id)).resolves.toMatchObject({ status: 'pending' });
      expect(sellerMessages(await runtime.chat.getMessages('event-live'))).toEqual([]);
    } finally {
      runtime.destroy();
    }
  });

  it('turns a buyer question into a sync proposal and approves its reply exactly once', async () => {
    const runtime = integrationRuntime();
    try {
      const proposal = await runtime.ask('Is the blue mug still available?');

      const [first, retry] = await Promise.all([
        runtime.controller.approve(proposal.id, { actorId: 'seller-forged' }, 'seller-1'),
        runtime.controller.approve(proposal.id, { actorId: 'seller-forged' }, 'seller-1'),
      ]);

      expect(retry).toEqual(first);
      expect(first).toMatchObject({
        status: 'approved',
        decision: { actorId: 'seller-1', sentMessageId: expect.any(String) },
      });
      expect(sellerMessages(await runtime.chat.getMessages('event-live'))).toHaveLength(1);
      await expect(runtime.queries.resolve(
        'event.copilot.proposals',
        { eventId: 'event-live' },
        { principal: 'seller-1' },
      ))
        .resolves.toEqual([first]);
    } finally {
      runtime.destroy();
    }
  });

  it('skips a queued proposal without sending a seller message', async () => {
    const runtime = integrationRuntime();
    try {
      const proposal = await runtime.ask('Can this mug ship tomorrow?');
      const skipped = await runtime.controller.skip(proposal.id, { actorId: 'seller-forged' }, 'seller-1');
      const retry = await runtime.controller.skip(proposal.id, { actorId: 'seller-forged' }, 'seller-1');

      expect(retry).toEqual(skipped);
      expect(skipped.status).toBe('skipped');
      expect(sellerMessages(await runtime.chat.getMessages('event-live'))).toEqual([]);
    } finally {
      runtime.destroy();
    }
  });

  it('blocks approval when the live grounding changed after generation', async () => {
    const runtime = integrationRuntime();
    try {
      const proposal = await runtime.ask('Is the blue mug still available?');
      runtime.setFreshContext({
        ...context,
        eventItems: [{ ...context.eventItems[0]!, availableQty: 0 }],
      });

      await expect(runtime.controller.approve(proposal.id, { actorId: 'seller-forged' }, 'seller-1'))
        .rejects.toThrow('Grounding changed');
      await expect(runtime.queries.resolve(
        'event.copilot.proposals',
        { eventId: 'event-live' },
        { principal: 'seller-1' },
      ))
        .resolves.toEqual([expect.objectContaining({ status: 'blocked' })]);
      expect(sellerMessages(await runtime.chat.getMessages('event-live'))).toEqual([]);
    } finally {
      runtime.destroy();
    }
  });

  it('confirms a guarded action once and then approves the buyer reply once', async () => {
    const action: ActionResult = {
      proposal: {
        kind: 'targeted-offer',
        productId: 'mug',
        buyerId: 'buyer-1',
        quantity: 1,
        priceCents: 1_200,
        reason: 'Seller-confirmed live offer',
      },
      disposition: 'awaiting-confirmation',
      guardrail: { allowed: true },
    };
    const runtime = integrationRuntime(action);
    runtime.actions.registerEvent('event-live', {
      policy: context.policy,
      items: [{
        eventId: 'event-live',
        eventItemId: 'event-live:mug',
        productId: 'mug',
        title: 'Blue mug',
        priceCents: 1_500,
        availableQty: 5,
        quantity: 5,
        attributes: { color: 'blue' },
      }],
    });
    try {
      const proposal = await runtime.ask('Can you make me an offer?');
      const [first, retry] = await Promise.all([
        runtime.controller.confirmAction(proposal.id, { actorId: 'seller-forged' }, 'seller-1'),
        runtime.controller.confirmAction(proposal.id, { actorId: 'seller-forged' }, 'seller-1'),
      ]);
      const approved = await runtime.controller.approve(proposal.id, { actorId: 'seller-forged' }, 'seller-1');

      expect(retry).toEqual(first);
      expect(runtime.actions.listAudit('event-live')).toHaveLength(1);
      expect(runtime.actions.listOffersForBuyer('buyer-1')).toHaveLength(1);
      expect(approved).toMatchObject({
        status: 'executed',
        decision: { auditId: expect.any(String), sentMessageId: expect.any(String) },
      });
      expect(sellerMessages(await runtime.chat.getMessages('event-live'))).toHaveLength(1);
    } finally {
      runtime.destroy();
    }
  });
});
