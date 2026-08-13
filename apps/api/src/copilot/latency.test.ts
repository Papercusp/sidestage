import { describe, expect, it } from 'vitest';

import { CopilotLatencyBudget } from './latency';

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
