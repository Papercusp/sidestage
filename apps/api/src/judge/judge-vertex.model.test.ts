import { describe, expect, it, vi } from 'vitest';

import type { CopilotPolicy, GroundingContext } from '../copilot/copilot.types';
import { VertexReplyJudgeModel } from './judge-vertex.model';
import type { JudgeCase, JudgeModelResult, ReplyJudgeModel } from './judge.types';

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
  ],
};

const testCase: JudgeCase = {
  id: 'case-1',
  question: 'Is the mug in stock?',
  reply: 'Yes, the blue mug is in stock at $15.00.',
  citations: ['event-item:ei-1'],
  context,
  declaredTone: 'warm',
  expectedPriceCents: 1500,
};

const fallbackResult: JudgeModelResult = {
  dimensions: {
    grounding: { score: 0.5, rationale: 'deterministic fallback' },
  },
};

const validGrades = {
  grounding: { score: 1, rationale: 'Every citation is verified.' },
  policy: { score: 1, rationale: 'The reply passes the policy gate.' },
  'price-correctness': { score: 1, rationale: 'The price matches the event price.' },
  tone: { score: 0.9, rationale: 'The reply is warm.' },
};

function makeModel(content: string | (() => Promise<never>)) {
  const fallback: ReplyJudgeModel = { grade: vi.fn(async () => fallbackResult) };
  const complete = typeof content === 'string'
    ? vi.fn(async () => ({ content, toolCalls: [] }))
    : vi.fn(content);
  const model = new VertexReplyJudgeModel({ model: 'fake-gemini', complete }, fallback);
  return { model, fallback, complete };
}

describe('VertexReplyJudgeModel', () => {
  it('maps a valid strict-JSON grading onto all four dimensions', async () => {
    const { model, fallback, complete } = makeModel(JSON.stringify(validGrades));

    const result = await model.grade({ testCase });

    expect(result.dimensions.grounding).toEqual({ score: 1, rationale: 'Every citation is verified.' });
    expect(result.dimensions.policy?.score).toBe(1);
    expect(result.dimensions['price-correctness']?.score).toBe(1);
    expect(result.dimensions.tone?.score).toBe(0.9);
    expect(fallback.grade).not.toHaveBeenCalled();

    const prompt = JSON.stringify(complete.mock.calls[0]?.[0] ?? {});
    expect(prompt).toContain('Is the mug in stock?');
    expect(prompt).toContain('event-item:ei-1');
  });

  it('clamps out-of-range scores and fences markdown-wrapped JSON', async () => {
    const { model } = makeModel([
      '```json',
      JSON.stringify({
        ...validGrades,
        grounding: { score: 7, rationale: 'over-eager' },
        tone: { score: -2, rationale: 'under-eager' },
      }),
      '```',
    ].join('\n'));

    const result = await model.grade({ testCase });

    expect(result.dimensions.grounding?.score).toBe(1);
    expect(result.dimensions.tone?.score).toBe(0);
  });

  it('falls back for the whole case when a dimension is missing', async () => {
    const { model, fallback } = makeModel(JSON.stringify({
      grounding: validGrades.grounding,
      policy: validGrades.policy,
      tone: validGrades.tone,
    }));

    const result = await model.grade({ testCase });

    expect(result).toBe(fallbackResult);
    expect(fallback.grade).toHaveBeenCalledWith({ testCase });
  });

  it('falls back on a non-JSON turn', async () => {
    const { model, fallback } = makeModel('Looks good to me!');

    const result = await model.grade({ testCase });

    expect(result).toBe(fallbackResult);
    expect(fallback.grade).toHaveBeenCalledWith({ testCase });
  });

  it('falls back when the provider throws', async () => {
    const { model, fallback } = makeModel(async () => {
      throw new Error('vertex unavailable');
    });

    const result = await model.grade({ testCase });

    expect(result).toBe(fallbackResult);
    expect(fallback.grade).toHaveBeenCalledWith({ testCase });
  });
});
