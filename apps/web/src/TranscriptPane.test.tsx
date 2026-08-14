import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TranscriptPane, findTranscriptProductMention, resolveTranscriptStageIntent, type TranscriptProductOption } from './TranscriptPane';
import type { TranscriptionSession } from './transcription';

const PRODUCTS: readonly TranscriptProductOption[] = [
  { id: 'hoodie', label: 'Linen hoodie', price: '$48.00', aliases: ['hoodie'] },
  { id: 'mug', label: 'Stoneware mug', price: '$24.00', aliases: ['mug'] },
];

const SESSION: TranscriptionSession = {
  provider: 'web-speech',
  state: 'idle',
  start: async () => undefined,
  stop: async () => undefined,
  onSegment: () => () => undefined,
  onState: () => () => undefined,
  onError: () => () => undefined,
};

describe('transcript product mentions', () => {
  it('matches labels and aliases without being case-sensitive', () => {
    expect(findTranscriptProductMention('Could you show me that STONEWARE mug?', PRODUCTS)?.id).toBe('mug');
    expect(findTranscriptProductMention('The hoodie looks great on camera.', PRODUCTS)?.id).toBe('hoodie');
  });

  it('returns no suggestion when the transcript names no catalog item', () => {
    expect(findTranscriptProductMention('How quickly do you ship?', PRODUCTS)).toBeNull();
  });

  it('proposes an explicitly mentioned variant before changing the stage', () => {
    expect(resolveTranscriptStageIntent('Show the stoneware mug', PRODUCTS, null)).toEqual({
      kind: 'propose', product: PRODUCTS[1],
    });
  });

  it.each(['confirm', 'YES', 'stage it'])('accepts the one-phrase confirmation %s', (phrase) => {
    expect(resolveTranscriptStageIntent(phrase, PRODUCTS, PRODUCTS[1])).toEqual({
      kind: 'confirm', product: PRODUCTS[1],
    });
  });

  it('does not treat a confirmation word as a product change without a pending proposal', () => {
    expect(resolveTranscriptStageIntent('yes', PRODUCTS, null)).toBeNull();
  });

  it('renders a manual active-item picker when products are supplied', () => {
    const markup = renderToStaticMarkup(<TranscriptPane session={SESSION} products={PRODUCTS} />);
    expect(markup).toContain('Active product');
    expect(markup).toContain('No active item');
    expect(markup).toContain('Linen hoodie');
    expect(markup).toContain('Stoneware mug');
  });
});
