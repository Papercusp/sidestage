import { describe, expect, it, vi } from 'vitest';
import { GuardedActionService } from '../actions/action.service';
import { ChatService, type ChatMessage } from '../chat/chat.service';
import type { AutoResponderJudgeService } from '../judge/judge.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import type { SideStageGroundingRetriever } from './copilot.grounding';
import type { GroundedCopilotPipeline } from './copilot.pipeline';
import type { CopilotProposal, CopilotProposalStore } from './copilot.runtime.types';
import { CopilotProposalService } from './copilot.service';
import { InMemoryCopilotProposalStore } from './copilot.store';
import type { ActionResult, CopilotResponse, GroundingContext } from './copilot.types';

const context: GroundingContext = {
  eventItems: [{
    eventItemId: 'event-1:mug',
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
    { id: 'event-item:event-1:mug', kind: 'event-item', label: 'Blue mug live event listing' },
    { id: 'policy:event-1', kind: 'policy', label: 'Effective seller policy' },
  ],
};

const question: ChatMessage = {
  id: 'event-1-1',
  eventId: 'event-1',
  userId: 'buyer-1',
  displayName: 'Maya',
  role: 'buyer',
  text: 'Is the blue mug still available?',
  createdAt: '2026-08-14T15:00:00.000Z',
  grounding: { status: 'seller-queue' },
};

function response(action?: ActionResult): CopilotResponse {
  return {
    reply: 'Thanks for asking — the blue mug is still available.',
    grounding: 'grounded',
    citations: ['event-item:event-1:mug'],
    context,
    replyGuardrail: { allowed: true },
    ...(action ? { action } : {}),
    latencyMs: 5,
    latency: {
      ttftMs: null,
      completeMs: 5,
      sampleCount: 1,
      p50: { ttftMs: null, completeMs: 5 },
      p95: { ttftMs: null, completeMs: 5 },
    },
  };
}

function passingJudge(): AutoResponderJudgeService {
  return {
    run: vi.fn(async () => ({ passed: true, cases: [] })),
  } as unknown as AutoResponderJudgeService;
}

function setup(options: {
  action?: ActionResult;
  actions?: GuardedActionService;
  store?: CopilotProposalStore;
} = {}) {
  let freshContext = context;
  const invalidations = new SyncInvalidationService();
  const chat = new ChatService(invalidations);
  const store = options.store ?? new InMemoryCopilotProposalStore();
  const pipeline = {
    respond: vi.fn(async () => response(options.action)),
  } as unknown as GroundedCopilotPipeline;
  const retriever = {
    retrieve: vi.fn(async () => freshContext),
  } as unknown as SideStageGroundingRetriever;
  const actions = options.actions ?? new GuardedActionService();
  const service = new CopilotProposalService(
    pipeline,
    store,
    retriever,
    chat,
    actions,
    passingJudge(),
    invalidations,
  );
  return {
    actions,
    chat,
    invalidations,
    pipeline,
    service,
    store,
    setFreshContext(next: GroundingContext) { freshContext = next; },
  };
}

describe('CopilotProposalService', () => {
  it('persists one proposal per buyer message and invalidates the sync query', async () => {
    const runtime = setup();
    const events: Array<{ name: string; args?: Record<string, unknown> }> = [];
    runtime.invalidations.events().subscribe(({ name, args }) => events.push({ name, args }));

    const first = await runtime.service.createFromChat(question);
    const retry = await runtime.service.createFromChat(question);

    expect(retry).toEqual(first);
    expect(await runtime.service.list('event-1')).toEqual([first]);
    expect(runtime.pipeline.respond).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { name: 'event.copilot.proposals', args: { eventId: 'event-1' } },
    ]);
  });

  it('approves a grounded reply exactly once even when requests race', async () => {
    const runtime = setup();
    const proposal = await runtime.service.createFromChat(question);
    const sent: string[] = [];
    runtime.chat.messageEvents().subscribe((message) => sent.push(message.id));

    const [first, retry] = await Promise.all([
      runtime.service.approve(proposal.id, { actorId: 'seller-1' }),
      runtime.service.approve(proposal.id, { actorId: 'seller-1' }),
    ]);

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      status: 'approved',
      revision: 2,
      decision: { actorId: 'seller-1', sentMessageId: expect.any(String) },
    });
    expect(runtime.chat.getMessages('event-1')).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('skips without sending and makes a repeated skip idempotent', async () => {
    const runtime = setup();
    const proposal = await runtime.service.createFromChat(question);

    const skipped = await runtime.service.skip(proposal.id, { actorId: 'seller-1' });
    const retry = await runtime.service.skip(proposal.id, { actorId: 'seller-1' });

    expect(retry).toEqual(skipped);
    expect(skipped.status).toBe('skipped');
    expect(runtime.chat.getMessages('event-1')).toEqual([]);
  });

  it('blocks approval when fresh event facts differ from the generation snapshot', async () => {
    const runtime = setup();
    const proposal = await runtime.service.createFromChat(question);
    runtime.setFreshContext({
      ...context,
      eventItems: [{ ...context.eventItems[0]!, availableQty: 0 }],
    });

    await expect(runtime.service.approve(proposal.id, { actorId: 'seller-1' }))
      .rejects.toThrow('Grounding changed');

    expect(await runtime.store.get(proposal.id)).toMatchObject({
      status: 'blocked',
      error: expect.stringContaining('Grounding changed'),
    });
    expect(runtime.chat.getMessages('event-1')).toEqual([]);
  });

  it('executes a confirmed action once and still allows its reply to be approved', async () => {
    const actions = new GuardedActionService();
    actions.registerEvent('event-1', {
      policy: context.policy,
      items: [{
        eventId: 'event-1', eventItemId: 'event-1:mug', productId: 'mug', title: 'Blue mug',
        priceCents: 1_500, availableQty: 5, quantity: 5, attributes: { color: 'blue' },
      }],
    });
    const action: ActionResult = {
      proposal: {
        kind: 'targeted-offer', productId: 'mug', buyerId: 'buyer-1', quantity: 1,
        priceCents: 1_200, reason: 'Seller-confirmed live offer',
      },
      disposition: 'awaiting-confirmation',
      guardrail: { allowed: true },
    };
    const runtime = setup({ action, actions });
    const proposal = await runtime.service.createFromChat(question);

    const [first, retry] = await Promise.all([
      runtime.service.confirmAction(proposal.id, { actorId: 'seller-1' }),
      runtime.service.confirmAction(proposal.id, { actorId: 'seller-1' }),
    ]);
    const approved = await runtime.service.approve(proposal.id, { actorId: 'seller-1' });

    expect(retry).toEqual(first);
    expect(actions.listAudit('event-1')).toHaveLength(1);
    expect(actions.listOffersForBuyer('buyer-1')).toHaveLength(1);
    expect(approved).toMatchObject({
      status: 'executed',
      decision: { auditId: expect.any(String), sentMessageId: expect.any(String) },
    });
    expect(runtime.chat.getMessages('event-1')).toHaveLength(1);
  });
});
