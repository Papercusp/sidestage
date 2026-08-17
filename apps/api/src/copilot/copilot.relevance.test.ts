import { describe, expect, it } from 'vitest';
import { firstRelevantSourceId, sourceSupportsQuestion } from './copilot.relevance';
import type { CatalogProductContext, EventItemContext, GroundingContext } from './copilot.types';

/**
 * The focused relevance regression EI-20488839136964773 asked for.
 *
 * Relevance had no test of its own: it was exercised only through the pipeline
 * and claims suites, both of which ask short, well-behaved questions. That is
 * exactly why the defect below survived — the phrasings that break it are the
 * natural ones a buyer types, not the ones a test author reaches for.
 */

const KETTLE: EventItemContext = {
  eventItemId: 'test:event-demo-01-v2',
  productId: 'event-demo-01-v2',
  title: 'Harbor Kettle',
  priceCents: 7600,
  availableQty: 6,
  attributes: { sku: 'SS-DEMO-01-V2', brand: 'Hearthline', color: 'Ocean', condition: 'NEW' },
};

const HEADPHONES: EventItemContext = {
  eventItemId: 'test:event-demo-02-v1',
  productId: 'event-demo-02-v1',
  title: 'Cloud ANC Headphones',
  priceCents: 19900,
  availableQty: 4,
  attributes: { sku: 'SS-DEMO-02-V1', brand: 'Northstar Audio', color: 'Ocean', condition: 'NEW' },
};

const KETTLE_PRODUCT: CatalogProductContext = {
  productId: 'event-demo-01-v2',
  title: 'Harbor Kettle',
  priceCents: 7600,
  attributes: { sku: 'SS-DEMO-01-V2', brand: 'Hearthline', color: 'Ocean' },
};

const CONTEXT: GroundingContext = {
  eventItems: [KETTLE, HEADPHONES],
  catalogProducts: [KETTLE_PRODUCT],
  policy: {} as GroundingContext['policy'],
  sources: [
    { id: `event-item:${KETTLE.eventItemId}`, kind: 'event-item', label: 'Harbor Kettle live event listing' },
    { id: `event-item:${HEADPHONES.eventItemId}`, kind: 'event-item', label: 'Cloud ANC Headphones live event listing' },
    { id: `catalog-product:${KETTLE_PRODUCT.productId}`, kind: 'catalog-product', label: 'Harbor Kettle verified catalog record' },
  ],
};

const KETTLE_SOURCE = `event-item:${KETTLE.eventItemId}`;
const HEADPHONE_SOURCE = `event-item:${HEADPHONES.eventItemId}`;

const supports = (message: string, requiredProperties?: readonly string[]): boolean =>
  sourceSupportsQuestion(KETTLE_SOURCE, { message, ...(requiredProperties ? { requiredProperties } : {}) }, CONTEXT);

describe('sourceSupportsQuestion — question phrasing must not decide grounding', () => {
  // The four phrasings measured live against the running stack on 2026-08-17.
  // Before the fix only the first grounded; the other three returned
  // "Grounded by No verified citation" and the proposal blocked.
  it('grounds the short phrasing', () => {
    expect(supports('How much is the Harbor Kettle?')).toBe(true);
  });

  it('grounds a combined price + availability question', () => {
    expect(supports('What is the event price of the Harbor Kettle, and how many are available right now?')).toBe(true);
  });

  it('grounds the same question behind an unrelated leading token', () => {
    expect(supports('Acceptance 20470169018543759: What is the event price of the Harbor Kettle, and how many are available right now?')).toBe(true);
  });

  it('grounds the short phrasing behind an unrelated leading token', () => {
    // The decisive case: a prefix alone defeated an otherwise-good question,
    // which is what proved the leading token and the combined intent were one
    // defect (an all-tokens conjunction) rather than two.
    expect(supports('Acceptance 20470169018543759: How much is the Harbor Kettle?')).toBe(true);
  });

  it('does not let question length erode grounding', () => {
    const verbose = 'Hi there, I was just wondering, if it is not too much trouble, whether you could possibly '
      + 'let me know roughly what the Harbor Kettle costs today, whenever you get a moment?';
    expect(supports(verbose)).toBe(true);
  });
});

describe('sourceSupportsQuestion — a source may only answer for itself', () => {
  it('does not ground a kettle question on the headphones listing', () => {
    // Every priced item can speak to "how much", so intent words must never
    // anchor a question to a source; only identity may.
    expect(
      sourceSupportsQuestion(HEADPHONE_SOURCE, { message: 'How much is the Harbor Kettle?' }, CONTEXT),
    ).toBe(false);
  });

  it('does not ground a question that names no product in context', () => {
    expect(supports('How much is the espresso machine?')).toBe(false);
  });

  it('picks the identity-matching event item, not merely the first one', () => {
    expect(
      firstRelevantSourceId({ message: 'How many Cloud ANC Headphones are left?' }, CONTEXT, 'event-item:'),
    ).toBe(HEADPHONE_SOURCE);
  });
});

describe('sourceSupportsQuestion — requiredProperties stay a strict conjunction', () => {
  // These three pin the WI-39264 acceptance contract: a missing catalog
  // property must still fall through to the research fallback rather than being
  // answered from a catalog that lacks the fact. Relaxing free-text matching
  // must not relax this channel.
  it('refuses a source that lacks a demanded property', () => {
    expect(supports('How much is the Harbor Kettle?', ['capacity-litres'])).toBe(false);
  });

  it('accepts a source that carries the demanded property', () => {
    expect(supports('How much is the Harbor Kettle?', ['color'])).toBe(true);
  });

  it('refuses a demanded property even when the question alone would ground', () => {
    expect(supports('What is the price of the Harbor Kettle?', ['warranty-years'])).toBe(false);
  });

  it('still requires the question to name the source when properties are demanded', () => {
    expect(
      sourceSupportsQuestion(HEADPHONE_SOURCE, { message: 'How much is the Harbor Kettle?', requiredProperties: ['color'] }, CONTEXT),
    ).toBe(false);
  });
});

describe('sourceSupportsQuestion — a record must answer for something it holds', () => {
  // The counterweight to the phrasing fix above, and the reason it is phrased as
  // "did the buyer ask something this record knows" rather than "is this the
  // product they named". Both callers below have NO other guard:
  // GroundedCopilotPipeline imports no claims layer, and the deterministic
  // no-model reply path (copilot.model.ts) has no intent gate of its own — so
  // relaxing this predicate all the way would let an event item answer a
  // warranty question with its price.
  it('refuses a property question the record cannot speak to', () => {
    expect(supports('Does the Harbor Kettle include a five-year warranty and free overnight shipping?')).toBe(false);
  });

  it('refuses a property question even though the question names the product', () => {
    // Identity alone must not admit the source: "Harbor Kettle" hits identity
    // here, and the answer is still no.
    expect(supports('Does the Harbor Kettle come with a spare filter?')).toBe(false);
  });

  it('grounds an attribute question the record does carry', () => {
    // No price or stock word anywhere, so this passes only because every
    // content word is already in the source vocabulary.
    expect(supports('What color is the Harbor Kettle?')).toBe(true);
  });

  it('grounds a mixed question on the half the record can serve', () => {
    // DELIBERATE, DOCUMENTED GAP. Answering the answerable half is the product
    // behaviour EI-20488839136964773 asks for; keeping the reply's warranty
    // half honest belongs to the claim/evidence contract (copilot.claims.ts),
    // re-checked at send time against a fresh fingerprint.
    expect(supports('How much is the Harbor Kettle, and does it have a warranty?')).toBe(true);
  });
});

describe('sourceSupportsQuestion — unknown sources', () => {
  it('refuses a source id that is not in context', () => {
    expect(
      sourceSupportsQuestion('event-item:test:does-not-exist', { message: 'How much is the Harbor Kettle?' }, CONTEXT),
    ).toBe(false);
  });

  it('refuses an unrecognised source prefix', () => {
    expect(
      sourceSupportsQuestion('mystery:1', { message: 'How much is the Harbor Kettle?' }, CONTEXT),
    ).toBe(false);
  });
});
