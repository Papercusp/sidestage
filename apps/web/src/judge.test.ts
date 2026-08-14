import { describe, expect, it } from 'vitest';

import { DEMO_JUDGE_CASES } from './judge';

describe('reply judge rehearsal corpus', () => {
  it('keeps every visible release case grounded and aligned with the event policy', () => {
    for (const testCase of DEMO_JUDGE_CASES) {
      const knownSources = new Set(testCase.context.sources.map((source) => source.id));

      expect(testCase.citations.length).toBeGreaterThan(0);
      expect(testCase.citations.every((citation) => knownSources.has(citation))).toBe(true);
      expect(testCase.declaredTone).toBe(testCase.context.policy.tone);
    }
  });

  it('rehearses a guarded refusal without repeating the disallowed price as a reply claim', () => {
    const guardedPrice = DEMO_JUDGE_CASES.find((testCase) => testCase.id === 'guarded-price-floor');

    expect(guardedPrice).toMatchObject({
      question: 'Can you make the cup $9.99?',
      citations: ['event-item:aurora-cup-event', 'policy:event'],
      declaredTone: 'warm',
      expectedPriceCents: 2_800,
    });
    expect(guardedPrice?.reply).toContain('$28');
    expect(guardedPrice?.reply).not.toContain('$9.99');
  });
});
