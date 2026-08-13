import { describe, expect, it } from 'vitest';

import { buildGroundingPrompt, GroundedCopilotPipeline } from './copilot.pipeline';
import type { CopilotPipelineDependencies } from './copilot.pipeline';
import type {
  ActionExecutionResult,
  CopilotPolicy,
  GroundingContext,
  ModelDraft,
} from './copilot.types';

const policy: CopilotPolicy = {
  automationLevel: 'suggest',
  allowAutoActions: false,
  priceFloorCentsByProduct: { 'p-1': 1000 },
  maxMarkdownPercent: 20,
  blockedActionKinds: [],
  tone: 'warm',
};

const context: GroundingContext = {
  eventItems: [
    {
      eventItemId: 'ei-1',
      productId: 'p-1',
      title: 'Blue mug',
      priceCents: 1500,
      availableQty: 4,
      attributes: { color: 'blue' },
    },
  ],
  catalogProducts: [
    {
      productId: 'p-1',
      title: 'Blue mug',
      priceCents: 1800,
      attributes: { material: 'ceramic' },
    },
  ],
  policy,
  sources: [
    { id: 'event-item:ei-1', kind: 'event-item', label: 'Blue mug event item' },
    { id: 'catalog-product:p-1', kind: 'catalog-product', label: 'Blue mug catalog record' },
    { id: 'policy:event', kind: 'policy', label: 'Seller event policy' },
  ],
};

function makePipeline(
  draft: ModelDraft,
  overrides: Partial<CopilotPipelineDependencies> = {},
) {
  let clock = 100;
  return new GroundedCopilotPipeline({
    retriever: { retrieve: async () => context },
    model: { generate: async () => draft },
    guard: { evaluate: async () => ({ allowed: true }) },
    now: () => (clock += 5),
    ...overrides,
  });
}

describe('GroundedCopilotPipeline', () => {
  it('only accepts citations that came from retrieved context', async () => {
    const pipeline = makePipeline({
      reply: 'The blue mug is in stock.',
      citations: ['event-item:ei-1', 'made-up-source'],
    });

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Is the mug in stock?' });

    expect(response.grounding).toBe('grounded');
    expect(response.citations).toEqual(['event-item:ei-1']);
    expect(response.reply).toContain('blue mug');
  });

  it('fails closed when a model returns no verified citation', async () => {
    const pipeline = makePipeline({ reply: 'It costs $15.', citations: ['unknown'] });

    const response = await pipeline.respond({ eventId: 'event-1', message: 'What does it cost?' });

    expect(response.grounding).toBe('insufficient-context');
    expect(response.reply).toContain("don't have enough verified");
    expect(response.citations).toEqual([]);
  });

  it('uses the seller policy ladder and never lets a request elevate it', async () => {
    const pipeline = makePipeline(
      {
        reply: 'I can lower the price for this buyer.',
        citations: ['policy:event'],
        action: {
          kind: 'targeted-offer',
          productId: 'p-1',
          buyerId: 'buyer-1',
          quantity: 1,
          priceCents: 1400,
          reason: 'buyer asked during the live event',
        },
      },
      {
        guard: { evaluate: async () => ({ allowed: true }) },
      },
    );

    const response = await pipeline.respond({
      eventId: 'event-1',
      buyerId: 'buyer-1',
      message: 'Offer me one.',
      requestedAutomation: 'auto',
    });

    expect(response.action?.disposition).toBe('suggested');
    expect(response.action?.execution).toBeUndefined();
  });

  it('auto-executes only through the audited executor after guard approval', async () => {
    const autoContext: GroundingContext = {
      ...context,
      policy: { ...policy, automationLevel: 'auto', allowAutoActions: true },
    };
    const execution: ActionExecutionResult = { auditId: 'audit-1', status: 'executed' };
    const pipeline = new GroundedCopilotPipeline({
      retriever: { retrieve: async () => autoContext },
      model: {
        generate: async () => ({
          reply: 'I applied the approved offer.',
          citations: ['policy:event'],
          action: {
            kind: 'targeted-offer',
            productId: 'p-1',
            buyerId: 'buyer-1',
            quantity: 1,
            priceCents: 1400,
            reason: 'approved buyer offer',
          },
        }),
      },
      guard: { evaluate: async () => ({ allowed: true }) },
      executor: { execute: async () => execution },
    });

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Apply it.' });

    expect(response.action?.disposition).toBe('executed');
    expect(response.action?.execution).toEqual(execution);
  });

  it('uses the server guard by default and blocks a below-floor action with an explanation', async () => {
    const pipeline = new GroundedCopilotPipeline({
      retriever: { retrieve: async () => context },
      model: {
        generate: async () => ({
          reply: 'I can make that offer.',
          citations: ['policy:event'],
          action: {
            kind: 'targeted-offer',
            productId: 'p-1',
            buyerId: 'buyer-1',
            quantity: 1,
            priceCents: 900,
            reason: 'buyer asked during the live event',
          },
        }),
      },
    });

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Offer me one.' });

    expect(response.action?.disposition).toBe('blocked');
    expect(response.action?.guardrail).toMatchObject({
      code: 'price-floor',
      explanation: expect.stringContaining('floor'),
    });
  });

  it('blocks a tone mismatch before an action can reach the action guard', async () => {
    const executor = { execute: async () => ({ auditId: 'must-not-run', status: 'executed' as const }) };
    const pipeline = new GroundedCopilotPipeline({
      retriever: { retrieve: async () => context },
      model: {
        generate: async () => ({
          reply: 'Proceed with purchase.',
          tone: 'professional' as const,
          citations: ['policy:event'],
          action: {
            kind: 'targeted-offer' as const,
            productId: 'p-1',
            buyerId: 'buyer-1',
            quantity: 1,
            priceCents: 1_400,
            reason: 'approved buyer offer',
          },
        }),
      },
      executor,
    });

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Apply it.' });

    expect(response.replyGuardrail).toMatchObject({ allowed: false, code: 'tone' });
    expect(response.reply).toContain("can't send that yet");
    expect(response.action).toBeUndefined();
  });

  it('includes event items, catalog facts, policies, and source IDs in the prompt', () => {
    const prompt = buildGroundingPrompt(context);

    expect(prompt).toContain('event-item:ei-1');
    expect(prompt).toContain('catalog-product:p-1');
    expect(prompt).toContain('availableQty');
    expect(prompt).toContain('priceFloorCentsByProduct');
  });
});
