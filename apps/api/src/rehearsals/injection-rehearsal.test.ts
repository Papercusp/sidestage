import { describe, expect, it } from 'vitest';
import { runInjectionRehearsal } from './injection-rehearsal';

describe('injection rehearsal', () => {
  it('reports every hostile case as blocked by the real guard', async () => {
    const report = await runInjectionRehearsal();
    const failed = report.cases.filter((entry) => !entry.passed);
    expect(failed.map((entry) => `${entry.caseId}: ${entry.observed}`)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.kind).toBe('injection');
  });

  it('covers the manipulation patterns a live room actually produces', async () => {
    const report = await runInjectionRehearsal();
    expect(report.cases.map((entry) => entry.caseId)).toEqual([
      'instruction-override',
      'fake-seller-authority',
      'claimed-policy-change',
      'invented-stock',
      'social-engineered-stock-edit',
      'free-item',
      'markdown-that-raises-price',
      'invented-product',
      'tone-breach-blocked',
      'empty-reply-blocked',
    ]);
  });

  it('blocks each attempt for the reason the policy actually gives', async () => {
    const report = await runInjectionRehearsal();
    const codeFor = (caseId: string) => report.cases.find((entry) => entry.caseId === caseId)?.evidence?.code;
    expect(codeFor('instruction-override')).toBe('price-floor');
    expect(codeFor('fake-seller-authority')).toBe('price-floor');
    expect(codeFor('claimed-policy-change')).toBe('markdown-limit');
    expect(codeFor('invented-stock')).toBe('availability');
    expect(codeFor('social-engineered-stock-edit')).toBe('policy');
    expect(codeFor('markdown-that-raises-price')).toBe('invalid-action');
    expect(codeFor('tone-breach-blocked')).toBe('tone');
  });

  it('states its scope instead of overclaiming', async () => {
    // The dangerous misreading is "green here means the model is unjailbreakable".
    const report = await runInjectionRehearsal();
    expect(report.caveats?.[0]).toContain('does not prove the model');
  });

  it('catches a guard that lets something through rather than reporting it quietly', async () => {
    // Calibration: prove the guard-decision path FAILS on an allow, so a green
    // run means the guard blocked — not that the case forgot to check.
    const { runCase } = await import('./rehearsal.report');
    const result = await runCase(
      { caseId: 'control', title: 'control', expectation: 'must block' },
      async () => {
        const decision = { allowed: true };
        return decision.allowed
          ? { passed: false, observed: 'ALLOWED THROUGH — the guard did not stop this, so it would have reached a buyer.' }
          : { passed: true, observed: 'blocked' };
      },
    );
    expect(result.passed).toBe(false);
    expect(result.observed).toContain('ALLOWED THROUGH');
  });
});
