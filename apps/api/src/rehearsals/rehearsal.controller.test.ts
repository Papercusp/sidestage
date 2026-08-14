import { BadRequestException } from '@nestjs/common';
import { firstValueFrom, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { CLIENT_REALTIME_PROBE_EVENT } from './preflight';
import type { RehearsalPreflightService } from './rehearsal-preflight.service';
import { RehearsalController } from './rehearsal.controller';
import { RehearsalSyncQueries } from './rehearsal.module';
import type { RehearsalService } from './rehearsal.service';

function createController(
  invalidations = new SyncInvalidationService(),
  preflights = { read: vi.fn() } as unknown as RehearsalPreflightService,
) {
  return {
    controller: new RehearsalController(
      {} as RehearsalService,
      preflights,
      invalidations,
    ),
    invalidations,
  };
}

describe('Rehearsal preflight sync query', () => {
  it('registers a scoped rehearsal.preflight query and shares the REST service', async () => {
    const report = {
      eventId: 'event-1',
      ranAt: '2026-08-14T16:00:00.000Z',
      ready: true,
      blockers: 0,
      warnings: 0,
      unknowns: 0,
      checks: [],
    };
    const preflights = { read: vi.fn().mockResolvedValue(report) };
    const queries = new SyncQueryRegistry();
    new RehearsalSyncQueries(preflights as unknown as RehearsalPreflightService, queries).onModuleInit();

    await expect(queries.resolve('rehearsal.preflight', { eventId: ' event-1 ' })).resolves.toEqual([report]);
    expect(preflights.read).toHaveBeenCalledWith('event-1');
    await expect(queries.resolve('rehearsal.preflight', {})).resolves.toEqual([]);

    const { controller } = createController(
      new SyncInvalidationService(),
      preflights as unknown as RehearsalPreflightService,
    );
    await expect(controller.preflight('event-1')).resolves.toEqual(report);
    expect(preflights.read).toHaveBeenLastCalledWith('event-1');
  });
});

describe('RehearsalController client probes', () => {
  it('returns the API wall clock measured at request time', () => {
    const { controller } = createController();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_786_690_000_123);
    try {
      expect(controller.clientClock()).toEqual({ serverTimeMs: 1_786_690_000_123 });
    } finally {
      now.mockRestore();
    }
  });

  it('echoes the same timestamped nonce through SyncInvalidationService', async () => {
    const { controller, invalidations } = createController();
    const published = firstValueFrom(invalidations.events().pipe(take(1)));
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_786_690_000_456);
    try {
      const receipt = controller.clientRealtime('event-1', { nonce: 'probe-nonce-123' });
      expect(receipt).toEqual({
        eventId: 'event-1',
        nonce: 'probe-nonce-123',
        serverTimeMs: 1_786_690_000_456,
      });
      await expect(published).resolves.toEqual({
        name: CLIENT_REALTIME_PROBE_EVENT,
        args: receipt,
        tsMs: 1_786_690_000_456,
      });
    } finally {
      now.mockRestore();
    }
  });

  it('refuses an uncorrelatable nonce instead of emitting a global-looking update', () => {
    const { controller } = createController();
    expect(() => controller.clientRealtime('event-1', { nonce: '../bad' }))
      .toThrow(BadRequestException);
  });
});
