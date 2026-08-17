import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFileLatencyPersistence, CopilotLatencyBudget } from './latency';

describe('CopilotLatencyBudget', () => {
  it('surfaces current TTFT/complete values and nearest-rank p50/p95', () => {
    const budget = new CopilotLatencyBudget();

    budget.record({ ttftMs: 10, completeMs: 100 });
    budget.record({ ttftMs: 30, completeMs: 300 });
    const current = budget.record({ ttftMs: 20, completeMs: 200 });

    expect(current).toEqual({
      ttftMs: 20,
      completeMs: 200,
      sampleCount: 3,
      p50: { ttftMs: 20, completeMs: 200 },
      p95: { ttftMs: 30, completeMs: 300 },
      provider: 'unknown',
      errorRate: 0,
    });
  });

  it('tracks provider provenance and a rolling error rate per sample', () => {
    const budget = new CopilotLatencyBudget();

    budget.record({ ttftMs: 10, completeMs: 100, provider: 'vertex' });
    const errored = budget.record({ ttftMs: 20, completeMs: 200, provider: 'vertex', error: true });
    expect(errored.provider).toBe('vertex');
    expect(errored.errorRate).toBeCloseTo(0.5);

    const fallback = budget.record({ ttftMs: 5, completeMs: 20, provider: 'deterministic' });
    expect(fallback.provider).toBe('deterministic');
    expect(fallback.errorRate).toBeCloseTo(1 / 3);

    const breakdown = budget.providerBreakdown();
    expect(breakdown.vertex.sampleCount).toBe(2);
    expect(breakdown.vertex.errorRate).toBeCloseTo(0.5);
    expect(breakdown.deterministic.sampleCount).toBe(1);
    expect(breakdown.deterministic.errorRate).toBe(0);
  });

  describe('file-backed persistence', () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('survives a process restart by replaying the JSONL history into a fresh budget', () => {
      dir = mkdtempSync(join(tmpdir(), 'copilot-latency-'));
      const path = join(dir, 'history.jsonl');

      const first = new CopilotLatencyBudget(2_000, createFileLatencyPersistence(path));
      first.record({ ttftMs: 10, completeMs: 100, provider: 'vertex' });
      first.record({ ttftMs: 20, completeMs: 200, provider: 'vertex' });
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);

      // Simulates the process dying and a new one starting cold.
      const restarted = new CopilotLatencyBudget(2_000, createFileLatencyPersistence(path));
      expect(restarted.snapshot().sampleCount).toBe(2);
      expect(restarted.snapshot().p50.completeMs).toBe(100);

      const appended = restarted.record({ ttftMs: 30, completeMs: 300, provider: 'vertex' });
      expect(appended.sampleCount).toBe(3);
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3);
    });

    it('drops a truncated trailing line instead of throwing', () => {
      dir = mkdtempSync(join(tmpdir(), 'copilot-latency-'));
      const path = join(dir, 'history.jsonl');
      const persistence = createFileLatencyPersistence(path);
      persistence.append({ ttftMs: 1, completeMs: 10 });
      // Hand-corrupt as if a write was cut off mid-line.
      const raw = readFileSync(path, 'utf8');
      appendFileSync(path, '{"ttftMs":2,"completeM');

      const budget = new CopilotLatencyBudget(2_000, createFileLatencyPersistence(path));
      expect(budget.snapshot().sampleCount).toBe(1);
      expect(raw.trim().length).toBeGreaterThan(0);
    });
  });

  it('keeps TTFT percentiles null until an adapter supplies a TTFT sample', () => {
    const budget = new CopilotLatencyBudget(2);

    budget.record({ ttftMs: null, completeMs: 40 });
    const current = budget.record({ ttftMs: null, completeMs: 60 });

    expect(current.p50.ttftMs).toBeNull();
    expect(current.p95.ttftMs).toBeNull();
    expect(current.p95.completeMs).toBe(60);
    expect(budget.snapshot().sampleCount).toBe(2);
  });

  it('bounds history to the configured sample window', () => {
    const budget = new CopilotLatencyBudget(2);

    budget.record({ ttftMs: 1, completeMs: 10 });
    budget.record({ ttftMs: 2, completeMs: 20 });
    const current = budget.record({ ttftMs: 3, completeMs: 30 });

    expect(current.sampleCount).toBe(2);
    expect(current.p50.completeMs).toBe(20);
    expect(current.p95.completeMs).toBe(30);
  });
});
