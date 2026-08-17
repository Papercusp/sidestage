import { describe, expect, it } from 'vitest';

import {
  detectTranscriptProductFocus,
  findTranscriptProductMention,
  normalizeTranscriptFocusText,
  productGroupKey,
  transcriptFocusWindow,
  type TranscriptProductOption,
} from './transcript-product-focus';

const PRODUCTS: readonly TranscriptProductOption[] = [
  {
    id: 'mug',
    label: 'Stoneware mug',
    aliases: ['mug'],
    brand: 'Hearth',
    productType: 'drinkware',
    color: 'sand',
  },
  {
    id: 'hoodie',
    label: 'Linen hoodie',
    aliases: ['hoodie'],
    brand: 'Northline',
    productType: 'apparel',
    color: 'navy',
  },
  {
    id: 'tote',
    label: 'Canvas tote',
    aliases: ['tote bag'],
    brand: 'Northline',
    productType: 'accessories',
    color: 'navy',
  },
];

describe('transcript product-focus policy', () => {
  it('keeps only the bounded finalized context window', () => {
    const segments = Array.from({ length: 6 }, (_, index) => ({ id: String(index), text: `segment ${index}` }));
    expect(transcriptFocusWindow(segments).map((segment) => segment.id)).toEqual(['2', '3', '4', '5']);
  });

  it('matches labels and aliases while keeping shared weak metadata out of the alias path', () => {
    expect(findTranscriptProductMention('Show the STONEWARE mug.', PRODUCTS)?.id).toBe('mug');
    expect(findTranscriptProductMention('That tote bag has strong handles.', PRODUCTS)?.id).toBe('tote');
    expect(findTranscriptProductMention('The navy one is here.', PRODUCTS)).toBeNull();
  });

  it('suppresses mentions of the already-active product', () => {
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: 'The stoneware mug is dishwasher safe.' }],
      products: PRODUCTS,
      activeProductId: 'mug',
    })).toMatchObject({ kind: 'none', reason: 'active-product-only', needsSemantic: false });
  });

  it('suggests an explicitly named different product', () => {
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: 'The linen hoodie has an oversized fit.' }],
      products: PRODUCTS,
      activeProductId: 'mug',
    })).toMatchObject({
      kind: 'suggest',
      product: { id: 'hoodie' },
      reason: 'explicit-name',
      evidenceSegmentIds: ['one'],
    });
  });

  it('strengthens a stable different-product focus repeated across finalized segments', () => {
    expect(detectTranscriptProductFocus({
      segments: [
        { id: 'one', text: 'The linen hoodie has an oversized fit.' },
        { id: 'two', text: 'This linen hoodie also has reinforced cuffs.' },
      ],
      products: PRODUCTS,
      activeProductId: 'mug',
    })).toMatchObject({
      kind: 'suggest',
      product: { id: 'hoodie' },
      reason: 'repeated-focus',
      confidence: 0.99,
      evidenceSegmentIds: ['one', 'two'],
    });
  });

  it('resolves a transition cue across adjacent finalized segments', () => {
    expect(detectTranscriptProductFocus({
      segments: [
        { id: 'one', text: 'Now let us move on to the next item.' },
        { id: 'two', text: 'The canvas tote has reinforced handles.' },
      ],
      products: PRODUCTS,
      activeProductId: 'mug',
    })).toMatchObject({ kind: 'suggest', product: { id: 'tote' } });
  });

  it('does not interpret a comparison as a focus transition', () => {
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: 'The mug costs less than the linen hoodie.' }],
      products: PRODUCTS,
      activeProductId: 'mug',
    })).toMatchObject({ kind: 'ambiguous', reason: 'comparison', needsSemantic: true });
  });

  it('uses a product explicitly named after a transition even when the old product is mentioned', () => {
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: 'That finishes the mug; now let us look at the linen hoodie.' }],
      products: PRODUCTS,
      activeProductId: 'mug',
    })).toMatchObject({ kind: 'suggest', product: { id: 'hoodie' }, reason: 'explicit-transition' });
  });

  it('fails ambiguous when multiple alternative products are discussed', () => {
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: 'The linen hoodie and canvas tote both come in navy.' }],
      products: PRODUCTS,
      activeProductId: 'mug',
    })).toMatchObject({ kind: 'ambiguous', reason: 'multiple-products', needsSemantic: true });
  });

  it('requests semantic help for a transition with no explicit catalog name', () => {
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: 'Moving on now, this one has reinforced handles and a shoulder strap.' }],
      products: PRODUCTS,
      activeProductId: 'mug',
    })).toMatchObject({ kind: 'none', reason: 'no-catalog-signal', needsSemantic: true });
  });
});

/**
 * WI-39739. The seller said "Now let's switch to the arc table lamp." and
 * nothing was suggested — for EVERY product in the demo catalog, because all 27
 * titles ship several colourways. Ambiguity was counted over catalog ROWS, so
 * one product wearing four variant ids read as four products.
 *
 * The shape of this fixture is the whole point: four rows, one title, one
 * group. That is the production data, and no existing fixture had it.
 */
const LAMP_VARIANTS: readonly TranscriptProductOption[] = ['Sage', 'Sand', 'Plum', 'Clay'].map(
  (color, index) => ({
    id: `event-demo-03-v${index + 1}`,
    groupKey: 'event-demo-03',
    label: 'Arc Table Lamp',
    aliases: ['arc table', 'table lamp'],
    brand: 'Field & Form',
    productType: 'LIGHTING',
    color,
    sku: `SS-DEMO-03-V${index + 1}`,
  }),
);

const SPEAKER_VARIANTS: readonly TranscriptProductOption[] = ['Ash', 'Ink'].map((color, index) => ({
  id: `event-demo-07-v${index + 1}`,
  groupKey: 'event-demo-07',
  label: 'Shelf Speaker',
  aliases: ['shelf speaker'],
  brand: 'Northpeak',
  productType: 'AUDIO',
  color,
  sku: `SS-DEMO-07-V${index + 1}`,
}));

const MULTI_VARIANT_CATALOG = [...LAMP_VARIANTS, ...SPEAKER_VARIANTS];

describe('WI-39739 — multi-variant products must not read as multiple products', () => {
  it('suggests the product from the owner-reported sentence, which previously returned ambiguous', () => {
    const decision = detectTranscriptProductFocus({
      segments: [{ id: 'one', text: "Now let's switch to the arc table lamp." }],
      products: MULTI_VARIANT_CATALOG,
      activeProductId: null,
    });

    expect(decision).toMatchObject({ kind: 'suggest', reason: 'explicit-transition' });
    // The staged row must be a lamp, not a speaker — and not merely "not null".
    expect(decision.kind === 'suggest' && decision.product.label).toBe('Arc Table Lamp');
  });

  it('is the VARIANT GROUPING that fixes it, not looser matching', () => {
    // The same four rows with no group: genuinely four products by the only
    // key available, so ambiguous is the CORRECT answer. This is the negative
    // control — without it, the test above could pass because the detector had
    // simply been made permissive.
    const ungrouped = LAMP_VARIANTS.map(({ groupKey: _ignored, ...rest }) => rest);
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: "Now let's switch to the arc table lamp." }],
      products: ungrouped,
      activeProductId: null,
    })).toMatchObject({ kind: 'ambiguous', reason: 'multiple-products' });
  });

  it('still refuses to guess when two DIFFERENT products are named', () => {
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: 'The arc table lamp and the shelf speaker both sold well.' }],
      products: MULTI_VARIANT_CATALOG,
      activeProductId: null,
    })).toMatchObject({ kind: 'ambiguous', reason: 'multiple-products', needsSemantic: true });
  });

  it('offers the colourways instead of silently staging one the seller never named', () => {
    const decision = detectTranscriptProductFocus({
      segments: [{ id: 'one', text: "Now let's switch to the arc table lamp." }],
      products: MULTI_VARIANT_CATALOG,
      activeProductId: null,
    });
    expect(decision.kind === 'suggest' && decision.variantChoices?.map((choice) => choice.color))
      .toEqual(['Sage', 'Sand', 'Plum', 'Clay']);
  });

  it('omits the picker when the named product has only one variant', () => {
    const single = [{ id: 'solo', groupKey: 'solo-group', label: 'Arc Table Lamp' }];
    const decision = detectTranscriptProductFocus({
      segments: [{ id: 'one', text: "Now let's switch to the arc table lamp." }],
      products: single,
      activeProductId: null,
    });
    expect(decision.kind === 'suggest' && 'variantChoices' in decision).toBe(false);
  });

  it('treats a sibling colourway as the product already on stage, not a switch', () => {
    // Saying the product's name while one of its colourways is live is not a
    // request to swap to a different colourway.
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: 'This arc table lamp reads warm on camera.' }],
      products: MULTI_VARIANT_CATALOG,
      activeProductId: 'event-demo-03-v1',
    })).toMatchObject({ kind: 'none', reason: 'active-product-only' });
  });

  it('groups a row that has no group under its own id', () => {
    expect(productGroupKey({ id: 'solo', label: 'Solo' })).toBe('solo');
    expect(productGroupKey({ id: 'v1', groupKey: 'g', label: 'Grouped' })).toBe('g');
  });
});

describe("WI-39739 — an apostrophe must not break the transition cues", () => {
  it('keeps contractions as one word so the cue spellings can match', () => {
    expect(normalizeTranscriptFocusText("Now let's look at the lamp")).toBe('now lets look at the lamp');
    // Typographic apostrophes are what real caption streams emit.
    expect(normalizeTranscriptFocusText('Now let’s look at the lamp')).toBe('now lets look at the lamp');
  });

  it("fires on \"let's look at\", which no cue could match before", () => {
    expect(detectTranscriptProductFocus({
      segments: [{ id: 'one', text: "That's the mug done. Now let's look at the linen hoodie." }],
      products: PRODUCTS,
      activeProductId: 'mug',
    })).toMatchObject({ kind: 'suggest', product: { id: 'hoodie' }, reason: 'explicit-transition' });
  });
});
