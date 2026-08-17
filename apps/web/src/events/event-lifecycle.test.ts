import { describe, expect, it } from 'vitest';
import {
  resolveLifecycleTransition,
  type EventLifecycleAction as ServerLifecycleAction,
  type EventStatus,
} from '../../../api/src/events/event.service';
import {
  instantFromLocalInput,
  lifecycleRefusal,
  lifecycleStatusRefusal,
  type EventLifecycleAction,
  type EventLifecycleStatus,
} from './event-lifecycle';

/**
 * This suite is DIFFERENTIAL, in the same shape as `seller/markdown-guard.test.ts`.
 *
 * It imports the REAL server authority (`resolveLifecycleTransition`) and
 * asserts the client mirror reaches the same verdict — and quotes the same
 * refusal text — for every state the UI can be in. A hand-written expectation
 * table would pass whenever the mirror and the server were wrong in the same
 * way, which is precisely the drift a mirror exists to catch.
 *
 * The lifecycle domain is FINITE (4 statuses x 3 actions x the start-time
 * accept/reject split), so this is exhaustive rather than sampled: there is no
 * transition the UI can compose that this loop does not cover.
 */

const STATUSES: readonly EventLifecycleStatus[] = ['draft', 'scheduled', 'live', 'ended'];
const ACTIONS: readonly EventLifecycleAction[] = ['schedule', 'go-live', 'end'];

/** Both a start time the server accepts and every shape it rejects. */
const START_TIMES: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: 'a valid ISO instant', value: '2026-08-17T15:00:00.000Z' },
  { label: 'a local datetime-local value', value: '2026-08-17T11:00' },
  { label: 'an empty field', value: '' },
  { label: 'a half-typed value', value: '2026-08-' },
  { label: 'an absent field', value: null },
];

/** The lifecycle columns of a stored row, as the resolver reads them. */
function storedState(status: EventLifecycleStatus) {
  return {
    status: status as EventStatus,
    // A non-null `startsAt` on every state the UI can reach: it must not be
    // what makes a transition legal, and pinning it here proves it is not.
    startsAt: status === 'draft' ? null : '2026-08-16T12:00:00.000Z',
    endedAt: status === 'ended' ? '2026-08-16T14:00:00.000Z' : null,
  };
}

describe('client lifecycle mirror vs the server resolver', () => {
  for (const status of STATUSES) {
    for (const action of ACTIONS) {
      for (const { label, value } of START_TIMES) {
        it(`agrees on ${action} from ${status} with ${label}`, () => {
          const server = resolveLifecycleTransition(
            storedState(status),
            action as ServerLifecycleAction,
            { startsAt: value ?? undefined, now: new Date('2026-08-17T13:00:00.000Z') },
          );
          const mirror = lifecycleRefusal(status, action, value);

          // Legality agrees...
          expect(mirror === null).toBe(server.ok);
          // ...and so does the text the seller actually reads.
          if (!server.ok) expect(mirror).toBe(server.reason);
        });
      }
    }
  }
});

describe('lifecycleStatusRefusal', () => {
  it('reports only the refusals the seller cannot fix by filling the form in', () => {
    // An unfilled date field is not a rule worth explaining; a live room that
    // must be ended before it can be rescheduled is.
    expect(lifecycleStatusRefusal('draft', 'schedule')).toBeNull();
    expect(lifecycleStatusRefusal('live', 'schedule')).toBe('End the live event before rescheduling it.');
  });

  it('quotes the server for the end-before-air refusal on every pre-air state', () => {
    const expected = 'Only a live event can be ended. Unpublish it instead to withdraw it before it airs.';
    for (const status of ['draft', 'scheduled'] as const) {
      const server = resolveLifecycleTransition(storedState(status), 'end');
      expect(server.ok).toBe(false);
      expect(lifecycleStatusRefusal(status, 'end')).toBe(server.ok ? null : server.reason);
      expect(lifecycleStatusRefusal(status, 'end')).toBe(expected);
    }
    expect(lifecycleStatusRefusal('live', 'end')).toBeNull();
    expect(lifecycleStatusRefusal('ended', 'end')).toBeNull();
  });
});

describe('instantFromLocalInput', () => {
  it('reads the input as the seller\'s LOCAL wall time, not as UTC', () => {
    // The whole point of the conversion: `2026-08-17T09:30` means 09:30 where
    // the seller is, and only agrees with the naive-UTC reading at UTC+0.
    const iso = instantFromLocalInput('2026-08-17T09:30');
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getTime()).toBe(new Date(2026, 7, 17, 9, 30).getTime());
  });

  it('produces an instant the server accepts', () => {
    const iso = instantFromLocalInput('2026-08-17T09:30');
    const server = resolveLifecycleTransition(storedState('draft'), 'schedule', { startsAt: iso });
    expect(server.ok).toBe(true);
  });

  it('returns null for the values that would throw or schedule an Invalid Date', () => {
    // `new Date('')` is an Invalid Date whose .toISOString() THROWS a
    // RangeError — an empty field is the ordinary state of the control before
    // the seller touches it, so this is the case that must not reach the call.
    expect(instantFromLocalInput('')).toBeNull();
    expect(instantFromLocalInput('   ')).toBeNull();
    expect(instantFromLocalInput('not a date')).toBeNull();
  });

  it('stays as permissive as the server about a partial date, rather than guessing', () => {
    // `2026-08-` is NOT rejected: V8 reads it as 2026-08-01 local, and the
    // server's own `Date.parse` accepts it for the same reason. A stricter
    // client would refuse a start time the API would have stored, which is the
    // one direction a mirror must never diverge in. (A `datetime-local` input
    // cannot emit this — it yields '' or a complete value — so this pins the
    // parity, not a reachable path.)
    const partial = instantFromLocalInput('2026-08-');
    expect(partial).not.toBeNull();
    expect(lifecycleRefusal('draft', 'schedule', '2026-08-')).toBeNull();
    expect(resolveLifecycleTransition(storedState('draft'), 'schedule', { startsAt: '2026-08-' }).ok).toBe(true);
  });
});
