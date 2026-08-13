import type { CopilotLatency } from './copilot.types';

export interface LatencySample {
  /** Null means the model adapter did not expose a first-token timestamp. */
  ttftMs: number | null;
  completeMs: number;
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  // Nearest-rank keeps the p95 budget conservative for small live samples.
  const rank = Math.max(1, Math.ceil((percentileValue / 100) * sorted.length));
  return sorted[rank - 1];
}

/**
 * Bounded in-process latency history for one copilot process.
 *
 * The provider adapter can report TTFT while the pipeline measures complete
 * response latency. A bounded ring avoids turning observability into an
 * unbounded request-state store; callers receive p50/p95 after every sample.
 */
export class CopilotLatencyBudget {
  private readonly samples: LatencySample[] = [];

  constructor(private readonly maxSamples = 2_000) {
    if (!Number.isInteger(maxSamples) || maxSamples < 1) {
      throw new Error('maxSamples must be a positive integer');
    }
  }

  record(sample: LatencySample): CopilotLatency {
    const normalized: LatencySample = {
      ttftMs: sample.ttftMs === null ? null : nonNegativeFinite(sample.ttftMs, 0),
      completeMs: nonNegativeFinite(sample.completeMs, 0),
    };
    if (this.samples.length === this.maxSamples) this.samples.shift();
    this.samples.push(normalized);

    const ttftValues = this.samples
      .map((entry) => entry.ttftMs)
      .filter((value): value is number => value !== null);
    const completeValues = this.samples.map((entry) => entry.completeMs);
    return {
      ttftMs: normalized.ttftMs,
      completeMs: normalized.completeMs,
      sampleCount: this.samples.length,
      p50: {
        ttftMs: percentile(ttftValues, 50),
        completeMs: percentile(completeValues, 50),
      },
      p95: {
        ttftMs: percentile(ttftValues, 95),
        completeMs: percentile(completeValues, 95),
      },
    };
  }

  snapshot(): Omit<CopilotLatency, 'ttftMs' | 'completeMs'> {
    const ttftValues = this.samples
      .map((entry) => entry.ttftMs)
      .filter((value): value is number => value !== null);
    const completeValues = this.samples.map((entry) => entry.completeMs);
    return {
      sampleCount: this.samples.length,
      p50: {
        ttftMs: percentile(ttftValues, 50),
        completeMs: percentile(completeValues, 50),
      },
      p95: {
        ttftMs: percentile(ttftValues, 95),
        completeMs: percentile(completeValues, 95),
      },
    };
  }
}
