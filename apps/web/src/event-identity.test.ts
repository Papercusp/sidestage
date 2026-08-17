import { describe, expect, it } from 'vitest';
import {
  browserEventId,
  chatEventId,
  DEFAULT_EVENT_ID,
  resolveActiveEventId,
  urlEventId,
} from './event-identity';

/** A guide row, reduced to the one field the resolver reads. */
const row = (eventId: string) => ({ eventId });

describe('urlEventId', () => {
  it('reports the room the URL names, and null when it names none', () => {
    expect(urlEventId('?event=avi-real-test')).toBe('avi-real-test');
    expect(urlEventId('?tab=buyer&event=midnight-sneaker-vault')).toBe('midnight-sneaker-vault');
    expect(urlEventId('')).toBeNull();
    expect(urlEventId('?tab=buyer')).toBeNull();
    expect(urlEventId('?event=')).toBeNull();
  });

  it('normalizes case and whitespace, and rejects ids outside the room grammar', () => {
    expect(urlEventId('?event=%20Avi-Real-Test%20')).toBe('avi-real-test');
    expect(urlEventId('?event=not a room')).toBeNull();
    expect(urlEventId('?event=-leading-dash')).toBeNull();
    expect(urlEventId(`?event=${'a'.repeat(65)}`)).toBeNull();
  });

  it('does NOT manufacture a default, which is what separates it from browserEventId', () => {
    expect(urlEventId('?tab=buyer')).toBeNull();
    expect(browserEventId('?tab=buyer')).toBe(DEFAULT_EVENT_ID);
    expect(browserEventId('?event=avi-real-test')).toBe('avi-real-test');
    expect(chatEventId('')).toBe(DEFAULT_EVENT_ID);
  });
});

describe('resolveActiveEventId', () => {
  it('honours an explicit choice over everything else', () => {
    expect(resolveActiveEventId('picked-room', [row('first-row'), row('second-row')]))
      .toBe('picked-room');
    // A pin the directory does not list still wins: a share link must keep
    // resolving even for a room that has since ended and left the guide.
    expect(resolveActiveEventId('picked-room', [])).toBe('picked-room');
  });

  it('follows the guide\'s FIRST row when the URL pins nothing', () => {
    expect(resolveActiveEventId(null, [row('first-row'), row('second-row')])).toBe('first-row');
  });

  /**
   * The recurrence guard for the reported defect (D-001).
   *
   * Production's directory contains exactly one row and it is NOT
   * `sunday-drop`, yet the homepage opened `sunday-drop` — a room the Channel
   * Guide could not even list — while the guide's own top row sat unopened.
   * Stated as a property rather than against one fixture id: for ANY nonempty
   * guide, the landing room is that guide's first row, so no constant can
   * outrank the directory again.
   */
  it('never lands on the seed while the guide has any row at all', () => {
    const productionLikeGuide = [row('avi-real-test')];
    expect(resolveActiveEventId(null, productionLikeGuide)).toBe('avi-real-test');
    expect(resolveActiveEventId(null, productionLikeGuide)).not.toBe(DEFAULT_EVENT_ID);

    for (const guide of [
      [row('only-row')],
      [row('live-room'), row('scheduled-room')],
      [row(DEFAULT_EVENT_ID), row('other-room')],
      [row('other-room'), row(DEFAULT_EVENT_ID)],
    ]) {
      expect(resolveActiveEventId(null, guide)).toBe(guide[0].eventId);
    }
  });

  it('falls back to the seed only before the directory has produced a row', () => {
    expect(resolveActiveEventId(null, [])).toBe(DEFAULT_EVENT_ID);
  });
});
