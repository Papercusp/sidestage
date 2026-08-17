import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import {
  EventActivationSweeper,
  eventActivationSweepIntervalMs,
  DEFAULT_EVENT_ACTIVATION_SWEEP_INTERVAL_MS,
} from './event-activation.sweeper';
import {
  EventService,
  InMemoryEventStore,
  isEventLifecycleAction,
  resolveLifecycleTransition,
  type EventLifecycleState,
  type EventRecord,
  type EventStatus,
} from './event.service';

const NOW = new Date('2026-08-17T12:00:00.000Z');
const SELLER = 'seller-avi';

function state(
  status: EventStatus,
  startsAt: string | null = null,
  endedAt: string | null = null,
): EventLifecycleState {
  return { status, startsAt, endedAt };
}

function record(overrides: Partial<EventRecord> & Pick<EventRecord, 'eventId'>): EventRecord {
  return {
    title: overrides.eventId,
    sellerId: SELLER,
    sellerName: 'Avi',
    status: 'draft',
    startsAt: null,
    endedAt: null,
    ...overrides,
  };
}

/* ── The legality table (D-002) ────────────────────────────────────────────── */

describe('resolveLifecycleTransition', () => {
  it('accepts every action name the API exposes, and nothing else', () => {
    expect(isEventLifecycleAction('schedule')).toBe(true);
    expect(isEventLifecycleAction('go-live')).toBe(true);
    expect(isEventLifecycleAction('end')).toBe(true);
    expect(isEventLifecycleAction('unpublish')).toBe(false);
    expect(isEventLifecycleAction('live')).toBe(false);
    expect(isEventLifecycleAction(undefined)).toBe(false);
  });

  describe('schedule', () => {
    it('sets the start time and clears a previous run\'s end time', () => {
      for (const from of ['draft', 'scheduled', 'ended'] as const) {
        const outcome = resolveLifecycleTransition(
          state(from, null, '2026-08-16T00:00:00.000Z'),
          'schedule',
          { startsAt: '2026-08-18T18:30:00.000Z', now: NOW },
        );
        expect(outcome).toEqual({
          ok: true,
          next: { status: 'scheduled', startsAt: '2026-08-18T18:30:00.000Z', endedAt: null },
        });
      }
    });

    it('normalizes any parseable instant to ISO-8601 UTC', () => {
      const outcome = resolveLifecycleTransition(state('draft'), 'schedule', {
        startsAt: '  2026-08-18T18:30:00Z  ',
        now: NOW,
      });
      expect(outcome).toMatchObject({ ok: true, next: { startsAt: '2026-08-18T18:30:00.000Z' } });
    });

    it('refuses without a usable start time, rather than scheduling for never', () => {
      for (const startsAt of [undefined, null, '', 'next tuesday', 42]) {
        expect(resolveLifecycleTransition(state('draft'), 'schedule', { startsAt, now: NOW }))
          .toEqual({ ok: false, reason: expect.stringContaining('ISO-8601') });
      }
    });

    it('refuses to move the clock under a room that is already on air', () => {
      expect(resolveLifecycleTransition(state('live', NOW.toISOString()), 'schedule', {
        startsAt: '2026-08-18T18:30:00.000Z',
        now: NOW,
      })).toEqual({ ok: false, reason: 'End the live event before rescheduling it.' });
    });

    it('allows a PAST start time, which the activation sweep reads as "start it now"', () => {
      expect(resolveLifecycleTransition(state('draft'), 'schedule', {
        startsAt: '2026-08-17T11:00:00.000Z',
        now: NOW,
      })).toMatchObject({ ok: true, next: { status: 'scheduled' } });
    });
  });

  describe('go-live', () => {
    it('honours an already-scheduled start time so the room clock matches the countdown', () => {
      const scheduled = '2026-08-17T11:59:00.000Z';
      expect(resolveLifecycleTransition(state('scheduled', scheduled), 'go-live', { now: NOW }))
        .toEqual({ ok: true, next: { status: 'live', startsAt: scheduled, endedAt: null } });
    });

    it('stamps a start time when going live from an unscheduled draft', () => {
      expect(resolveLifecycleTransition(state('draft'), 'go-live', { now: NOW }))
        .toEqual({ ok: true, next: { status: 'live', startsAt: NOW.toISOString(), endedAt: null } });
    });

    it('restamps and un-ends a re-run, so a reopened room is not reported as hours old', () => {
      expect(resolveLifecycleTransition(
        state('ended', '2026-08-16T09:00:00.000Z', '2026-08-16T10:00:00.000Z'),
        'go-live',
        { now: NOW },
      )).toEqual({ ok: true, next: { status: 'live', startsAt: NOW.toISOString(), endedAt: null } });
    });

    it('is idempotent on a live room, and does NOT restamp its start time', () => {
      const startedEarlier = '2026-08-17T09:00:00.000Z';
      expect(resolveLifecycleTransition(state('live', startedEarlier), 'go-live', { now: NOW }))
        .toEqual({ ok: true, next: { status: 'live', startsAt: startedEarlier, endedAt: null } });
    });
  });

  describe('end', () => {
    it('stamps the end time on a live room', () => {
      const started = '2026-08-17T09:00:00.000Z';
      expect(resolveLifecycleTransition(state('live', started), 'end', { now: NOW }))
        .toEqual({ ok: true, next: { status: 'ended', startsAt: started, endedAt: NOW.toISOString() } });
    });

    it('is idempotent on an ended room, preserving the original end time', () => {
      const ended = state('ended', '2026-08-16T09:00:00.000Z', '2026-08-16T10:00:00.000Z');
      expect(resolveLifecycleTransition(ended, 'end', { now: NOW })).toEqual({ ok: true, next: ended });
    });

    it('refuses on a room that never aired, and points at unpublish instead', () => {
      for (const from of ['draft', 'scheduled'] as const) {
        expect(resolveLifecycleTransition(state(from), 'end', { now: NOW }))
          .toEqual({ ok: false, reason: expect.stringContaining('Unpublish it instead') });
      }
    });
  });
});

/* ── The service seam: three distinguishable outcomes ──────────────────────── */

describe('EventService.transition', () => {
  const serviceWith = (records: EventRecord[]) => {
    const store = new InMemoryEventStore(records);
    return { store, service: new EventService(store, new ChatService()) };
  };

  it('applies a legal transition and returns the stored row', async () => {
    const { service } = serviceWith([record({ eventId: 'avi-real-test', status: 'scheduled' })]);
    const result = await service.transition('avi-real-test', SELLER, 'go-live', { now: NOW });
    expect(result).toEqual({
      outcome: 'applied',
      event: expect.objectContaining({
        eventId: 'avi-real-test',
        status: 'live',
        startsAt: NOW.toISOString(),
        endedAt: null,
      }),
    });
    // Read back through the directory, so this asserts persistence rather than
    // just the value the call happened to return.
    await expect(service.findOwned('avi-real-test', SELLER))
      .resolves.toMatchObject({ status: 'live' });
  });

  it('collapses another seller\'s event and an absent one into the same not-found', async () => {
    const { service } = serviceWith([record({ eventId: 'someone-elses', sellerId: 'seller-other' })]);
    await expect(service.transition('someone-elses', SELLER, 'go-live', { now: NOW }))
      .resolves.toEqual({ outcome: 'not-found' });
    await expect(service.transition('no-such-event', SELLER, 'go-live', { now: NOW }))
      .resolves.toEqual({ outcome: 'not-found' });
  });

  it('reports a refusal with the reason, and leaves the row untouched', async () => {
    const { service } = serviceWith([record({ eventId: 'not-yet', status: 'scheduled' })]);
    const result = await service.transition('not-yet', SELLER, 'end', { now: NOW });
    expect(result).toMatchObject({ outcome: 'refused' });
    await expect(service.findOwned('not-yet', SELLER)).resolves.toMatchObject({
      status: 'scheduled',
      endedAt: null,
    });
  });

  it('trims the ids it is given rather than missing an owned event over whitespace', async () => {
    const { service } = serviceWith([record({ eventId: 'avi-real-test', status: 'draft' })]);
    await expect(service.transition('  avi-real-test  ', `  ${SELLER}  `, 'go-live', { now: NOW }))
      .resolves.toMatchObject({ outcome: 'applied' });
  });
});

/* ── Auto-go-live (D-003) ─────────────────────────────────────────────────── */

describe('scheduled events go live on their own', () => {
  const due = '2026-08-17T11:59:00.000Z';
  const notDue = '2026-08-17T12:01:00.000Z';

  it('activates only scheduled events whose start time has passed', async () => {
    const store = new InMemoryEventStore([
      record({ eventId: 'due', status: 'scheduled', startsAt: due }),
      record({ eventId: 'not-due', status: 'scheduled', startsAt: notDue }),
      record({ eventId: 'no-start-time', status: 'scheduled', startsAt: null }),
      record({ eventId: 'still-draft', status: 'draft', startsAt: due }),
      record({ eventId: 'already-ended', status: 'ended', startsAt: due, endedAt: due }),
    ]);
    const service = new EventService(store, new ChatService());

    const activated = await service.activateDueScheduled(NOW);

    expect(activated.map((event) => event.eventId)).toEqual(['due']);
    await expect(service.findOwned('due', SELLER)).resolves.toMatchObject({ status: 'live' });
    // A draft is UNPUBLISHED: a start time on it is not a promise to any buyer,
    // so the sweep must not publish it as a side effect.
    await expect(service.findOwned('still-draft', SELLER)).resolves.toMatchObject({ status: 'draft' });
    await expect(service.findOwned('not-due', SELLER)).resolves.toMatchObject({ status: 'scheduled' });
    await expect(service.findOwned('no-start-time', SELLER)).resolves.toMatchObject({ status: 'scheduled' });
    await expect(service.findOwned('already-ended', SELLER)).resolves.toMatchObject({ status: 'ended' });
  });

  it('reports each newly-live event exactly once, so a re-sweep re-notifies nobody', async () => {
    const store = new InMemoryEventStore([
      record({ eventId: 'due', status: 'scheduled', startsAt: due }),
    ]);
    const service = new EventService(store, new ChatService());

    expect((await service.activateDueScheduled(NOW)).map((event) => event.eventId)).toEqual(['due']);
    expect(await service.activateDueScheduled(NOW)).toEqual([]);
  });

  it('invalidates the guide, the seller directory and the event lineup for what moved', async () => {
    const service = new EventService(
      new InMemoryEventStore([record({ eventId: 'due', status: 'scheduled', startsAt: due })]),
      new ChatService(),
    );
    const invalidations = new SyncInvalidationService();
    const seen: { name: string; args?: Record<string, unknown>; principal?: string }[] = [];
    invalidations.events().subscribe((event) => seen.push({
      name: event.name,
      ...(event.args ? { args: event.args } : {}),
      ...(event.principal ? { principal: event.principal } : {}),
    }));

    const sweeper = new EventActivationSweeper(service, invalidations, 60_000);
    await sweeper.sweep(NOW);

    expect(seen).toEqual(expect.arrayContaining([
      { name: 'event.lineup.items', args: { eventId: 'due' } },
      { name: 'events.mine', principal: SELLER },
      { name: 'events.guide' },
    ]));
  });

  it('emits nothing at all when no event was due', async () => {
    const service = new EventService(
      new InMemoryEventStore([record({ eventId: 'not-due', status: 'scheduled', startsAt: notDue })]),
      new ChatService(),
    );
    const invalidations = new SyncInvalidationService();
    const seen: string[] = [];
    invalidations.events().subscribe((event) => seen.push(event.name));

    await new EventActivationSweeper(service, invalidations, 60_000).sweep(NOW);

    expect(seen).toEqual([]);
  });

  it('survives a store failure instead of taking the process down', async () => {
    const service = new EventService(
      new InMemoryEventStore([]),
      new ChatService(),
    );
    vi.spyOn(service, 'activateDueScheduled').mockRejectedValue(new Error('connection terminated'));
    const sweeper = new EventActivationSweeper(service, new SyncInvalidationService(), 60_000);

    await expect(sweeper.sweep(NOW)).resolves.toEqual([]);
  });

  it('never holds a process alive, and stops cleanly on module destroy', () => {
    const service = new EventService(new InMemoryEventStore([]), new ChatService());
    const sweeper = new EventActivationSweeper(service, new SyncInvalidationService(), 60_000);

    sweeper.onModuleInit();
    // Registering an interval that keeps the event loop referenced is how a
    // sweeper wedges `vitest` and a graceful shutdown alike.
    sweeper.onModuleDestroy();
    expect(() => sweeper.onModuleDestroy()).not.toThrow();
  });

  it('falls back to the default interval for a missing or nonsensical override', () => {
    expect(eventActivationSweepIntervalMs(undefined)).toBe(DEFAULT_EVENT_ACTIVATION_SWEEP_INTERVAL_MS);
    expect(eventActivationSweepIntervalMs('')).toBe(DEFAULT_EVENT_ACTIVATION_SWEEP_INTERVAL_MS);
    expect(eventActivationSweepIntervalMs('not-a-number')).toBe(DEFAULT_EVENT_ACTIVATION_SWEEP_INTERVAL_MS);
    expect(eventActivationSweepIntervalMs('10')).toBe(DEFAULT_EVENT_ACTIVATION_SWEEP_INTERVAL_MS);
    expect(eventActivationSweepIntervalMs('30000')).toBe(30_000);
  });
});
