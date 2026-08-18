import { describe, expect, it, vi } from 'vitest';

import { VertexCopilotReplyModel } from './copilot-vertex.model';
import type {
  CopilotPolicy,
  GroundingContext,
  ModelDraft,
  ReplyGenerationRequest,
  ReplyModel,
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
  ],
};

const request: ReplyGenerationRequest = {
  event: { eventId: 'event-1', message: 'Is the mug in stock?' },
  context,
  groundingPrompt: 'GROUNDING',
};

const fallbackDraft: ModelDraft = { reply: 'deterministic fallback', citations: [] };

function makeModel(content: string | (() => Promise<never>)) {
  const fallback: ReplyModel = { generate: vi.fn(async () => fallbackDraft) };
  const complete = typeof content === 'string'
    ? vi.fn(async () => ({ content, toolCalls: [] }))
    : vi.fn(content);
  const model = new VertexCopilotReplyModel({ model: 'fake-gemini', complete }, fallback);
  return { model, fallback, complete };
}

describe('VertexCopilotReplyModel', () => {
  it('maps a valid strict-JSON turn onto the draft contract', async () => {
    const { model, fallback } = makeModel(JSON.stringify({
      reply: 'The blue mug is in stock.',
      citations: ['event-item:ei-1'],
      confidence: 0.9,
      tone: 'warm',
      action: null,
    }));

    const draft = await model.generate(request);

    expect(draft.reply).toBe('The blue mug is in stock.');
    expect(draft.citations).toEqual(['event-item:ei-1']);
    expect(draft.confidence).toBe(0.9);
    expect(draft.tone).toBe('warm');
    expect(draft.action).toBeUndefined();
    expect(draft.latency?.completeMs).toBeTypeOf('number');
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it('strips markdown fences and filters citations the context does not verify', async () => {
    const { model } = makeModel([
      '```json',
      JSON.stringify({
        reply: 'Verified answer.',
        citations: ['event-item:ei-1', 'made-up-source'],
        confidence: 7,
        tone: 'sarcastic',
      }),
      '```',
    ].join('\n'));

    const draft = await model.generate(request);

    expect(draft.citations).toEqual(['event-item:ei-1']);
    expect(draft.confidence).toBe(1);
    expect(draft.tone).toBeUndefined();
  });

  it('passes an action object through for the guard ladder to revalidate', async () => {
    const { model } = makeModel(JSON.stringify({
      reply: 'I can hold one for you.',
      citations: ['event-item:ei-1'],
      action: { kind: 'stock-adjust', eventItemId: 'ei-1' },
    }));

    const draft = await model.generate(request);

    expect(draft.action).toMatchObject({ kind: 'stock-adjust' });
  });

  it('falls back to the deterministic engine on a non-JSON turn', async () => {
    const { model, fallback } = makeModel('I think the mug is nice.');

    const draft = await model.generate(request);

    // Same fallback content, but stamped with WHY: a benchmark/latency budget
    // reading this draft must be able to tell it is not the real provider's
    // own answer.
    expect(draft).toEqual({ ...fallbackDraft, providerError: 'unparseable-response' });
    expect(fallback.generate).toHaveBeenCalledWith(request);
  });

  it('falls back to the deterministic engine on an empty reply', async () => {
    const { model, fallback } = makeModel(JSON.stringify({ reply: '', citations: [] }));

    await model.generate(request);

    expect(fallback.generate).toHaveBeenCalledWith(request);
  });

  it('falls back to the deterministic engine when the provider throws', async () => {
    const { model, fallback } = makeModel(async () => {
      throw new Error('vertex unavailable');
    });

    const draft = await model.generate(request);

    expect(draft).toEqual({ ...fallbackDraft, providerError: 'vertex unavailable' });
    expect(fallback.generate).toHaveBeenCalledWith(request);
  });
});
