import { HttpException, UnauthorizedException } from '@nestjs/common';
import {
  SYSTEM_TEST_CONTRACT_VERSION,
  SYSTEM_TEST_SUITE_MANIFESTS,
  SystemTestContractError,
} from '@papercusp/system-test-contract';
import type { SystemTestRunQueueStore } from '@papercusp/system-test-runner';
import { describe, expect, it, vi } from 'vitest';

import { SystemTestsController } from './system-tests.controller';
import { SystemTestsService } from './system-tests.service';

const SHA = 'a'.repeat(40);
const AUTH = { authorization: 'Bearer seller', 'idempotency-key': 'system-test-key-1' };

function access() {
  return {
    requireSeller: vi.fn(() => ({ sellerId: 'seller-1' })),
    consumeRateLimit: vi.fn(),
    assertPayloadSize: vi.fn(),
    requireIdempotencyKey: vi.fn((value: string) => value),
  };
}

describe('SystemTestsController', () => {
  it('requires seller authorization before a launch can reach the queue', async () => {
    const auth = access();
    auth.requireSeller.mockImplementation(() => { throw new UnauthorizedException(); });
    const service = { launch: vi.fn() };
    const controller = new SystemTestsController(service as never, auth as never);

    await expect(controller.launch({}, {}, '127.0.0.1')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.launch).not.toHaveBeenCalled();
  });

  it('rejects unknown suites and command/path injection before persistence', async () => {
    const store = { createRun: vi.fn() } as unknown as SystemTestRunQueueStore;
    const controller = new SystemTestsController(new SystemTestsService(store), access() as never);

    await expect(controller.launch({
      contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
      suiteId: 'shell',
      suiteVersion: 1,
      profile: 'smoke',
      requestedSha: SHA,
      command: 'node /tmp/attacker.js',
      path: '../../production',
    }, AUTH, '127.0.0.1')).rejects.toMatchObject({ status: 400 });
    expect(store.createRun).not.toHaveBeenCalled();
  });

  it('accepts only the bounded versioned request and server-authenticated actor', async () => {
    const store = { createRun: vi.fn(async (input) => input) } as unknown as SystemTestRunQueueStore;
    const controller = new SystemTestsController(
      new SystemTestsService(store, () => 'run-api-1'),
      access() as never,
    );
    const request = {
      contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
      suiteId: 'actions' as const,
      suiteVersion: SYSTEM_TEST_SUITE_MANIFESTS.actions.suiteVersion,
      profile: 'smoke' as const,
      requestedSha: SHA,
      eventId: 'fixture-event-1',
    };

    await expect(controller.launch(request, AUTH, '127.0.0.1')).resolves.toMatchObject({
      runId: 'run-api-1', actor: { id: 'seller-1', role: 'operator' }, request,
    });
  });

  it('rejects cancellation bodies with extra fields', async () => {
    const controller = new SystemTestsController({ cancel: vi.fn() } as never, access() as never);
    await expect(controller.cancel(
      'run-api-1', { reason: 'Stop.', command: 'rm -rf /' }, AUTH, '127.0.0.1',
    )).rejects.toBeInstanceOf(HttpException);
  });
});
