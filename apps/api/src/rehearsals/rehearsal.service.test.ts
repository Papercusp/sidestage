import { describe, expect, it } from 'vitest';
import { REHEARSAL_RUNNERS, RehearsalService, summarizeDressRehearsal } from './rehearsal.service';
import { REHEARSAL_KINDS, type RehearsalReport } from './rehearsal.types';

function report(overrides: Partial<RehearsalReport>): RehearsalReport {
  return {
    runId: 'run_1',
    kind: 'actions',
    title: 'Guarded actions',
    summary: 'ok',
    totalCases: 1,
    passedCases: 1,
    passed: true,
    latencyMs: 5,
    ranAt: new Date(0).toISOString(),
    cases: [{ caseId: 'c1', title: 'A case', expectation: 'must hold', passed: true, observed: 'held' }],
    ...overrides,
  };
}

describe('rehearsal runner registry', () => {
  it('has a runner for every declared kind — and no orphans', () => {
    // A kind added to the type without a runner would 500 at the endpoint.
    expect(Object.keys(REHEARSAL_RUNNERS).sort()).toEqual([...REHEARSAL_KINDS].sort());
  });
});

describe('summarizeDressRehearsal', () => {
  it('is ready only when every case in every report held', () => {
    const verdict = summarizeDressRehearsal([report({}), report({ kind: 'auction' })], () => 1_000);
    expect(verdict.ready).toBe(true);
    expect(verdict.totalCases).toBe(2);
    expect(verdict.passedCases).toBe(2);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.ranAt).toBe(new Date(1_000).toISOString());
  });

  it('flattens failures from every rehearsal into one traceable blocker list', () => {
    const verdict = summarizeDressRehearsal([
      report({}),
      report({
        kind: 'checkout',
        passed: false,
        passedCases: 0,
        cases: [{ caseId: 'totals-add-up', title: 'Totals', expectation: 'must add up', passed: false, observed: 'off by $1' }],
      }),
    ]);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers).toEqual([
      { kind: 'checkout', caseId: 'totals-add-up', title: 'Totals', observed: 'off by $1' },
    ]);
    expect(verdict.passedCases).toBe(1);
    expect(verdict.totalCases).toBe(2);
  });

  it('NEVER reports an empty run as ready', () => {
    // "Nothing ran" and "everything passed" must not look the same to a host
    // deciding whether to go live.
    expect(summarizeDressRehearsal([]).ready).toBe(false);
  });

  it('de-duplicates caveats across reports', () => {
    const verdict = summarizeDressRehearsal([
      report({ caveats: ['stubbed payments'] }),
      report({ kind: 'injection', caveats: ['stubbed payments', 'guard scope only'] }),
    ]);
    expect(verdict.caveats).toEqual(['stubbed payments', 'guard scope only']);
  });
});

describe('RehearsalService', () => {
  it('runs a single named rehearsal', async () => {
    const result = await new RehearsalService().run('injection');
    expect(result.kind).toBe('injection');
    expect(result.passed).toBe(true);
  });

  it('runs the whole set and returns a ready verdict on a healthy build', async () => {
    const verdict = await new RehearsalService().runAll();
    expect(verdict.reports.map((entry) => entry.kind)).toEqual([...REHEARSAL_KINDS]);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.ready).toBe(true);
    expect(verdict.totalCases).toBeGreaterThan(30);
    expect(verdict.caveats.length).toBeGreaterThan(0);
  }, 30_000);
});
