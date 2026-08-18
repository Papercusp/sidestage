// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  BENCHMARK_SCENARIOS,
  buildReport,
  DEFAULT_COMPLETE_P95_BUDGET_MS,
  evaluateAcceptance,
  LATENCY_BEARING_SCENARIOS,
  summarizeScenario,
  type BenchmarkProvenance,
  type BenchmarkScenarioName,
  type ScenarioResult,
} from './benchmark';
import { CopilotLatencyBudget } from './latency';

function budgetWith(completeMs: readonly number[], provider = 'vertex', error = false) {
  const budget = new CopilotLatencyBudget();
  for (const value of completeMs) {
    budget.record({ ttftMs: null, completeMs: value, provider, error });
  }
  return budget;
}

function scenario(
  name: BenchmarkScenarioName,
  completeMs: readonly number[],
  observations: Partial<ScenarioResult> = {},
): ScenarioResult {
  return {
    ...summarizeScenario(name, budgetWith(completeMs), { allTurnsAnswered: true }),
    ...observations,
  };
}

const provenance: BenchmarkProvenance = {
  provider: 'vertex',
  model: 'gemini-3.1-pro-preview-customtools',
  host: 'test',
  samplesPerScenario: 3,
};

describe('summarizeScenario', () => {
  it('reads percentiles from the latency budget rather than recomputing them', () => {
    const budget = budgetWith([100, 200, 300]);
    const result = summarizeScenario('catalog-only', budget, { allTurnsAnswered: true });

    expect(result.sampleCount).toBe(3);
    // Nearest-rank p50 of [100,200,300] is the 2nd value; the budget owns this.
    expect(result.p50.completeMs).toBe(budget.snapshot().p50.completeMs);
    expect(result.p95.completeMs).toBe(budget.snapshot().p95.completeMs);
    expect(result.providerBreakdown.vertex.sampleCount).toBe(3);
  });

  it('deduplicates and sorts degradation reasons', () => {
    const result = summarizeScenario('timeout', budgetWith([10]), {
      allTurnsAnswered: true,
      degradedReasons: ['provider-failed', 'deadline-exceeded', 'deadline-exceeded'],
    });

    expect(result.degradedReasons).toEqual(['deadline-exceeded', 'provider-failed']);
  });

  it('carries the error rate through from an errored provider leg', () => {
    const result = summarizeScenario('fallback', budgetWith([10, 20], 'vertex', true), {
      allTurnsAnswered: true,
    });

    expect(result.errorRate).toBe(1);
  });
});

describe('evaluateAcceptance', () => {
  it('accepts when the worst latency-bearing p95 is under budget', () => {
    const ruling = evaluateAcceptance([
      scenario('catalog-only', [400, 500]),
      scenario('concurrent', [600, 700]),
    ]);

    expect(ruling.verdict).toBe('accept-under-budget');
    expect(ruling.gate).toBe('green');
    expect(ruling.p95UnderBudget).toBe(true);
    expect(ruling.observedP95CompleteMs).toBe(700);
  });

  it('uses the WORST latency-bearing p95, not an average across scenarios', () => {
    const ruling = evaluateAcceptance([
      scenario('catalog-only', [100]),
      scenario('concurrent', [9000]),
    ]);

    // An average would be 4550 and a "fast path" reading would be 100; neither
    // is the number a buyer on the slow path experiences.
    expect(ruling.observedP95CompleteMs).toBe(9000);
    expect(ruling.p95UnderBudget).toBe(false);
  });

  it('EXCLUDES the timeout scenario from the headline p95', () => {
    // The timeout scenario induces its own deadline on purpose. If it counted,
    // the harness would be measuring itself and every run would read as slow.
    const ruling = evaluateAcceptance([
      scenario('catalog-only', [300]),
      { ...scenario('timeout', [30_000]), degradedReasons: ['deadline-exceeded'] },
    ]);

    expect(ruling.observedP95CompleteMs).toBe(300);
    expect(ruling.verdict).toBe('accept-under-budget');
    expect(LATENCY_BEARING_SCENARIOS).not.toContain('timeout');
  });

  it('accepts a RED gate when over budget but degradation is proven safe', () => {
    const ruling = evaluateAcceptance([
      scenario('catalog-only', [3186]),
      { ...scenario('timeout', [50]), degradedReasons: ['deadline-exceeded'], allTurnsAnswered: true },
    ]);

    expect(ruling.verdict).toBe('accept-red-gate-safe-degradation');
    expect(ruling.gate).toBe('red');
    expect(ruling.p95UnderBudget).toBe(false);
    expect(ruling.safeDegradationProven).toBe(true);
    expect(ruling.reason).toContain('degrades safely');
  });

  it('REJECTS when over budget and the timeout scenario never induced a deadline', () => {
    const ruling = evaluateAcceptance([
      scenario('catalog-only', [3186]),
      { ...scenario('timeout', [50]), degradedReasons: [], allTurnsAnswered: true },
    ]);

    expect(ruling.verdict).toBe('reject-unsafe-over-budget');
    expect(ruling.safeDegradationProven).toBe(false);
  });

  it('REJECTS when over budget and a turn threw instead of falling back', () => {
    const ruling = evaluateAcceptance([
      scenario('catalog-only', [3186]),
      { ...scenario('timeout', [50]), degradedReasons: ['deadline-exceeded'], allTurnsAnswered: false },
    ]);

    expect(ruling.verdict).toBe('reject-unsafe-over-budget');
  });

  it('does not claim safe degradation from a timeout scenario with no samples', () => {
    const ruling = evaluateAcceptance([
      scenario('catalog-only', [3186]),
      { ...scenario('timeout', []), degradedReasons: ['deadline-exceeded'] },
    ]);

    expect(ruling.safeDegradationProven).toBe(false);
    expect(ruling.verdict).toBe('reject-unsafe-over-budget');
  });

  it('reports insufficient-data rather than a false green when nothing was measured', () => {
    const ruling = evaluateAcceptance([scenario('catalog-only', [])]);

    expect(ruling.verdict).toBe('insufficient-data');
    expect(ruling.gate).toBe('red');
    expect(ruling.observedP95CompleteMs).toBeNull();
  });

  it('honours a caller-supplied budget', () => {
    const ruling = evaluateAcceptance([scenario('catalog-only', [1500])], 1_000);

    expect(ruling.budgetMs).toBe(1_000);
    expect(ruling.p95UnderBudget).toBe(false);
  });

  it('defaults the budget to the work item bar of 2000ms', () => {
    expect(DEFAULT_COMPLETE_P95_BUDGET_MS).toBe(2_000);
    expect(evaluateAcceptance([scenario('catalog-only', [1999])]).p95UnderBudget).toBe(true);
    expect(evaluateAcceptance([scenario('catalog-only', [2000])]).p95UnderBudget).toBe(false);
  });
});

describe('buildReport', () => {
  it('emits every field the acceptance clause requires to be persisted', () => {
    const report = buildReport([scenario('catalog-only', [100, 200])], provenance, {
      now: () => new Date('2026-08-18T01:00:00.000Z'),
    });

    expect(report.generatedAt).toBe('2026-08-18T01:00:00.000Z');
    // sample count, TTFT/completion p50/p95, provider/config provenance, error rate
    expect(report.scenarios[0].sampleCount).toBe(2);
    expect(report.scenarios[0].p50).toHaveProperty('ttftMs');
    expect(report.scenarios[0].p95).toHaveProperty('completeMs');
    expect(report.scenarios[0].errorRate).toBe(0);
    expect(report.provenance.model).toBe('gemini-3.1-pro-preview-customtools');
    expect(report.acceptance.verdict).toBe('accept-under-budget');
  });

  it('covers all four required scenarios', () => {
    expect([...BENCHMARK_SCENARIOS]).toEqual(['catalog-only', 'fallback', 'timeout', 'concurrent']);
  });
});
