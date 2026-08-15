import { describe, expect, it } from 'vitest';

import {
  detectTranscriptProductFocus,
  findTranscriptProductMention,
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
