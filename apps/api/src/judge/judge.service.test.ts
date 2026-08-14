import { describe, expect, it } from 'vitest';
import type { CopilotPolicy, GroundingContext } from '../copilot/copilot.types';
import { AutoResponderJudgeService, DeterministicReplyJudgeModel } from './judge.service';

const policy: CopilotPolicy = {
  automationLevel: 'suggest',
  allowAutoActions: false,
  priceFloorCentsByProduct: { 'p-1': 2_000 },
  maxMarkdownPercent: 20,
  blockedActionKinds: [],
  tone: 'warm',
};

const context: GroundingContext = {
  eventItems: [{
    eventItemId: 'ei-1',
    productId: 'p-1',
    title: 'Aurora cup',
    priceCents: 2_800,
    availableQty: 18,
    attributes: { material: 'ceramic' },
  }],
  catalogProducts: [{
    productId: 'p-1',
    title: 'Aurora cup',
    priceCents: 3_600,
    attributes: { material: 'ceramic' },
  }],
  policy,
  sources: [
    { id: 'event-item:ei-1', kind: 'event-item', label: 'Aurora cup event item' },
    { id: 'catalog-product:p-1', kind: 'catalog-product', label: 'Aurora cup catalog' },
    { id: 'policy:event', kind: 'policy', label: 'Seller event policy' },
  ],
};

function makeCase(overrides: Partial<Parameters<AutoResponderJudgeService['run']>[0]['cases'][number]> = {}) {
  return {
    id: 'stock-answer',
    question: 'How much is the cup?',
    reply: 'The Aurora cup is $28 and 18 are available — happy to help.',
    citations: ['event-item:ei-1', 'policy:event'],
    context,
    declaredTone: 'warm' as const,
    expectedPriceCents: 2_800,
    ...overrides,
  };
}

describe('AutoResponderJudgeService', () => {
  it('passes a grounded, policy-safe, price-correct, warm reply', async () => {
    const service = new AutoResponderJudgeService(new DeterministicReplyJudgeModel());
    const report = await service.run({
      cases: [makeCase()],
    });

    expect(report).toMatchObject({ totalCases: 1, passedCases: 1, passed: true, passThreshold: 0.75 });
    expect(report.cases[0].dimensions).toMatchObject({
      grounding: { score: 1, passed: true },
      policy: { score: 1, passed: true },
      'price-correctness': { score: 1, passed: true },
      tone: { score: 1, passed: true },
    });
    expect(service.latest()).toBe(report);
  });

  it('fails unsupported citations, incorrect price, and tone mismatch', async () => {
    const report = await new AutoResponderJudgeService(new DeterministicReplyJudgeModel()).run({
      cases: [makeCase({
        id: 'unsafe-answer',
        reply: 'The Aurora cup is $9.99 — buy it now!!',
        citations: ['model-invented-source'],
        declaredTone: 'professional',
      })],
    });

    expect(report.passed).toBe(false);
    expect(report.passedCases).toBe(0);
    expect(report.cases[0].dimensions.grounding.score).toBe(0);
    expect(report.cases[0].dimensions['price-correctness'].score).toBe(0);
    expect(report.cases[0].dimensions.tone.score).toBe(0);
  });

  it('uses the provider seam and applies the report threshold centrally', async () => {
    const model = {
      grade: async () => ({
        dimensions: {
          grounding: { score: 0.8, rationale: 'grounded' },
          policy: { score: 0.8, rationale: 'safe' },
          'price-correctness': { score: 0.8, rationale: 'correct' },
          tone: { score: 0.8, rationale: 'warm' },
        },
      }),
    };
    const report = await new AutoResponderJudgeService(model).run({ cases: [makeCase()], passThreshold: 0.9 });

    expect(report.passed).toBe(false);
    expect(report.cases[0].overallScore).toBeCloseTo(0.8);
    expect(report.cases[0].dimensions.tone.passed).toBe(false);
  });

  it('rejects an empty rehearsal instead of returning a vacuous green report', async () => {
    await expect(new AutoResponderJudgeService(new DeterministicReplyJudgeModel()).run({ cases: [] }))
      .rejects.toThrow('at least one judge case is required');
  });
});
