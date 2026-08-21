import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEMO_JUDGE_CASES, runJudgeRehearsal } from './judge';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('routes the browser rehearsal to the local API when VITE_API_URL is absent', async () => {
    const report = { runId: 'judge-run-1' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(report), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(runJudgeRehearsal()).resolves.toEqual(report);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3110/judge/run', expect.objectContaining({
      method: 'POST',
    }));
  });
});
