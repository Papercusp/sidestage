import { describe, expect, it } from 'vitest';

import { buildGroundingPrompt, GroundedCopilotPipeline } from './copilot.pipeline';
import type { CopilotPipelineDependencies } from './copilot.pipeline';
import { CopilotLatencyBudget } from './latency';
import { ParallelResearchFallback } from './research';
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
    expect(response.latency).toMatchObject({ completeMs: 5, sampleCount: 1 });
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
          // WI-38815: auto execution now requires verified confidence at or
          // above the platform floor — an unstated confidence reads as 0.
          confidence: 0.95,
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

  it('caps auto policy at confirmation in a durable review-queue composition', async () => {
    const autoContext: GroundingContext = {
      ...context,
      policy: { ...policy, automationLevel: 'auto', allowAutoActions: true },
    };
    const pipeline = new GroundedCopilotPipeline({
      retriever: { retrieve: async () => autoContext },
      model: {
        generate: async () => ({
          reply: 'I prepared a verified offer.',
          citations: ['policy:event'],
          confidence: 0.99,
          action: {
            kind: 'targeted-offer', productId: 'p-1', buyerId: 'buyer-1',
            quantity: 1, priceCents: 1_400, reason: 'buyer asked during the live event',
          },
        }),
      },
      automationCeiling: 'confirm',
    });

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Can I get an offer?' });

    expect(response.action?.disposition).toBe('awaiting-confirmation');
    expect(response.action?.execution).toBeUndefined();
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

  it('includes web research findings in the provider-neutral prompt', () => {
    const prompt = buildGroundingPrompt({
      ...context,
      webFindings: [{ findingId: 'f-1', title: 'Battery life', snippet: 'Up to 30 hours.' }],
      sources: [...context.sources, { id: 'web-research:f-1', kind: 'web-research', label: 'Battery life' }],
    });

    expect(prompt).toContain('web-research:f-1');
    expect(prompt).toContain('Up to 30 hours.');
  });

  it('records provider TTFT and exposes rolling p50/p95 complete latency', async () => {
    const latencyBudget = new CopilotLatencyBudget();
    let call = 0;
    const pipeline = new GroundedCopilotPipeline({
      retriever: { retrieve: async () => context },
      model: {
        generate: async () => ({
          reply: 'The blue mug is in stock.',
          citations: ['event-item:ei-1'],
          latency: call++ === 0 ? { ttftMs: 40, completeMs: 120 } : { ttftMs: 20, completeMs: 80 },
        }),
      },
      latencyBudget,
    });

    await pipeline.respond({ eventId: 'event-1', message: 'Is it in stock?' });
    const second = await pipeline.respond({ eventId: 'event-1', message: 'How much?' });

    expect(second.latency).toMatchObject({
      ttftMs: 20,
      completeMs: 80,
      sampleCount: 2,
      p50: { ttftMs: 20, completeMs: 80 },
      p95: { ttftMs: 40, completeMs: 120 },
    });
  });

  it('merges the property-aware parallel research fallback before model generation', async () => {
    let generatedContext: GroundingContext | undefined;
    const pipeline = new GroundedCopilotPipeline({
      retriever: { retrieve: async () => context },
      researchFallback: new ParallelResearchFallback(
        {
          supportsProperties: () => false,
          search: async () => ({ products: [] }),
        },
        {
          search: async () => [{ findingId: 'f-1', title: 'Battery life', snippet: 'Up to 30 hours.' }],
        },
      ),
      model: {
        generate: async (request) => {
          generatedContext = request.context;
          return { reply: 'Up to 30 hours.', citations: ['web-research:f-1'] };
        },
      },
    });

    const response = await pipeline.respond({
      eventId: 'event-1',
      message: 'What is the battery life?',
      requiredProperties: ['batteryHours'],
    });

    expect(generatedContext?.webFindings).toEqual([
      { findingId: 'f-1', title: 'Battery life', snippet: 'Up to 30 hours.' },
    ]);
    expect(response.grounding).toBe('grounded');
    expect(response.citations).toEqual(['web-research:f-1']);
  });
});

/**
 * WI-38815 regression: the automation ladder (decideAutomation) is the ONLY
 * path to 'executed'. Before this, resolveAction never read draft.confidence
 * and the Config always-ask toggles never reached the action boundary — a
 * confidence-0.1 targeted offer executed once under an auto policy.
 */
describe('automation ladder at the action boundary (WI-38815)', () => {
  const offer = {
    kind: 'targeted-offer' as const,
    productId: 'p-1',
    buyerId: 'buyer-1',
    quantity: 1,
    priceCents: 1400,
    reason: 'buyer asked during the live event',
  };

  function autoPolicy(extra: Partial<CopilotPolicy> = {}): CopilotPolicy {
    return {
      automationLevel: 'auto',
      allowAutoActions: true,
      priceFloorCentsByProduct: { 'p-1': 1000 },
      maxMarkdownPercent: 30,
      blockedActionKinds: [],
      tone: 'warm',
      ...extra,
    };
  }

  function pipelineWith(policyVariant: CopilotPolicy, confidence?: number) {
    const executions: ActionExecutionResult[] = [];
    const pipeline = new GroundedCopilotPipeline({
      retriever: { retrieve: async () => ({ ...context, policy: policyVariant }) },
      model: {
        generate: async () => ({
          reply: 'Offer prepared.',
          citations: ['policy:event'],
          action: offer,
          ...(confidence !== undefined ? { confidence } : {}),
        }),
      },
      guard: { evaluate: async () => ({ allowed: true }) },
      executor: {
        execute: async () => {
          const execution: ActionExecutionResult = { auditId: `audit-${executions.length + 1}`, status: 'executed' };
          executions.push(execution);
          return execution;
        },
      },
    });
    return { pipeline, executions };
  }

  it('holds a confidence-0.1 offer in review under an auto policy (the exact WI-38815 repro)', async () => {
    const { pipeline, executions } = pipelineWith(autoPolicy(), 0.1);

    const response = await pipeline.respond({ eventId: 'event-1', buyerId: 'buyer-1', message: 'Offer me one.' });

    expect(response.action?.disposition).toBe('awaiting-confirmation');
    expect(response.action?.execution).toBeUndefined();
    expect(executions).toHaveLength(0);
    expect(response.action?.automation?.reasonCodes).toContain('CONFIDENCE_BELOW_FLOOR');
  });

  it('fails closed when the model reports NO confidence at all', async () => {
    const { pipeline, executions } = pipelineWith(autoPolicy());

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Offer me one.' });

    expect(response.action?.disposition).toBe('awaiting-confirmation');
    expect(executions).toHaveLength(0);
  });

  it('still executes a high-confidence offer through the audited executor', async () => {
    const { pipeline, executions } = pipelineWith(autoPolicy(), 0.95);

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Offer me one.' });

    expect(response.action?.disposition).toBe('executed');
    expect(executions).toHaveLength(1);
    expect(response.action?.automation?.outcome).toBe('executed');
  });

  it('respects a seller confidence floor stricter than the platform floor', async () => {
    const { pipeline, executions } = pipelineWith(autoPolicy({ confidenceFloor: 0.99 }), 0.95);

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Offer me one.' });

    expect(response.action?.disposition).toBe('awaiting-confirmation');
    expect(executions).toHaveLength(0);
    expect(response.action?.automation?.reasonCodes).toContain('CONFIDENCE_BELOW_FLOOR');
  });

  it('never auto-executes an always-confirm kind, even at maximum confidence (buyer-sensitive toggle)', async () => {
    const { pipeline, executions } = pipelineWith(
      autoPolicy({ alwaysConfirmActionKinds: ['targeted-offer'] }),
      0.99,
    );

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Offer me one.' });

    expect(response.action?.disposition).toBe('awaiting-confirmation');
    expect(executions).toHaveLength(0);
  });

  it('caps auto at the order-value ceiling', async () => {
    const { pipeline, executions } = pipelineWith(autoPolicy({ maxOrderValueCents: 1000 }), 0.95);

    const response = await pipeline.respond({ eventId: 'event-1', message: 'Offer me one.' });

    expect(response.action?.disposition).toBe('awaiting-confirmation');
    expect(executions).toHaveLength(0);
    expect(response.action?.automation?.reasonCodes).toContain('ORDER_VALUE_REQUIRES_CONFIRMATION');
  });
});
