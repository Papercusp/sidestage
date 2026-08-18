import { describe, expect, it } from 'vitest';
import { BUYER_VISIBLE_STATUSES, type EventStatus } from '../../../api/src/events/event.service';
import { EventApiError, type SellerEventRecord } from '../events/api';
import type { EventLifecycleStatus } from '../events/event-lifecycle';
import {
  activeEventStatus,
  publishOnStartWarning,
  stageRoomBadgeLabel,
  stageStartHint,
  stageStartLabel,
} from './active-event-status';

/**
 * WI-39718 — the sunday-drop trap, in the two halves the owner hit.
 *
 * HALF ONE: the Live console's "Start event" started the media room and left
 * the EVENT a draft, so GET /events kept filtering it out and the show ran
 * undiscoverable. The console now publishes as part of starting, and this suite
 * pins what the seller is told when that publish cannot land.
 *
 * HALF TWO: the "Active Event" board rendered whatever room id the session held
 * with no status at all, so a draft — and even an id with no event row — wore
 * the same live-console chrome. These cases pin that every lifecycle state, and
 * the absent one, says out loud whether a buyer can find the room.
 */

const ALL_STATUSES: readonly EventLifecycleStatus[] = ['draft', 'scheduled', 'live', 'ended'];

function record(overrides: Partial<SellerEventRecord> = {}): SellerEventRecord {
  return {
    eventId: 'sunday-drop',
    title: 'Sunday vintage drop',
    sellerId: 'seller-1',
    sellerName: 'Avi',
    status: 'draft',
    startsAt: null,
    endedAt: null,
    ...overrides,
  };
}

describe('activeEventStatus', () => {
  it('says a draft is invisible to buyers instead of letting the console imply liveness', () => {
    const status = activeEventStatus('sunday-drop', [record({ status: 'draft' })], false);

    expect(status.presence).toBe('draft');
    expect(status.buyerVisible).toBe(false);
    expect(status.label).toBe('Draft - not visible to buyers');
    // The sentence has to name the consequence, not the state: "draft" alone is
    // what the owner already saw in Event Manager and read past.
    expect(status.detail).toContain("What's-on rail");
  });

  it('tells an unlisted room apart from a draft, because only one of them can be published', () => {
    const unlisted = activeEventStatus('sunday-drop', [record({ eventId: 'avi-real-test' })], false);

    expect(unlisted.presence).toBe('unlisted');
    expect(unlisted.status).toBeNull();
    expect(unlisted.buyerVisible).toBe(false);
    expect(unlisted.detail).toContain('Event Manager');
  });

  it('never reports "not one of your events" while the directory is still loading', () => {
    const loading = activeEventStatus('sunday-drop', [], true);

    expect(loading.presence).toBe('loading');
    expect(loading.buyerVisible).toBe(false);
    // A spinner must not read as the warning: the seller would go create an
    // event they already own.
    expect(loading.label).not.toContain('Not one of your events');
  });

  /**
   * DIFFERENTIAL, in the shape of `events/event-lifecycle.test.ts`: the badge's
   * buyer-visibility claim is checked against the SERVER's own
   * `BUYER_VISIBLE_STATUSES` rather than a hand-written expectation, so the two
   * cannot drift into agreeing only about the states nobody changed.
   */
  it('agrees with the server about which statuses a buyer can actually find', () => {
    for (const status of ALL_STATUSES) {
      const resolved = activeEventStatus('sunday-drop', [record({ status })], false);
      const serverVisible = BUYER_VISIBLE_STATUSES.includes(status as EventStatus);

      expect(resolved.status).toBe(status);
      expect(resolved.buyerVisible).toBe(serverVisible);
      expect(resolved.label.length).toBeGreaterThan(0);
      expect(resolved.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('stage CTA lifecycle state', () => {
  it('stops offering "Start event" for an event that has already started', () => {
    // The owner's live repro: 'potato' was taken live, appeared on the Active
    // Event tab, and the tab still offered to start it.
    const live = activeEventStatus('potato', [record({ eventId: 'potato', status: 'live' })], false);

    expect(stageStartLabel(live)).toBe('Go on camera');
    expect(stageStartHint(live)).toContain('does not restart the event');
  });

  it('keeps "Start event" everywhere the event has not gone live yet', () => {
    for (const status of ALL_STATUSES.filter((candidate) => candidate !== 'live')) {
      const resolved = activeEventStatus('sunday-drop', [record({ status })], false);
      expect(stageStartLabel(resolved)).toBe('Start event');
      expect(stageStartHint(resolved)).toBeNull();
    }
    // An unlisted room is not live either, and its warning is the publish
    // failure — the CTA stays the plain one.
    expect(stageStartLabel(activeEventStatus('nope', [], false))).toBe('Start event');
  });
});

describe('camera-pane room badge', () => {
  it('stops the pane calling a live event "room not started" (WI-39839)', () => {
    // The owner's screenshot: the camera pane read "room not started" inches
    // below a badge correctly reading "Live - visible to buyers", and the pane
    // is where the video is, so that is the one they believed.
    const live = activeEventStatus('potato', [record({ eventId: 'potato', status: 'live' })], false);

    expect(stageRoomBadgeLabel(null, live)).toBe('Live - your camera is not on');
    expect(stageRoomBadgeLabel(null, live)).not.toContain('room not started');
  });

  it('reports the attached room id whenever this tab holds one', () => {
    // The badge's real job. It is unchanged by the fix, on every status.
    for (const status of ALL_STATUSES) {
      const resolved = activeEventStatus('sunday-drop', [record({ status })], false);
      expect(stageRoomBadgeLabel('sunday-drop', resolved)).toBe('sunday-drop');
    }
  });

  it('keeps "room not started" wherever it is still true', () => {
    for (const status of ALL_STATUSES.filter((candidate) => candidate !== 'live')) {
      const resolved = activeEventStatus('sunday-drop', [record({ status })], false);
      expect(stageRoomBadgeLabel(null, resolved)).toBe('room not started');
    }
    // Loading and unlisted carry no lifecycle status, so the pane cannot claim
    // the event is live — asserting it here would trade one false badge for
    // another.
    expect(stageRoomBadgeLabel(null, activeEventStatus('sunday-drop', [], true))).toBe('room not started');
    expect(stageRoomBadgeLabel(null, activeEventStatus('nope', [], false))).toBe('room not started');
  });
});

describe('publishOnStartWarning', () => {
  it('names the discoverability consequence in every branch, not the HTTP status', () => {
    const missing = publishOnStartWarning(new EventApiError('Event not found for this seller.', 404));
    const refused = publishOnStartWarning(new EventApiError('End the live event before rescheduling it.', 409));
    const broken = publishOnStartWarning(new Error('Failed to fetch'));

    for (const warning of [missing, refused, broken]) {
      expect(warning.toLowerCase()).toContain("what's on");
    }
    expect(missing).toContain('Event Manager');
    expect(broken).toContain('Failed to fetch');
  });

  it('quotes the server refusal verbatim rather than inventing competing wording (D-002)', () => {
    const reason = 'Only a live event can be ended. Unpublish it instead to withdraw it before it airs.';

    expect(publishOnStartWarning(new EventApiError(reason, 409))).toContain(reason);
  });

  it('survives a thrown non-Error without losing the warning', () => {
    expect(publishOnStartWarning('socket hang up')).toContain('socket hang up');
  });
});
