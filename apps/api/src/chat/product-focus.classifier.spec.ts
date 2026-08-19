import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VertexProductFocusClassifier } from './product-focus-vertex.classifier';
import {
  ConfiguredProductFocusClassifier,
  productFocusClassifierConfig,
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
  // The WI-39851 cases spy on Logger.prototype.warn; without this a mocked warn
  // leaks into later tests and their "warn was not called" controls pass vacuously.
  vi.restoreAllMocks();
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
    delete process.env.GOOGLE_CLOUD_PROJECT;
    await expect(new ConfiguredProductFocusClassifier().classify(INPUT)).resolves.toMatchObject({
      decision: 'unknown', source: 'unavailable', requestSequence: 7,
    });
  });

  describe('WI-39851 wall (2) — an unconfigured classifier must not be SILENT', () => {
    // Prod ran without OPENAI_API_KEY and nothing said so. Every call returned
    // `unavailable`, which a seller experiences as "no suggestion" — identical to
    // the model having considered it and declined. That is what let the missing
    // provisioning be read as a matching bug instead of a config gap.
    const unconfigure = () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL;
      delete process.env.SIDESTAGE_COPILOT_MODEL;
      // GOOGLE_CLOUD_PROJECT is set for real on the dev box, and the Vertex leg
      // now wins the provider choice — leaving it set makes "unconfigured" tests
      // dial Vertex for real (measured: 5s timeouts) instead of asserting the
      // degraded path.
      delete process.env.GOOGLE_CLOUD_PROJECT;
    };

    it('names EVERY missing variable, and treats the two model vars as one requirement', () => {
      unconfigure();
      expect(productFocusClassifierConfig()).toEqual({
        configured: false,
        provider: null,
        missing: [
          'OPENAI_API_KEY',
          'SIDESTAGE_PRODUCT_FOCUS_MODEL (or SIDESTAGE_COPILOT_MODEL)',
          // The cheaper remedy is named too: on a box already holding Vertex
          // credentials for the copilot, this one variable turns the leg on.
          'or GOOGLE_CLOUD_PROJECT for the Vertex leg',
        ],
      });

      // Either model var satisfies the requirement — reporting one as missing while
      // the other is set would send the owner to provision something already set.
      process.env.SIDESTAGE_COPILOT_MODEL = 'copilot-model';
      expect(productFocusClassifierConfig().missing).toEqual([
        'OPENAI_API_KEY',
        'or GOOGLE_CLOUD_PROJECT for the Vertex leg',
      ]);

      // CONTROL: fully configured reports nothing, so the assertions above are not
      // just "this function always finds something to complain about".
      process.env.OPENAI_API_KEY = 'test-key';
      expect(productFocusClassifierConfig()).toEqual({
        configured: true, provider: 'openai', missing: [],
      });
    });

    it('treats a whitespace-only value as missing, not as configured', () => {
      unconfigure();
      process.env.OPENAI_API_KEY = '   ';
      process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL = '';
      expect(productFocusClassifierConfig().configured).toBe(false);
      expect(productFocusClassifierConfig().missing).toHaveLength(3);
    });

    it('warns at STARTUP, naming the missing vars and the consequence', () => {
      unconfigure();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      new ConfiguredProductFocusClassifier().onModuleInit();

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain('OPENAI_API_KEY');
      expect(message).toContain('SIDESTAGE_PRODUCT_FOCUS_MODEL');
      // The consequence matters more than the missing key: it is what tells a
      // reader the symptom ("no suggestion") is this, and not a matching bug.
      expect(message).toContain('deterministic alias layer');
    });

    it('CONTROL: says NOTHING at startup when it is configured', () => {
      delete process.env.GOOGLE_CLOUD_PROJECT; // pin the OpenAI leg; Vertex wins otherwise
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL = 'focus-model';
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      new ConfiguredProductFocusClassifier().onModuleInit();
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns once more on FIRST USE — and only once, since this runs per utterance', async () => {
      unconfigure();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const classifier = new ConfiguredProductFocusClassifier();

      await expect(classifier.classify(INPUT)).resolves.toMatchObject({ source: 'unavailable' });
      expect(warn).toHaveBeenCalledTimes(1);
      // Distinct from the startup line on purpose: this one proves sellers are
      // actively losing suggestions, not merely that a setting is unset.
      expect(String(warn.mock.calls[0][0])).toContain('REQUESTED');

      // Per-utterance path — a warn per call would bury the log it is meant to raise.
      await classifier.classify(INPUT);
      await classifier.classify(INPUT);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: a configured classifier never emits the degraded-use warning', async () => {
      delete process.env.GOOGLE_CLOUD_PROJECT; // pin the OpenAI leg; Vertex wins otherwise
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL = 'focus-model';
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ output: [{ content: [{ text: JSON.stringify({
          decision: 'same', productId: null, confidence: 0.9, evidenceSegmentIds: [],
        }) }] }] }),
        { status: 200 },
      )));

      await new ConfiguredProductFocusClassifier().classify(INPUT);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('uses strict structured output and validates the model response', async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT; // pin the OpenAI leg; Vertex wins otherwise
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
    delete process.env.GOOGLE_CLOUD_PROJECT; // pin the OpenAI leg; Vertex wins otherwise
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL = 'focus-model';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    await expect(new ConfiguredProductFocusClassifier().classify(INPUT)).resolves.toMatchObject({
      decision: 'unknown', source: 'error', requestSequence: 7,
    });
  });
});

/**
 * The Vertex leg. This classifier was the ONE inference seam still hardcoded to
 * OpenAI while the copilot (copilot.module.ts) and judge (judge.module.ts) both
 * ran on Vertex — so in production it returned `unavailable` for every utterance
 * while working Vertex credentials sat in the same container.
 */
describe('semantic product-focus on the Vertex leg', () => {
  type FakeAdapter = ConstructorParameters<typeof VertexProductFocusClassifier>[0];
  /** Only `model` and `complete` are exercised; the rest of the adapter is irrelevant here. */
  const adapter = (content: string): FakeAdapter => ({
    model: 'gemini-test',
    complete: vi.fn(async () => ({ content })),
  } as unknown as FakeAdapter);
  const failingAdapter = (message: string): FakeAdapter => ({
    model: 'gemini-test',
    complete: vi.fn(async () => { throw new Error(message); }),
  } as unknown as FakeAdapter);

  it('prefers Vertex when GOOGLE_CLOUD_PROJECT is set, even with NO OpenAI key', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL;
    delete process.env.SIDESTAGE_COPILOT_MODEL;
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
    expect(productFocusClassifierConfig()).toEqual({
      configured: true, provider: 'vertex', missing: [],
    });
  });

  it('CONTROL: without GOOGLE_CLOUD_PROJECT it does NOT claim the Vertex leg', () => {
    // Otherwise the check above would pass for a function that always says vertex.
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SIDESTAGE_PRODUCT_FOCUS_MODEL;
    delete process.env.SIDESTAGE_COPILOT_MODEL;
    expect(productFocusClassifierConfig().provider).toBeNull();
  });

  it('accepts a confident, in-catalog verdict', async () => {
    const classifier = new VertexProductFocusClassifier(adapter(JSON.stringify({
      decision: 'different', productId: 'hoodie', confidence: 0.93, evidenceSegmentIds: ['segment-1'],
    })));
    await expect(classifier.classify(INPUT)).resolves.toMatchObject({
      decision: 'different', productId: 'hoodie', confidence: 0.93, source: 'model', requestSequence: 7,
    });
  });

  it('tolerates a fenced code block, which Gemini emits freely', async () => {
    const classifier = new VertexProductFocusClassifier(adapter(
      '```json\n{"decision":"same","productId":null,"confidence":0.8,"evidenceSegmentIds":[]}\n```',
    ));
    await expect(classifier.classify(INPUT)).resolves.toMatchObject({ decision: 'same', source: 'model' });
  });

  it('applies the SAME safety validation as the OpenAI leg — an invented id cannot stage anything', async () => {
    // The whole point of routing both legs through validateProductFocusModelPayload:
    // switching provider must not widen what a model is able to do.
    const classifier = new VertexProductFocusClassifier(adapter(JSON.stringify({
      decision: 'different', productId: 'not-in-catalog', confidence: 0.99, evidenceSegmentIds: [],
    })));
    await expect(classifier.classify(INPUT)).resolves.toMatchObject({
      decision: 'unknown', productId: null, confidence: 0,
    });
  });

  it('rejects a `different` verdict below the confidence floor', async () => {
    const classifier = new VertexProductFocusClassifier(adapter(JSON.stringify({
      decision: 'different', productId: 'hoodie', confidence: 0.5, evidenceSegmentIds: [],
    })));
    await expect(classifier.classify(INPUT)).resolves.toMatchObject({ decision: 'unknown', productId: null });
  });

  it('returns NO verdict (not a considered "unknown") when the provider fails', async () => {
    // A broken leg must stay distinguishable from a model that declined —
    // the caller maps this to source:'error', never source:'model'.
    await expect(new VertexProductFocusClassifier(failingAdapter('vertex 503')).classify(INPUT))
      .resolves.toBeNull();
  });

  it('returns NO verdict when the response carries no JSON object', async () => {
    await expect(new VertexProductFocusClassifier(adapter('I think it is the hoodie.')).classify(INPUT))
      .resolves.toBeNull();
  });

  it('surfaces a failed Vertex call as source:error through the configured classifier', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
    const classifier = new ConfiguredProductFocusClassifier();
    // Inject a failing leg directly — this asserts the mapping, not the adapter.
    (classifier as unknown as { vertex: VertexProductFocusClassifier }).vertex =
      new VertexProductFocusClassifier(failingAdapter('vertex 503'));
    await expect(classifier.classify(INPUT)).resolves.toMatchObject({
      decision: 'unknown', source: 'error', requestSequence: 7,
    });
  });
});
