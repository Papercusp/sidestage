import { BadRequestException } from '@nestjs/common';
import { firstValueFrom, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { GuardedActionService } from '../actions/action.service';
import type { EventConfigService } from '../config/event-config.service';
import type { EventPolicyResolver } from '../config/event-policy-resolver';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { CLIENT_REALTIME_PROBE_EVENT } from './preflight';
import { RehearsalController } from './rehearsal.controller';
import type { RehearsalService } from './rehearsal.service';

function createController(invalidations = new SyncInvalidationService()) {
  return {
    controller: new RehearsalController(
      {} as RehearsalService,
      {} as EventConfigService,
      {} as GuardedActionService,
      {} as EventPolicyResolver,
      null,
      invalidations,
    ),
    invalidations,
  };
}

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
