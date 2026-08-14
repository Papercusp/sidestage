import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  buildRehearsalReport,
  centsToDollars,
  describeRefusal,
  expectRefusal,
  expectSuccess,
  runCase,
  summarize,
} from './rehearsal.report';
import type { RehearsalCaseSpec } from './rehearsal.types';

const spec: RehearsalCaseSpec = {
  caseId: 'case-1',
  title: 'A case',
  expectation: 'Something must hold',
};

describe('describeRefusal', () => {
  // These first two pin the duck-typing against the REAL Nest classes. Matching
  // a hand-written mock proves nothing if Nest's actual envelope differs.
  it('reads the deliberate { code, message } object a service throws', () => {
    const detail = describeRefusal(new BadRequestException({ code: 'price-floor', message: 'Below the floor' }));
    expect(detail.code).toBe('price-floor');
    expect(detail.message).toBe('Below the floor');
    expect(detail.status).toBe(400);
  });

  it('reads Nest\'s own envelope when a service throws a bare string', () => {
    const detail = describeRefusal(new ConflictException('Only 2 units remain'));
    expect(detail.code).toBeUndefined();
    expect(detail.message).toBe('Only 2 units remain');
    expect(detail.status).toBe(409);
  });

  it('carries the status through for a not-found refusal', () => {
    expect(describeRefusal(new NotFoundException('Audit missing')).status).toBe(404);
  });

  it('joins an array message rather than dropping it', () => {
    const detail = describeRefusal({
      getResponse: () => ({ statusCode: 400, message: ['first problem', 'second problem'] }),
      getStatus: () => 400,
    });
    expect(detail.message).toBe('first problem; second problem');
  });

  it('falls back to the error field when no message is present', () => {
    const detail = describeRefusal({ getResponse: () => ({ statusCode: 418, error: 'Teapot' }), getStatus: () => 418 });
    expect(detail.message).toBe('Teapot');
  });

  it('handles a plain Error and a non-error throw', () => {
    expect(describeRefusal(new Error('boom')).message).toBe('boom');
    expect(describeRefusal('just a string').message).toBe('just a string');
  });
});

describe('runCase', () => {
  it('folds the observation into the case identity', async () => {
    const result = await runCase(spec, () => ({ passed: true, observed: 'it held', evidence: { n: 1 } }));
    expect(result).toMatchObject({ caseId: 'case-1', passed: true, observed: 'it held', evidence: { n: 1 } });
  });

  it('turns an unexpected throw into a FAILED case instead of propagating', async () => {
    // The whole point: one broken case must not cost the seller every case after it.
    const result = await runCase(spec, () => { throw new Error('probe exploded'); });
    expect(result.passed).toBe(false);
    expect(result.observed).toContain('probe exploded');
  });
});

describe('expectRefusal', () => {
  it('passes when the seam refuses', async () => {
    const result = await expectRefusal(spec, async () => { throw new BadRequestException({ code: 'policy', message: 'nope' }); });
    expect(result.passed).toBe(true);
    expect(result.evidence).toMatchObject({ code: 'policy' });
  });

  it('fails when the seam refuses for a DIFFERENT reason than required', async () => {
    const result = await expectRefusal(
      spec,
      async () => { throw new BadRequestException({ code: 'markdown-limit', message: 'nope' }); },
      { code: 'price-floor' },
    );
    expect(result.passed).toBe(false);
    expect(result.observed).toContain('wrong reason');
  });

  it('does not fail a refusal whose code is unknown when a code was required', async () => {
    // A Nest envelope carries no `code`; refusing for the right reason with a
    // less structured error is still a refusal, not a silent pass-through.
    const result = await expectRefusal(spec, async () => { throw new ConflictException('stale'); }, { code: 'price-floor' });
    expect(result.passed).toBe(true);
  });

  it('FAILS LOUDLY when the call is allowed through', async () => {
    const result = await expectRefusal(spec, async () => ({ applied: true }));
    expect(result.passed).toBe(false);
    expect(result.observed).toContain('NOT REFUSED');
    expect(result.evidence?.allowedResult).toBe('{"applied":true}');
  });
});

describe('expectSuccess', () => {
  it('passes the resolved value to the check', async () => {
    const result = await expectSuccess(
      spec,
      async () => 42,
      (value) => ({ passed: value === 42, observed: `got ${value}` }),
    );
    expect(result).toMatchObject({ passed: true, observed: 'got 42' });
  });

  it('reports a rejection as a failed case', async () => {
    const result = await expectSuccess(
      spec,
      async () => { throw new ConflictException('unavailable'); },
      () => ({ passed: true, observed: 'never reached' }),
    );
    expect(result.passed).toBe(false);
    expect(result.observed).toContain('unavailable');
  });
});

describe('buildRehearsalReport', () => {
  const passing = { ...spec, passed: true, observed: 'ok' };
  const failing = { ...spec, caseId: 'case-2', passed: false, observed: 'bad' };

  it('counts, verdicts and summarizes a fully passing run', () => {
    const report = buildRehearsalReport({
      kind: 'actions',
      title: 'Guarded actions',
      cases: [passing, { ...passing, caseId: 'case-3' }],
      startedMs: 1_000,
      now: () => 1_250,
    });
    expect(report).toMatchObject({ passed: true, totalCases: 2, passedCases: 2, latencyMs: 250, kind: 'actions' });
    expect(report.summary).toBe('All 2 checks held.');
    expect(report.runId).toMatch(/^rehearsal_/);
    expect(report.ranAt).toBe(new Date(1_250).toISOString());
  });

  it('fails the whole report when any single case fails', () => {
    const report = buildRehearsalReport({ kind: 'actions', title: 't', cases: [passing, failing], startedMs: 0, now: () => 5 });
    expect(report.passed).toBe(false);
    expect(report.summary).toBe('1 of 2 checks failed.');
  });

  it('does not report an empty run as passing', () => {
    // A rehearsal that ran nothing must never read as a green light.
    const report = buildRehearsalReport({ kind: 'auction', title: 't', cases: [], startedMs: 0, now: () => 1 });
    expect(report.passed).toBe(false);
    expect(report.summary).toBe('No cases ran.');
  });

  it('never reports a negative latency when the clock moves backwards', () => {
    const report = buildRehearsalReport({ kind: 'checkout', title: 't', cases: [passing], startedMs: 500, now: () => 100 });
    expect(report.latencyMs).toBe(0);
  });

  it('carries caveats only when there are some', () => {
    expect(buildRehearsalReport({ kind: 'checkout', title: 't', cases: [passing], startedMs: 0, now: () => 1 }).caveats)
      .toBeUndefined();
    expect(buildRehearsalReport({
      kind: 'checkout', title: 't', cases: [passing], startedMs: 0, now: () => 1, caveats: ['stubbed payment'],
    }).caveats).toEqual(['stubbed payment']);
  });
});

describe('formatting helpers', () => {
  it('renders cents as dollars', () => {
    expect(centsToDollars(2_800)).toBe('$28.00');
    expect(centsToDollars(999)).toBe('$9.99');
  });

  it('summarizes values without throwing on a cycle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => summarize(cyclic)).not.toThrow();
    expect(summarize(undefined)).toBe('undefined');
    expect(summarize('plain')).toBe('plain');
    expect(summarize('x'.repeat(400))).toHaveLength(300);
  });
});
