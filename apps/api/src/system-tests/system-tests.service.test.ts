import { ConflictException } from '@nestjs/common';
import { SYSTEM_TEST_CONTRACT_VERSION, SYSTEM_TEST_SUITE_MANIFESTS } from '@papercusp/system-test-contract';
import type { StoredSystemTestRunSnapshot, SystemTestRunQueueStore } from '@papercusp/system-test-runner';
import { describe, expect, it, vi } from 'vitest';

import { SystemTestsService } from './system-tests.service';

const SHA = 'a'.repeat(40);
const ACTOR = { id: 'seller-1', role: 'operator' as const };

function previous(state = 'failed', cleanup = 'succeeded'): StoredSystemTestRunSnapshot {
  const now = new Date().toISOString();
  return {
    run: {
      id: 'run-original', idempotencyKey: 'original-key', contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
      suiteId: 'actions', suiteVersion: SYSTEM_TEST_SUITE_MANIFESTS.actions.suiteVersion, profile: 'smoke',
      actor: ACTOR, requestedSha: SHA, eventId: 'fixture-event-1', deployedSha: SHA,
      state: state as StoredSystemTestRunSnapshot['run']['state'], blockedReasons: [], summary: '',
      createdAt: now, updatedAt: now, heartbeatAt: now, startedAt: now, finishedAt: now,
    },
    suite: {
      suiteId: 'actions',
      suiteVersion: SYSTEM_TEST_SUITE_MANIFESTS.actions.suiteVersion,
      profile: 'smoke',
      title: 'Actions',
      manifest: {},
    },
    cases: [], artifacts: [], environments: [], transitions: [], cancellation: null,
    retention: { resultsExpiresAt: now, artifactsExpiresAt: now },
    cleanup: { status: cleanup as StoredSystemTestRunSnapshot['cleanup']['status'], summary: '', attempts: 1, requestedAt: now, startedAt: now, finishedAt: now, updatedAt: now },
  };
}

describe('SystemTestsService retry', () => {
  it('creates a new server-owned run from the exact stored request, including event scope', async () => {
    const store = {
      getRun: vi.fn(async () => previous()),
      createRun: vi.fn(async (input) => input),
    } as unknown as SystemTestRunQueueStore;
    const service = new SystemTestsService(store, () => 'run-retry-1');

    await expect(service.retry('run-original', ACTOR, 'retry-key-1')).resolves.toMatchObject({
      runId: 'run-retry-1',
      idempotencyKey: 'retry-key-1',
      actor: ACTOR,
      request: { suiteId: 'actions', eventId: 'fixture-event-1', requestedSha: SHA },
    });
  });

  it('refuses retry while execution or cleanup is still live', async () => {
    const store = { getRun: vi.fn(async () => previous('running', 'running')), createRun: vi.fn() } as unknown as SystemTestRunQueueStore;
    const service = new SystemTestsService(store, () => 'run-retry-2');

    await expect(service.retry('run-original', ACTOR, 'retry-key-2')).rejects.toBeInstanceOf(ConflictException);
    expect(store.createRun).not.toHaveBeenCalled();
  });
});
