import {
  SYSTEM_TEST_CONTRACT_VERSION,
  SYSTEM_TEST_SUITE_MANIFESTS,
  type SystemTestRunState,
} from '@papercusp/system-test-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StoredSystemTestRunSnapshot, SystemTestRunQueueStore } from './postgres-run-store';
import { SystemTestQueueWorker, SystemTestRetryableError } from './queue-worker';

const SHA = 'a'.repeat(40);

function snapshot(state: SystemTestRunState = 'provisioning'): StoredSystemTestRunSnapshot {
  const manifest = SYSTEM_TEST_SUITE_MANIFESTS.actions;
  return {
    run: {
      id: 'run-worker-1', idempotencyKey: 'worker-launch-1', contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
      suiteId: 'actions', suiteVersion: manifest.suiteVersion, profile: 'smoke',
      actor: { id: 'seller-1', role: 'operator' }, requestedSha: SHA, eventId: 'event-1',
      deployedSha: null, state, blockedReasons: [], summary: '', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    },
    suite: { suiteId: 'actions', suiteVersion: 1, profile: 'smoke', title: manifest.title, manifest: { ...manifest } },
    cases: [], artifacts: [], environments: [], transitions: [], cancellation: null,
    retention: { resultsExpiresAt: new Date().toISOString(), artifactsExpiresAt: new Date().toISOString() },
    cleanup: { status: 'not-started', summary: '', attempts: 0, requestedAt: null, startedAt: null, finishedAt: null, updatedAt: new Date().toISOString() },
  };
}

function fakeStore(initial = snapshot()) {
  let current = structuredClone(initial);
  const store = {
    claimNextRun: vi.fn(async () => current),
    getRun: vi.fn(async () => current),
    heartbeat: vi.fn(async () => undefined),
    advanceRun: vi.fn(async (_runId: string, state: SystemTestRunState, options?: { reason?: string }) => {
      current.run.state = state;
      current.run.summary = options?.reason ?? current.run.summary;
      return current;
    }),
    acknowledgeCancellation: vi.fn(async () => {
      current.run.state = 'cancelled';
      if (current.cancellation) current.cancellation.acknowledgedAt = new Date().toISOString();
      return current;
    }),
  };
  return { store: store as unknown as SystemTestRunQueueStore, spies: store, get: () => current };
}

afterEach(() => vi.useRealTimers());

describe('SystemTestQueueWorker', () => {
  it('dispatches only through the server-owned suite registry and blocks an uninstalled executor', async () => {
    const { store, spies } = fakeStore();
    const worker = new SystemTestQueueWorker(store, {});

    const result = await worker.runNext();

    expect(result?.run.state).toBe('blocked');
    expect(spies.advanceRun).toHaveBeenCalledWith('run-worker-1', 'blocked', expect.objectContaining({
      reason: expect.stringContaining('No trusted executor is installed'),
    }));
  });

  it('retries only an explicitly retryable worker error and caps attempts', async () => {
    const { store, spies } = fakeStore();
    const execute = vi.fn(async ({ reporter }: Parameters<NonNullable<ConstructorParameters<typeof SystemTestQueueWorker>[1]['actions']>>[0]) => {
      if (execute.mock.calls.length === 1) throw new SystemTestRetryableError('temporary container pull failure');
      await reporter.advanceRun('run-worker-1', 'blocked', { reason: 'Prerequisite still unavailable.' });
    });
    const worker = new SystemTestQueueWorker(store, { actions: execute }, { maxAttempts: 2 });

    const result = await worker.runNext();

    expect(result?.run.state).toBe('blocked');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(spies.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('aborts an over-budget executor and records timed-out instead of green', async () => {
    vi.useFakeTimers();
    const { store, spies } = fakeStore();
    const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const worker = new SystemTestQueueWorker(store, { actions: execute }, { heartbeatIntervalMs: 60_000 });

    const pending = worker.runNext();
    await vi.advanceTimersByTimeAsync(SYSTEM_TEST_SUITE_MANIFESTS.actions.budget.timeoutMs + 1);
    const result = await pending;

    expect(result?.run.state).toBe('timed-out');
    expect(spies.advanceRun).toHaveBeenCalledWith('run-worker-1', 'timed-out', expect.any(Object));
  });

  it('observes durable cancellation, aborts the executor, and acknowledges it', async () => {
    vi.useFakeTimers();
    const { store, spies, get } = fakeStore();
    const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    spies.getRun.mockImplementation(async () => {
      const current = get();
      current.cancellation = {
        requestedBy: { id: 'seller-1', role: 'operator' }, reason: 'Stop.',
        requestedAt: new Date().toISOString(), acknowledgedAt: null,
      };
      return current;
    });
    const worker = new SystemTestQueueWorker(store, { actions: execute }, { heartbeatIntervalMs: 5 });

    const pending = worker.runNext();
    await vi.advanceTimersByTimeAsync(6);
    const result = await pending;

    expect(result?.run.state).toBe('cancelled');
    expect(spies.acknowledgeCancellation).toHaveBeenCalledWith('run-worker-1', expect.any(Date));
  });
});
