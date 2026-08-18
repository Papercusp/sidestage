// SPDX-License-Identifier: MIT
import type { CopilotLatencyBudget } from './latency';

/**
 * Production-like benchmark surface for the grounded copilot.
 *
 * This module is deliberately PURE: it owns scenario naming, report assembly
 * and the acceptance ruling, and it never opens a socket. The real-provider
 * driver lives in apps/api/scripts/copilot-latency-benchmark.ts, which is not
 * matched by any vitest project — a suite that hits a paid provider on every
 * CI run is a bill, not a gate. Everything worth asserting is therefore
 * assertable here, without credentials.
 *
 * Percentiles are NOT recomputed here. CopilotLatencyBudget already owns the
 * nearest-rank p50/p95, the provider breakdown and the error rate, so a second
 * implementation would only create a way for the two to disagree.
 */

export const BENCHMARK_SCENARIOS = ['catalog-only', 'fallback', 'timeout', 'concurrent'] as const;

export type BenchmarkScenarioName = (typeof BENCHMARK_SCENARIOS)[number];

/**
 * The acceptance bar from the work item: complete-response p95 below 2,000 ms.
 */
export const DEFAULT_COMPLETE_P95_BUDGET_MS = 2_000;

/**
 * Scenarios whose latency describes a normal buyer-facing turn.
 *
 * `timeout` is excluded on purpose: it exists to force the degradation path,
 * so folding its deliberately-induced deadline into the headline p95 would
 * measure the harness rather than the product.
 */
export const LATENCY_BEARING_SCENARIOS: readonly BenchmarkScenarioName[] = [
  'catalog-only',
  'fallback',
  'concurrent',
];

export interface BenchmarkProvenance {
  /** Adapter engine actually exercised, e.g. 'vertex'. */
  provider: string;
  /** Concrete model id, so a number can be re-read against the model that produced it. */
  model: string;
  /** Where the run happened — a p95 from a laptop is not a p95 from the box. */
  host: string;
  /** Real calls per scenario. Small on purpose: this costs money per sample. */
  samplesPerScenario: number;
  commit?: string;
  notes?: string;
}

export interface ScenarioResult {
  scenario: BenchmarkScenarioName;
  sampleCount: number;
  p50: { ttftMs: number | null; completeMs: number | null };
  p95: { ttftMs: number | null; completeMs: number | null };
  errorRate: number;
  providerBreakdown: Record<
    string,
    { sampleCount: number; errorRate: number; p50CompleteMs: number | null; p95CompleteMs: number | null }
  >;
  /** True when every turn returned a response object instead of throwing. */
  allTurnsAnswered: boolean;
  /** Degradation reasons the pipeline reported, e.g. 'deadline-exceeded'. */
  degradedReasons: string[];
  notes?: string;
}

export type AcceptanceVerdict =
  | 'accept-under-budget'
  | 'accept-red-gate-safe-degradation'
  | 'reject-unsafe-over-budget'
  | 'insufficient-data';

export interface AcceptanceRuling {
  budgetMs: number;
  observedP95CompleteMs: number | null;
  p95UnderBudget: boolean;
  safeDegradationProven: boolean;
  /** The release gate's colour implied by this run. */
  gate: 'green' | 'red';
  verdict: AcceptanceVerdict;
  reason: string;
}

export interface BenchmarkReport {
  generatedAt: string;
  provenance: BenchmarkProvenance;
  scenarios: ScenarioResult[];
  acceptance: AcceptanceRuling;
}

export interface ScenarioObservations {
  allTurnsAnswered: boolean;
  degradedReasons?: readonly string[];
  notes?: string;
}

/**
 * Fold one scenario's latency budget into a reportable result.
 */
export function summarizeScenario(
  scenario: BenchmarkScenarioName,
  budget: CopilotLatencyBudget,
  observations: ScenarioObservations,
): ScenarioResult {
  const snapshot = budget.snapshot();
  return {
    scenario,
    sampleCount: snapshot.sampleCount,
    p50: snapshot.p50,
    p95: snapshot.p95,
    errorRate: snapshot.errorRate,
    providerBreakdown: budget.providerBreakdown(),
    allTurnsAnswered: observations.allTurnsAnswered,
    degradedReasons: [...new Set(observations.degradedReasons ?? [])].sort(),
    ...(observations.notes ? { notes: observations.notes } : {}),
  };
}

/**
 * Rule on the work item's acceptance clause.
 *
 * The clause is a DISJUNCTION, not a single bar: "complete-response p95 is
 * below 2,000 ms; otherwise the gate remains red and the product safely times
 * out/falls back." A slow provider is therefore not automatically a failure —
 * it is a red gate the product is required to survive. What would be a real
 * failure is being over budget AND unable to degrade safely, so that is the
 * only branch that rejects.
 */
export function evaluateAcceptance(
  scenarios: readonly ScenarioResult[],
  budgetMs: number = DEFAULT_COMPLETE_P95_BUDGET_MS,
): AcceptanceRuling {
  const latencyBearing = scenarios.filter((entry) => LATENCY_BEARING_SCENARIOS.includes(entry.scenario));
  const observed = latencyBearing
    .map((entry) => entry.p95.completeMs)
    .filter((value): value is number => value !== null);

  if (observed.length === 0) {
    return {
      budgetMs,
      observedP95CompleteMs: null,
      p95UnderBudget: false,
      safeDegradationProven: false,
      gate: 'red',
      verdict: 'insufficient-data',
      reason: 'No latency-bearing scenario produced a complete-response sample, so the budget was never measured.',
    };
  }

  // The worst latency-bearing p95 is the honest headline: a buyer who hits the
  // slow path is not comforted by a fast average across the other paths.
  const observedP95CompleteMs = Math.max(...observed);
  const p95UnderBudget = observedP95CompleteMs < budgetMs;

  const timeout = scenarios.find((entry) => entry.scenario === 'timeout');
  // "Safely times out/falls back" is only proven by a scenario that actually
  // induced the deadline AND still answered every turn. A run where nothing
  // timed out has not demonstrated the fallback, however green it looks.
  const safeDegradationProven = Boolean(
    timeout
    && timeout.sampleCount > 0
    && timeout.allTurnsAnswered
    && timeout.degradedReasons.includes('deadline-exceeded'),
  );

  if (p95UnderBudget) {
    return {
      budgetMs,
      observedP95CompleteMs,
      p95UnderBudget: true,
      safeDegradationProven,
      gate: 'green',
      verdict: 'accept-under-budget',
      reason: `Worst latency-bearing complete-response p95 ${observedP95CompleteMs}ms is under the ${budgetMs}ms budget.`,
    };
  }

  if (safeDegradationProven) {
    return {
      budgetMs,
      observedP95CompleteMs,
      p95UnderBudget: false,
      safeDegradationProven: true,
      gate: 'red',
      verdict: 'accept-red-gate-safe-degradation',
      reason:
        `Complete-response p95 ${observedP95CompleteMs}ms exceeds the ${budgetMs}ms budget, so the gate stays red. `
        + 'The product degrades safely: the timeout scenario induced deadline-exceeded and still answered every turn.',
    };
  }

  return {
    budgetMs,
    observedP95CompleteMs,
    p95UnderBudget: false,
    safeDegradationProven: false,
    gate: 'red',
    verdict: 'reject-unsafe-over-budget',
    reason:
      `Complete-response p95 ${observedP95CompleteMs}ms exceeds the ${budgetMs}ms budget AND safe degradation was not `
      + 'demonstrated (the timeout scenario did not both induce deadline-exceeded and answer every turn).',
  };
}

export function buildReport(
  scenarios: readonly ScenarioResult[],
  provenance: BenchmarkProvenance,
  options: { budgetMs?: number; now?: () => Date } = {},
): BenchmarkReport {
  const now = options.now ?? (() => new Date());
  return {
    generatedAt: now().toISOString(),
    provenance,
    scenarios: [...scenarios],
    acceptance: evaluateAcceptance(scenarios, options.budgetMs ?? DEFAULT_COMPLETE_P95_BUDGET_MS),
  };
}
