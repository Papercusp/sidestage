import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CopilotLatency } from './copilot.types';

export interface LatencySample {
  /** Null means the model adapter did not expose a first-token timestamp. */
  ttftMs: number | null;
  completeMs: number;
  /** Which engine produced the sample ('vertex', 'openai', 'deterministic', ...). Defaults to 'unknown'. */
  provider?: string;
  /** True when the provider leg errored/fell back and this sample reflects the fallback, not the named provider. */
  error?: boolean;
}

type NormalizedSample = Required<LatencySample>;

/**
 * Where a `CopilotLatencyBudget` reads its starting history from and writes
 * every new sample to, so a bounded window can outlive the process that
 * measured it. Opt-in: the pipeline's default budget stays purely in-memory
 * (no disk I/O on the buyer-facing request path); a benchmark or rehearsal
 * that needs a durable, cross-run window supplies one explicitly.
 */
export interface LatencyPersistence {
  /** Most-recent-last history to hydrate a fresh budget from. */
  load(): readonly LatencySample[];
  /** Called once per accepted sample, in record() order. */
  append(sample: LatencySample): void;
}

/**
 * Append-only JSONL file persistence. Loading tolerates a truncated last
 * line (a process killed mid-write) by dropping it rather than throwing —
 * losing the newest not-yet-flushed sample is preferable to refusing to
 * start.
 */
export function createFileLatencyPersistence(path: string): LatencyPersistence {
  return {
    load(): LatencySample[] {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0);
      const samples: LatencySample[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as LatencySample;
          samples.push({
            ttftMs: parsed.ttftMs === null || typeof parsed.ttftMs === 'number' ? parsed.ttftMs : null,
            completeMs: typeof parsed.completeMs === 'number' ? parsed.completeMs : 0,
            provider: parsed.provider,
            error: parsed.error,
          });
        } catch {
          // Truncated/corrupt line (most likely the last one, from a killed
          // process) — skip it, keep the rest of the history.
        }
      }
      return samples;
    },
    append(sample: LatencySample): void {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(sample)}\n`, 'utf8');
    },
  };
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

function errorRateOf(samples: readonly NormalizedSample[]): number {
  if (samples.length === 0) return 0;
  const errored = samples.reduce((sum, entry) => sum + (entry.error ? 1 : 0), 0);
  return errored / samples.length;
}

/**
 * Bounded in-process latency history for one copilot process.
 *
 * The provider adapter can report TTFT while the pipeline measures complete
 * response latency. A bounded ring avoids turning observability into an
 * unbounded request-state store; callers receive p50/p95 after every sample.
 * Each sample also carries which provider produced it and whether that
 * provider's own leg errored/fell back, so a rolling window can distinguish
 * "the real provider is slow" from "the real provider is failing and we are
 * measuring the fallback's latency instead" — and, with a `LatencyPersistence`
 * supplied, the window survives a process restart.
 */
export class CopilotLatencyBudget {
  private readonly samples: NormalizedSample[] = [];

  constructor(
    private readonly maxSamples = 2_000,
    private readonly persistence?: LatencyPersistence,
  ) {
    if (!Number.isInteger(maxSamples) || maxSamples < 1) {
      throw new Error('maxSamples must be a positive integer');
    }
    if (persistence) {
      for (const raw of persistence.load()) {
        if (this.samples.length === maxSamples) this.samples.shift();
        this.samples.push(normalize(raw));
      }
    }
  }

  record(sample: LatencySample): CopilotLatency {
    const normalized = normalize(sample);
    if (this.samples.length === this.maxSamples) this.samples.shift();
    this.samples.push(normalized);
    this.persistence?.append(sample);

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
      provider: normalized.provider,
      errorRate: errorRateOf(this.samples),
    };
  }

  snapshot(): Omit<CopilotLatency, 'ttftMs' | 'completeMs'> {
    const ttftValues = this.samples
      .map((entry) => entry.ttftMs)
      .filter((value): value is number => value !== null);
    const completeValues = this.samples.map((entry) => entry.completeMs);
    const last = this.samples.at(-1);
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
      provider: last?.provider ?? 'unknown',
      errorRate: errorRateOf(this.samples),
    };
  }

  /** Per-provider sample counts + error rate in the current window — the benchmark's per-scenario breakdown. */
  providerBreakdown(): Record<string, { sampleCount: number; errorRate: number; p50CompleteMs: number | null; p95CompleteMs: number | null }> {
    const byProvider = new Map<string, NormalizedSample[]>();
    for (const entry of this.samples) {
      const bucket = byProvider.get(entry.provider) ?? [];
      bucket.push(entry);
      byProvider.set(entry.provider, bucket);
    }
    const result: Record<string, { sampleCount: number; errorRate: number; p50CompleteMs: number | null; p95CompleteMs: number | null }> = {};
    for (const [provider, entries] of byProvider) {
      const completeValues = entries.map((entry) => entry.completeMs);
      result[provider] = {
        sampleCount: entries.length,
        errorRate: errorRateOf(entries),
        p50CompleteMs: percentile(completeValues, 50),
        p95CompleteMs: percentile(completeValues, 95),
      };
    }
    return result;
  }
}

function normalize(sample: LatencySample): NormalizedSample {
  return {
    ttftMs: sample.ttftMs === null ? null : nonNegativeFinite(sample.ttftMs, 0),
    completeMs: nonNegativeFinite(sample.completeMs, 0),
    provider: sample.provider?.trim() || 'unknown',
    error: Boolean(sample.error),
  };
}
