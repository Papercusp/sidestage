import { describe, expect, it, vi } from 'vitest';
import { GuardedActionService } from '../actions/action.service';
import type { CatalogSource, CatalogVariant } from '../catalog/catalog.types';
import { ChatService, type ChatMessage } from '../chat/chat.service';
import type { EventPolicyResolver } from '../config/event-policy-resolver';
import type { AutoResponderJudgeService } from '../judge/judge.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { SideStageGroundingRetriever } from './copilot.grounding';
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
  it('refreshes event availability from the catalog while preserving the event price', async () => {
    let liveAvailableQty = 95;
    const variant = (): CatalogVariant => ({
      id: 'mug', groupId: 'mugs', title: 'Blue mug', brand: 'Kiln', productType: 'HOME',
      sku: 'MUG-BLUE', condition: 'NEW', handlingDays: 1, priceCents: 1_800,
      qty: liveAvailableQty + 5, reservedQty: 5, availableQty: liveAvailableQty,
    });
    const catalog: CatalogSource = {
      search: async () => ({ rows: [variant()], page: 1, pageSize: 8, total: 1, totalIsFloor: false }),
      searchOwned: async () => ({ rows: [variant()], page: 1, pageSize: 8, total: 1, totalIsFloor: false }),
      productTypes: async () => ['HOME'],
      variant: async () => variant(),
    };
    const actions = new GuardedActionService();
    await actions.registerEvent('event-1', {
      policy: context.policy,
      items: [{
        eventId: 'event-1', eventItemId: 'event-1:mug', productId: 'mug', title: 'Blue mug',
        priceCents: 1_500, availableQty: 97, quantity: 97, attributes: { color: 'blue' },
      }],
    });
    const retriever = new SideStageGroundingRetriever(
      catalog,
      actions,
      new ChatService(new SyncInvalidationService()),
      { resolve: async () => context.policy } as EventPolicyResolver,
    );

    const first = await retriever.retrieve({ eventId: 'event-1', query: 'Is the blue mug in stock?', limit: 8 });
    liveAvailableQty = 91;
    const second = await retriever.retrieve({ eventId: 'event-1', query: 'Is the blue mug in stock?', limit: 8 });

    expect(first.eventItems[0]).toMatchObject({
      priceCents: 1_500,
      availableQty: 95,
      attributes: { eventListedQty: 97, catalogAvailableQty: 95 },
    });
    expect(second.eventItems[0]).toMatchObject({ priceCents: 1_500, availableQty: 91 });
  });

  it('persists one proposal per buyer message and invalidates the sync query', async () => {
    const runtime = setup();
    const events: Array<{ name: string; args?: Record<string, unknown> }> = [];
    runtime.invalidations.events().subscribe(({ name, args }) => events.push({ name, args }));

    const first = await runtime.service.createFromChat(question);
    const retry = await runtime.service.createFromChat(question);

    expect(retry).toEqual(first);
    expect(await runtime.service.list('event-1')).toEqual([first]);
    expect(first.latencyMs).toBe(5);
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
    expect(await runtime.chat.getMessages('event-1')).toEqual([
      expect.objectContaining({
        role: 'seller',
        grounding: {
          status: 'answered',
          sourceMessageId: question.id,
          proposalId: proposal.id,
          assistant: {
            kind: 'copilot-assisted',
            approvedBy: 'seller-1',
            edited: false,
            citationSourceIds: ['event-item:event-1:mug'],
          },
        },
      }),
    ]);
    expect(sent).toHaveLength(1);
  });

  it('recovers a persisted queued question that missed the in-memory subscriber', async () => {
    const runtime = setup();
    const queued = await runtime.chat.addMessage('event-1', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: 'Is the blue mug still available?',
    });

    const first = await runtime.service.list('event-1');
    const retry = await runtime.service.list('event-1');

    expect(first).toHaveLength(1);
    expect(retry).toEqual(first);
    expect(runtime.pipeline.respond).toHaveBeenCalledTimes(1);
    expect((await runtime.chat.getMessages('event-1'))[0]?.grounding).toMatchObject({
      status: 'seller-queue',
      proposalId: first[0]!.id,
      route: { destination: 'seller-review', category: 'availability' },
    });
    expect(first[0]?.sourceMessageId).toBe(queued.id);
  });

  it('keeps a failed recovered generation visible and marks the source question blocked', async () => {
    const runtime = setup();
    vi.mocked(runtime.pipeline.respond).mockRejectedValueOnce(new Error('provider unavailable'));
    const queued = await runtime.chat.addMessage('event-1', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: 'Can this ship tomorrow?',
    });

    await expect(runtime.service.list('event-1')).resolves.toEqual([
      expect.objectContaining({ status: 'blocked', error: 'provider unavailable' }),
    ]);
    expect((await runtime.chat.getMessages('event-1'))[0]).toMatchObject({
      id: queued.id,
      grounding: { status: 'blocked', proposalId: expect.any(String) },
    });
  });

  it('skips without sending and makes a repeated skip idempotent', async () => {
    const runtime = setup();
    const proposal = await runtime.service.createFromChat(question);

    const skipped = await runtime.service.skip(proposal.id, { actorId: 'seller-1' });
    const retry = await runtime.service.skip(proposal.id, { actorId: 'seller-1' });

    expect(retry).toEqual(skipped);
    expect(skipped.status).toBe('skipped');
    expect(await runtime.chat.getMessages('event-1')).toEqual([]);
  });

  it('blocks approval with a seller-readable reason naming the cited source that moved', async () => {
    const runtime = setup();
    const proposal = await runtime.service.createFromChat(question);
    runtime.setFreshContext({
      ...context,
      eventItems: [{ ...context.eventItems[0]!, availableQty: 0 }],
    });

    // The reason names the source and what happened to it, rather than the old
    // generic "Grounding changed" that told a seller nothing (plan D-010).
    await expect(runtime.service.approve(proposal.id, { actorId: 'seller-1' }))
      .rejects.toThrow('Blue mug live event listing changed after this reply was written.');

    const blocked = await runtime.store.get(proposal.id);
    expect(blocked).toMatchObject({
      status: 'blocked',
      error: 'Blue mug live event listing changed after this reply was written. Create a fresh proposal before sending.',
    });
    // Never persisted as sent, and never broadcast.
    expect(blocked?.decision?.sentMessageId).toBeUndefined();
    expect(await runtime.chat.getMessages('event-1')).toEqual([]);
  });

  it('blocks a reply that cites no verified source at all', async () => {
    const runtime = setup();
    const proposal = await runtime.service.createFromChat(question);
    await runtime.store.replace({ ...(await runtime.store.get(proposal.id))!, citations: [] }, proposal.revision);

    await expect(runtime.service.approve(proposal.id, { actorId: 'seller-1' }))
      .rejects.toThrow('This reply cites no verified source, so nothing backs up what it says.');

    const blocked = await runtime.store.get(proposal.id);
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect(blocked?.decision?.sentMessageId).toBeUndefined();
    expect(await runtime.chat.getMessages('event-1')).toEqual([]);
  });

  it('sends a supported seller edit when every cited source still holds', async () => {
    const runtime = setup();
    const proposal = await runtime.service.createFromChat(question);

    const approved = await runtime.service.approve(proposal.id, {
      actorId: 'seller-1',
      reply: 'Yes — the blue mug is still on the stage and ready to ship.',
    });

    expect(approved).toMatchObject({
      status: 'approved',
      reply: 'Yes — the blue mug is still on the stage and ready to ship.',
    });
    expect(approved.decision?.sentMessageId).toEqual(expect.any(String));
    expect(await runtime.chat.getMessages('event-1')).toEqual([
      expect.objectContaining({
        role: 'seller',
        text: 'Yes — the blue mug is still on the stage and ready to ship.',
        grounding: expect.objectContaining({
          assistant: expect.objectContaining({
            edited: true,
            citationSourceIds: ['event-item:event-1:mug'],
          }),
        }),
      }),
    ]);
  });

  it('does not block when context drifted only outside the sources the reply cited', async () => {
    const runtime = setup();
    const proposal = await runtime.service.createFromChat(question);
    // A DIFFERENT product moves. The reply cites only the mug, so this is not
    // drift for this reply — the whole-context comparison used to block it.
    runtime.setFreshContext({
      ...context,
      eventItems: [
        context.eventItems[0]!,
        {
          eventItemId: 'event-1:tote',
          productId: 'tote',
          title: 'Canvas tote',
          priceCents: 2_400,
          availableQty: 0,
          attributes: {},
        },
      ],
    });

    const approved = await runtime.service.approve(proposal.id, { actorId: 'seller-1' });

    expect(approved).toMatchObject({ status: 'approved' });
    expect(await runtime.chat.getMessages('event-1')).toHaveLength(1);
  });

  it('executes a confirmed action once and still allows its reply to be approved', async () => {
    const actions = new GuardedActionService();
    await actions.registerEvent('event-1', {
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
    expect(await actions.listAudit('event-1')).toHaveLength(1);
    expect(await actions.listOffersForBuyer('buyer-1')).toHaveLength(1);
    expect(approved).toMatchObject({
      status: 'executed',
      decision: { auditId: expect.any(String), sentMessageId: expect.any(String) },
    });
    expect(await runtime.chat.getMessages('event-1')).toHaveLength(1);
  });
});
