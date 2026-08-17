import { describe, expect, it } from 'vitest';

import {
  isLostConnectionState,
  isPublisherNotReady,
  publisherRetryDelayMs,
  PUBLISHER_ABSENT_MESSAGE,
  PUBLISHER_NOT_READY_STATUS,
  PUBLISHER_RETRY_DELAYS_MS,
  WAITING_FOR_PUBLISHER_MESSAGE,
} from './buyer-stream-recovery';
import { MediaTransportError } from './streaming';

/**
 * Recurrence guards for WI-39733.
 *
 * The bug: MediaMTX answers WHEP with 404 while a path has no publisher, and
 * the buyer's auto-connect treated that as a terminal error, so a buyer who was
 * already in the room when the seller went live sat on a black pane until they
 * reloaded. The whole fix rests on one distinction — a 404 is a NOT-YET and
 * everything else is a fault — so that distinction is what these tests pin.
 *
 * Each block below states the failure it is meant to catch, because a guard
 * whose purpose is not written down gets "simplified" back into the bug.
 */
describe('isPublisherNotReady', () => {
  it('treats a transport 404 as "the seller has not started publishing yet"', () => {
    expect(isPublisherNotReady(new MediaTransportError('whep', 404))).toBe(true);
    // The constant and the behaviour must not drift apart.
    expect(isPublisherNotReady(new MediaTransportError('whep', PUBLISHER_NOT_READY_STATUS))).toBe(true);
  });

  /**
   * The regression that would silently re-break the buyer in the OTHER
   * direction: widening this predicate (e.g. to "any transport error") would
   * make genuine faults retry invisibly for ~96s behind a "connecting" spinner
   * instead of surfacing an error with a Retry button.
   */
  it('does not treat any other transport failure as a missing publisher', () => {
    for (const status of [400, 401, 403, 405, 410, 429, 500, 502, 503]) {
      expect(isPublisherNotReady(new MediaTransportError('whep', status))).toBe(false);
    }
    // A transport error with no status at all is still a fault, not a not-yet.
    expect(isPublisherNotReady(new MediaTransportError('whep'))).toBe(false);
  });

  /**
   * A plain Error with a 404-ish message must NOT qualify: the type carries the
   * meaning, not the text. This is what keeps an unrelated failure whose
   * message happens to mention 404 from being retried as a missing publisher.
   */
  it('requires a MediaTransportError, not merely something that mentions 404', () => {
    expect(isPublisherNotReady(new Error('Media server rejected the WHEP offer (404).'))).toBe(false);
    expect(isPublisherNotReady({ status: 404 })).toBe(false);
    expect(isPublisherNotReady('404')).toBe(false);
    expect(isPublisherNotReady(404)).toBe(false);
    expect(isPublisherNotReady(null)).toBe(false);
    expect(isPublisherNotReady(undefined)).toBe(false);
  });
});

describe('publisherRetryDelayMs', () => {
  it('walks the schedule in order, one delay per prior failure', () => {
    PUBLISHER_RETRY_DELAYS_MS.forEach((expected, attempt) => {
      expect(publisherRetryDelayMs(attempt)).toBe(expected);
    });
  });

  /**
   * The bound is the load-bearing property, not a detail. `End event` leaves
   * rooms permanently `live` (WI-39737), so an unbounded wait would have every
   * buyer who opens a dead room re-offering against MediaMTX for as long as the
   * tab stays open. `null` is what stops it and surfaces the terminal message.
   */
  it('ends the wait rather than retrying forever', () => {
    expect(publisherRetryDelayMs(PUBLISHER_RETRY_DELAYS_MS.length)).toBeNull();
    expect(publisherRetryDelayMs(PUBLISHER_RETRY_DELAYS_MS.length + 1)).toBeNull();
    expect(publisherRetryDelayMs(999)).toBeNull();
  });

  it('starts fast and never shrinks, so a one-camera-prompt gap closes quickly', () => {
    expect(PUBLISHER_RETRY_DELAYS_MS[0]).toBeLessThanOrEqual(1_000);
    const monotonic = PUBLISHER_RETRY_DELAYS_MS.every(
      (delay, i) => i === 0 || delay >= (PUBLISHER_RETRY_DELAYS_MS[i - 1] ?? 0),
    );
    expect(monotonic).toBe(true);
  });

  it('spends a bounded total in the tens of seconds, not minutes', () => {
    const total = PUBLISHER_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    // Long enough for a seller fumbling a permission prompt, short enough that
    // a dead room is cheap. Asserted as a range so the schedule can be tuned
    // without a test edit, but cannot silently become unbounded.
    expect(total).toBeGreaterThanOrEqual(30_000);
    expect(total).toBeLessThanOrEqual(180_000);
  });

  it('is defensive about a negative attempt instead of returning undefined', () => {
    expect(publisherRetryDelayMs(-1)).toBe(PUBLISHER_RETRY_DELAYS_MS[0]);
  });
});

describe('isLostConnectionState', () => {
  /**
   * `disconnected` is routinely transient — ICE recovers from it on its own.
   * Re-arming on it would tear down streams that were about to come back, so
   * only `failed` counts as lost. `closed` matters for a second reason: a local
   * close is what an HMR remount produces in dev, and treating it as a fault
   * would make the dev instrument manufacture phantom connection failures.
   */
  it('re-arms only on a terminal failure', () => {
    expect(isLostConnectionState('failed')).toBe(true);
  });

  it('leaves transient and locally-initiated states alone', () => {
    for (const state of ['new', 'connecting', 'connected', 'disconnected', 'closed'] as const) {
      expect(isLostConnectionState(state)).toBe(false);
    }
  });
});

/**
 * CONTROL — proves the guards above can actually fail.
 *
 * A guard test that has never failed is a guard nobody has tested, and the two
 * assertions this file exists for are both of the shape "X is true only in this
 * narrow case", which passes trivially against a wrong implementation that says
 * "true" more often. So the two ways this fix could regress are implemented
 * here, deliberately wrong, and the same predicates are asserted to REJECT
 * them. If someone widens `isPublisherNotReady` or unbounds the schedule, the
 * real tests start failing — and these controls are what demonstrate that the
 * real tests are capable of noticing.
 *
 * These live here permanently rather than being applied to the source as a
 * temporary mutation: the working tree is shared and swept into commits on a
 * timer, so mutating the real module to test a guard can publish the mutant.
 */
describe('control: the guards reject a regressed implementation', () => {
  /** The regression of widening the not-yet case to any transport failure. */
  const tooBroad = (error: unknown): boolean => error instanceof MediaTransportError;
  /** The regression of removing the bound and polling forever. */
  const unbounded = (attempt: number): number | null =>
    PUBLISHER_RETRY_DELAYS_MS[attempt] ?? 30_000;

  it('would fail if a real fault were treated as a missing publisher', () => {
    // The real predicate separates these two; the widened one cannot.
    expect(isPublisherNotReady(new MediaTransportError('whep', 500))).toBe(false);
    expect(tooBroad(new MediaTransportError('whep', 500))).toBe(true);
  });

  it('would fail if the wait never ended', () => {
    const spent = PUBLISHER_RETRY_DELAYS_MS.length;
    expect(publisherRetryDelayMs(spent)).toBeNull();
    expect(unbounded(spent)).not.toBeNull();
  });
});

describe('buyer-facing messages', () => {
  /**
   * The two waiting/absent messages must stay distinct: one means "hold on",
   * the other means "nobody is coming, here is a Retry button". Collapsing them
   * would put the buyer back to guessing, which was half the original report.
   */
  it('separates "waiting" from "gave up", and neither leaks a raw status code', () => {
    expect(WAITING_FOR_PUBLISHER_MESSAGE).not.toBe(PUBLISHER_ABSENT_MESSAGE);
    expect(WAITING_FOR_PUBLISHER_MESSAGE.trim()).not.toHaveLength(0);
    expect(PUBLISHER_ABSENT_MESSAGE.trim()).not.toHaveLength(0);
    for (const message of [WAITING_FOR_PUBLISHER_MESSAGE, PUBLISHER_ABSENT_MESSAGE]) {
      expect(message).not.toContain('404');
      expect(message.toLowerCase()).not.toContain('whep');
    }
  });
});
