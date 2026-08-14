import { BadRequestException } from '@nestjs/common';
import { firstValueFrom, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { EventService, InMemoryEventStore } from '../events/event.service';
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
  const ownership = new EventOwnershipGuard(new EventService(
    new InMemoryEventStore([{
      eventId: 'event-1',
      title: 'Event one',
      sellerId: 'seller-1',
      sellerName: 'Seller one',
      status: 'scheduled',
      startsAt: null,
      endedAt: null,
    }]),
    new ChatService(),
  ));
  return {
    controller: new RehearsalController(
      {} as RehearsalService,
      preflights,
      invalidations,
      ownership,
    ),
    invalidations,
    ownership,
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
    const { ownership } = createController();
    new RehearsalSyncQueries(
      preflights as unknown as RehearsalPreflightService,
      queries,
      ownership,
    ).onModuleInit();

    await expect(queries.resolve(
      'rehearsal.preflight',
      { eventId: ' event-1 ' },
      { principal: 'seller-1' },
    )).resolves.toEqual([report]);
    expect(preflights.read).toHaveBeenCalledWith('event-1');
    await expect(queries.resolve(
      'rehearsal.preflight',
      { eventId: 'event-1' },
      { principal: 'seller-other' },
    )).rejects.toThrow('Event not found for this seller.');

    const { controller } = createController(
      new SyncInvalidationService(),
      preflights as unknown as RehearsalPreflightService,
    );
    await expect(controller.preflight('event-1', 'seller-1')).resolves.toEqual(report);
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
      const receipt = await controller.clientRealtime(
        'event-1',
        { nonce: 'probe-nonce-123' },
        'seller-1',
      );
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

  it('refuses an uncorrelatable nonce instead of emitting a global-looking update', async () => {
    const { controller } = createController();
    await expect(controller.clientRealtime('event-1', { nonce: '../bad' }, 'seller-1'))
      .rejects.toThrow(BadRequestException);
  });
});
