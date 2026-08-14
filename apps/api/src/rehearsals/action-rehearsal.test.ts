import { describe, expect, it } from 'vitest';
import { runActionRehearsal } from './action-rehearsal';

describe('guarded-action rehearsal', () => {
  it('reports every case as passing against the real guarded-action service', async () => {
    const report = await runActionRehearsal();
    const failed = report.cases.filter((entry) => !entry.passed);
    // Name the failures in the assertion message: a bare "false !== true" would
    // make a real guard regression the most annoying possible thing to diagnose.
    expect(failed.map((entry) => `${entry.caseId}: ${entry.observed}`)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.kind).toBe('actions');
    expect(report.passedCases).toBe(report.totalCases);
  });

  it('covers the refusals the depth area actually claims', async () => {
    const report = await runActionRehearsal();
    expect(report.cases.map((entry) => entry.caseId)).toEqual([
      'markdown-within-cap',
      'markdown-beyond-cap',
      'price-below-floor',
      'blocked-action-kind',
      'unverified-product',
      'price-on-non-price-action',
      'offer-beyond-stock',
      'offer-without-buyer',
      'audit-record-written',
      'rollback-restores-state',
      'double-rollback-refused',
      'stale-rollback-refused',
    ]);
  });

  it('refuses each guarded write for the SPECIFIC documented reason', async () => {
    const report = await runActionRehearsal();
    const codeFor = (caseId: string) => report.cases.find((entry) => entry.caseId === caseId)?.evidence?.code;
    // If the guard ever starts refusing for a different reason, the refusal is
    // still a refusal — but the seller is being told the wrong story, so pin it.
    expect(codeFor('markdown-beyond-cap')).toBe('markdown-limit');
    expect(codeFor('price-below-floor')).toBe('price-floor');
    expect(codeFor('blocked-action-kind')).toBe('policy');
    expect(codeFor('offer-beyond-stock')).toBe('availability');
    expect(codeFor('offer-without-buyer')).toBe('buyer-target');
    expect(codeFor('price-on-non-price-action')).toBe('invalid-action');
  });

  it('is isolated: a second run behaves identically to the first', async () => {
    // Each case builds its own service + event. If state ever leaked between
    // runs, prices would already be marked down and the cap cases would drift.
    const first = await runActionRehearsal();
    const second = await runActionRehearsal();
    expect(second.cases.map((entry) => [entry.caseId, entry.passed]))
      .toEqual(first.cases.map((entry) => [entry.caseId, entry.passed]));
    expect(second.runId).not.toBe(first.runId);
  });

  it('shows the seller what actually happened, not just a verdict', async () => {
    const report = await runActionRehearsal();
    for (const entry of report.cases) {
      expect(entry.expectation.length).toBeGreaterThan(20);
      expect(entry.observed.length).toBeGreaterThan(10);
    }
    const applied = report.cases.find((entry) => entry.caseId === 'markdown-within-cap');
    expect(applied?.observed).toContain('$24.00');
    const restored = report.cases.find((entry) => entry.caseId === 'rollback-restores-state');
    expect(restored?.evidence?.priceAfterRollback).toBe('$28.00');
  });
});
