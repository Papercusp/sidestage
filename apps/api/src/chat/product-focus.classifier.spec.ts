import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfiguredProductFocusClassifier,
  sanitizeProductFocusInput,
  validateProductFocusModelPayload,
  type ProductFocusClassificationInput,
} from './product-focus.classifier';

const INPUT: ProductFocusClassificationInput = {
  activeProductId: 'mug',
  requestSequence: 7,
  transcriptWindow: [
    { id: 'segment-1', text: 'Moving on, this one has an oversized hood.' },
  ],
  products: [
    { id: 'mug', label: 'Stoneware mug' },
    { id: 'hoodie', label: 'Linen hoodie', description: 'Oversized hood with a relaxed fit.' },
  ],
};

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('ConfiguredProductFocusClassifier', () => {
  it('bounds and validates browser input before model use', () => {
    expect(sanitizeProductFocusInput(INPUT)).toEqual(INPUT);
    expect(sanitizeProductFocusInput({ products: [], transcriptWindow: [] })).toBeNull();
  });

  it('accepts only a confident different product from the supplied catalog', () => {
    expect(validateProductFocusModelPayload({
      decision: 'different',
      productId: 'hoodie',
      confidence: 0.92,
      evidenceSegmentIds: ['segment-1', 'invented'],
    }, INPUT)).toMatchObject({
      decision: 'different',
      productId: 'hoodie',
      confidence: 0.92,
      evidenceSegmentIds: ['segment-1'],
      requestSequence: 7,
    });
    expect(validateProductFocusModelPayload({
      decision: 'different', productId: 'invented', confidence: 0.99, evidenceSegmentIds: [],
    }, INPUT)).toMatchObject({ decision: 'unknown', productId: null, confidence: 0 });
    expect(validateProductFocusModelPayload({
      decision: 'different', productId: 'hoodie', confidence: 0.4, evidenceSegmentIds: [],
    }, INPUT)).toMatchObject({ decision: 'unknown', productId: null, confidence: 0 });
  });

  it('fails harmlessly when no configured model is available', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL;
    delete process.env.SIDESTAGE_COPILOT_MODEL;
    await expect(new ConfiguredProductFocusClassifier().classify(INPUT)).resolves.toMatchObject({
      decision: 'unknown', source: 'unavailable', requestSequence: 7,
    });
  });

  it('uses strict structured output and validates the model response', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL = 'focus-model';
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { text: { format: { name: string; strict: boolean } } };
      expect(body.text.format).toMatchObject({ name: 'sidestage_product_focus', strict: true });
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          decision: 'different', productId: 'hoodie', confidence: 0.93, evidenceSegmentIds: ['segment-1'],
        }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new ConfiguredProductFocusClassifier().classify(INPUT)).resolves.toMatchObject({
      decision: 'different', productId: 'hoodie', confidence: 0.93, source: 'model', requestSequence: 7,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('turns transport and parse failures into an unknown decision', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL = 'focus-model';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    await expect(new ConfiguredProductFocusClassifier().classify(INPUT)).resolves.toMatchObject({
      decision: 'unknown', source: 'error', requestSequence: 7,
    });
  });
});
