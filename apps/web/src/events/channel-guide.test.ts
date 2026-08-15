import { describe, expect, it } from 'vitest';
import type { GuideEvent } from './api';
import {
  formatEndedLabel,
  formatScheduledStartTime,
  formatStartLabel,
  formatViewers,
  groupGuideEvents,
  rowMetaLabel,
} from './channel-guide';

const NOW = new Date('2026-08-14T12:00:00.000Z');

function event(overrides: Partial<GuideEvent> & Pick<GuideEvent, 'eventId'>): GuideEvent {
  return {
    title: overrides.eventId,
    sellerId: 'seller-x',
    sellerName: 'Seller X',
    status: 'live',
    startsAt: null,
    endedAt: null,
    viewers: 0,
    ...overrides,
  };
}

describe('groupGuideEvents', () => {
  it('orders the groups Live now, Up next, Ended', () => {
    const groups = groupGuideEvents([
      event({ eventId: 'done', status: 'ended' }),
      event({ eventId: 'soon', status: 'scheduled' }),
      event({ eventId: 'now', status: 'live' }),
    ]);

    expect(groups.map((group) => group.id)).toEqual(['live', 'scheduled', 'ended']);
    expect(groups.map((group) => group.label)).toEqual(['Live now', 'Up next', 'Ended']);
  });

  it('drops empty groups rather than rendering a bare heading', () => {
    const groups = groupGuideEvents([event({ eventId: 'now', status: 'live' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('live');
  });

  it('returns nothing at all for an empty directory', () => {
    expect(groupGuideEvents([])).toEqual([]);
  });

  it('preserves the API order within a group instead of re-sorting', () => {
    // The API sorts live rooms by viewer count; re-sorting here would override
    // a decision made where live presence is actually visible.
    const groups = groupGuideEvents([
      event({ eventId: 'busy', status: 'live', viewers: 40 }),
      event({ eventId: 'quiet', status: 'live', viewers: 1 }),
    ]);
    expect(groups[0].events.map((e) => e.eventId)).toEqual(['busy', 'quiet']);
  });
});

describe('formatStartLabel', () => {
  it('counts down in seconds, minutes, hours and days', () => {
    expect(formatStartLabel('2026-08-14T12:00:09.250Z', NOW)).toBe('Starts in 10s');
    expect(formatStartLabel('2026-08-14T12:20:00.000Z', NOW)).toBe('Starts in 20m 0s');
    expect(formatStartLabel('2026-08-14T15:00:00.000Z', NOW)).toBe('Starts in 3h 0m 0s');
    expect(formatStartLabel('2026-08-14T15:30:00.000Z', NOW)).toBe('Starts in 3h 30m 0s');
    expect(formatStartLabel('2026-08-16T12:00:00.000Z', NOW)).toBe('Starts in 2d 0h 0m 0s');
  });

  it('says "Starting now" rather than counting into negative numbers', () => {
    expect(formatStartLabel('2026-08-14T11:59:00.000Z', NOW)).toBe('Starting now');
    expect(formatStartLabel('2026-08-14T09:00:00.000Z', NOW)).toBe('Starting now');
  });

  it('never prints NaN for a missing or unparseable start time', () => {
    expect(formatStartLabel(null, NOW)).toBe('Schedule pending');
    expect(formatStartLabel('not-a-date', NOW)).toBe('Schedule pending');
  });
});

describe('formatScheduledStartTime', () => {
  it('formats the exact scheduled instant with its time zone', () => {
    expect(formatScheduledStartTime('2026-08-14T14:00:00.000Z', 'en-US', 'UTC'))
      .toBe('Aug 14, 2:00 PM UTC');
  });

  it('returns null when there is no exact instant to show', () => {
    expect(formatScheduledStartTime(null, 'en-US', 'UTC')).toBeNull();
    expect(formatScheduledStartTime('not-a-date', 'en-US', 'UTC')).toBeNull();
  });
});

describe('formatEndedLabel', () => {
  it('reports how long ago an event finished', () => {
    expect(formatEndedLabel('2026-08-14T11:30:00.000Z', NOW)).toBe('Ended 30m ago');
    expect(formatEndedLabel('2026-08-14T06:00:00.000Z', NOW)).toBe('Ended 6h ago');
    expect(formatEndedLabel('2026-08-11T12:00:00.000Z', NOW)).toBe('Ended 3d ago');
  });

  it('falls back to a plain replay label with no end time', () => {
    expect(formatEndedLabel(null, NOW)).toBe('Replay');
    expect(formatEndedLabel('nonsense', NOW)).toBe('Replay');
  });
});

describe('formatViewers', () => {
  it('uses the singular at one viewer', () => {
    expect(formatViewers(1)).toBe('1 watching');
    expect(formatViewers(0)).toBe('0 watching');
    expect(formatViewers(12)).toBe('12 watching');
  });

  it('never renders a negative or fractional count', () => {
    expect(formatViewers(-3)).toBe('0 watching');
    expect(formatViewers(2.7)).toBe('2 watching');
    expect(formatViewers(Number.NaN)).toBe('0 watching');
  });
});

describe('rowMetaLabel', () => {
  it('shows viewers for live, a countdown for upcoming, and age for ended', () => {
    expect(rowMetaLabel(event({ eventId: 'a', status: 'live', viewers: 4 }), NOW)).toBe('4 watching');
    expect(
      rowMetaLabel(
        event({ eventId: 'b', status: 'scheduled', startsAt: '2026-08-14T14:00:00.000Z' }),
        NOW,
      ),
    ).toBe('Starts in 2h 0m 0s');
    expect(
      rowMetaLabel(event({ eventId: 'c', status: 'ended', endedAt: '2026-08-14T10:00:00.000Z' }), NOW),
    ).toBe('Ended 2h ago');
  });
});
