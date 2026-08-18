/**
 * What the seller's Active Event surface is allowed to claim about the room the
 * Studio is pointed at (WI-39718).
 *
 * The Studio's "Active Event" board renders whatever room id its session holds.
 * That id has never carried a status, so a DRAFT — or a room with no event row
 * at all — painted exactly like a live one: same headline, same live-console
 * chrome, no cue that GET /events filters drafts out of the buyer What's-on
 * rail. The owner hit this during a live rehearsal, read "Active Event" as
 * "buyers can see this", and ran a show nobody could discover.
 *
 * So this module answers one question, and the console renders its answer
 * verbatim: CAN A BUYER FIND THIS ROOM? It reads the seller's OWN directory
 * (`events.mine`), not the buyer guide, because the guide's whole job is to
 * omit drafts — asking it about a draft returns the same "no row" as asking it
 * about an id that does not exist, and those two are the cases a seller most
 * needs told apart.
 *
 * Pure by construction: every input is a value, so the presentation contract is
 * unit-testable without a DOM, a network, or a mounted dock.
 */

import { EventApiError, type SellerEventRecord } from '../events/api';
import type { EventLifecycleStatus } from '../events/event-lifecycle';

/**
 * The directory's verdict on the active room.
 *
 * `unlisted` is deliberately NOT one of the lifecycle statuses. It is the
 * production case this module exists for: the Studio seeded itself with a room
 * id that has no event row at all (`sunday-drop` is absent from prod), so there
 * is no status to report and no publish that could make buyers find it. Folding
 * it into `draft` would tell the seller to publish something that cannot be
 * published.
 */
export type ActiveEventPresence = 'loading' | 'unlisted' | EventLifecycleStatus;

export interface ActiveEventStatus {
  presence: ActiveEventPresence;
  /** The lifecycle status, or null while loading and when the room is unlisted. */
  status: EventLifecycleStatus | null;
  /** Badge text — short enough to sit beside the event title. */
  label: string;
  /** The one sentence that answers "can buyers find this?". */
  detail: string;
  /** True exactly when GET /events would list this room for buyers. */
  buyerVisible: boolean;
}

/**
 * Presentation per lifecycle status.
 *
 * `buyerVisible` mirrors the server's `BUYER_VISIBLE_STATUSES`
 * (`apps/api/src/events/event.service.ts`) — everything except `draft`. It is a
 * mirror rather than a second rule, and `active-event-status.test.ts` asserts
 * the two agree, for the same reason `event-lifecycle.ts` is differential
 * against the server's transition table: a hand-written copy agrees with the
 * server exactly until someone changes one of them.
 */
const STATUS_PRESENTATION: Record<
  EventLifecycleStatus,
  Pick<ActiveEventStatus, 'label' | 'detail' | 'buyerVisible'>
> = {
  draft: {
    label: 'Draft - not visible to buyers',
    detail:
      "A draft is filtered out of the buyer What's-on rail. Starting the event publishes it, so buyers can find the room.",
    buyerVisible: false,
  },
  scheduled: {
    label: 'Scheduled - visible to buyers',
    detail: "Buyers can find this event in What's on, listed with its start time.",
    buyerVisible: true,
  },
  live: {
    label: 'Live - visible to buyers',
    detail: "Buyers can find this event at the top of What's on.",
    buyerVisible: true,
  },
  ended: {
    label: 'Ended - no longer live',
    detail: "Buyers see this as a past event in What's on. Starting it again takes it live.",
    buyerVisible: true,
  },
};

/**
 * What the seller's directory says about `eventId`.
 *
 * `directoryLoading` is a separate argument rather than an inferred
 * `events.length === 0`, because "your directory has not arrived yet" and "you
 * own no such event" are the two states this surface must never conflate: the
 * first is a spinner, the second is the warning the owner needed.
 */
export function activeEventStatus(
  eventId: string,
  ownedEvents: readonly SellerEventRecord[],
  directoryLoading: boolean,
): ActiveEventStatus {
  const record = ownedEvents.find((event) => event.eventId === eventId);
  if (record) {
    return { presence: record.status, status: record.status, ...STATUS_PRESENTATION[record.status] };
  }
  if (directoryLoading) {
    return {
      presence: 'loading',
      status: null,
      label: 'Checking event status',
      detail: 'Reading your event directory.',
      buyerVisible: false,
    };
  }
  return {
    presence: 'unlisted',
    status: null,
    label: 'Not one of your events',
    detail:
      "This room id has no event in your directory, so buyers cannot find it in What's on. Create or pick the event in Event Manager.",
    buyerVisible: false,
  };
}

/**
 * What the stage's primary control says when no publisher session is open.
 *
 * The owner reported the third face of this same trap: after taking an event
 * live, the Active Event board still offered "Start event" for an event that
 * had already started. The cause is the console reading only its LOCAL media
 * session (`Boolean(stream.session)`) and never the event's lifecycle — the
 * identical omission that let a draft wear a live console's chrome.
 *
 * These are genuinely two different things and the fix keeps them two: a live
 * event with no camera attached in THIS tab still needs a camera, so the
 * control stays, but it stops claiming to start something already started and
 * names what it will actually do.
 */
export function stageStartLabel(status: ActiveEventStatus): string {
  return status.status === 'live' ? 'Go on camera' : 'Start event';
}

/**
 * The sentence under that control, or null when the label alone is honest.
 *
 * Only the already-live case earns one: "Go on camera" is a new label, and the
 * seller's first question about it is whether pressing it re-announces the
 * event to buyers. It does not.
 */
export function stageStartHint(status: ActiveEventStatus): string | null {
  return status.status === 'live'
    ? 'This event is already live for buyers. Going on camera reconnects your video to the room; it does not restart the event.'
    : null;
}

/**
 * What the badge INSIDE the camera pane may say when this tab holds no room.
 *
 * The fourth face of the same trap (WI-39839). That badge renders the room id,
 * and the room id comes from the LOCAL publisher session (`room?.eventId`) — so
 * with no camera attached in this tab it fell back to the literal string
 * "room not started". On a live event that is simply false, and it is false
 * INCHES BELOW the `stage-event-status` badge correctly reading
 * "Live - visible to buyers": the owner reported seeing both at once and
 * reasonably read the pane, which is where the video is, as the authority.
 *
 * The two facts are genuinely different — an event can be live for buyers with
 * nobody on camera in THIS tab — so the fix keeps them different and stops the
 * pane from reporting the event's lifecycle at all. It reports the only thing
 * it knows: whether YOUR camera is attached here. `stageStartHint` already
 * makes the same distinction for the button, in the same words.
 */
export function stageRoomBadgeLabel(
  roomEventId: string | null | undefined,
  status: ActiveEventStatus,
): string {
  if (roomEventId) return roomEventId;
  return status.status === 'live' ? 'Live - your camera is not on' : 'room not started';
}

/**
 * The seller-facing warning for a publish-on-start that did NOT succeed.
 *
 * "Start event" now takes the event live before it starts the media room
 * (WI-39718), so the failure this reports is the one the owner hit silently:
 * the room streams, and no buyer can find it. Every branch therefore says the
 * same thing in its last clause — buyers cannot see this — because that, not
 * the HTTP status, is the consequence the seller has to act on.
 *
 * A 409 carries the SERVER'S refusal verbatim (D-002: the API authors every
 * lifecycle refusal string, and the client shows it rather than inventing
 * competing wording); this only appends the discoverability consequence.
 */
export function publishOnStartWarning(error: unknown): string {
  if (error instanceof EventApiError) {
    if (error.status === 404) {
      return "This room has no event in your directory, so buyers cannot find it in What's on. Create or pick the event in Event Manager, then start it again.";
    }
    if (error.status === 409) {
      return `${error.message} Buyers cannot find this room in What's on until it is published.`;
    }
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not publish this event to buyers, so it is not in What's on yet: ${detail}`;
}

/**
 * The seller-facing warning for an end-on-stop that did NOT succeed (WI-39737).
 *
 * The exact mirror of `publishOnStartWarning`, and it inverts every clause for
 * the same reason that one exists: the consequence the seller must act on is
 * never the HTTP status, it is what buyers are being shown right now. Here the
 * camera HAS stopped and the transition has not, so the event is still `live`
 * in the directory — and because the What's-On rail sorts live events first, a
 * dead room is pinned at the TOP of it. That is worse than an unpublished room,
 * so this warning is more urgent than its start-side twin, not less.
 *
 * A 409 carries the SERVER'S refusal verbatim (D-002), same as the start side.
 */
export function endOnStopWarning(error: unknown): string {
  if (error instanceof EventApiError) {
    if (error.status === 404) {
      return "Your camera stopped, but this room has no event in your directory to close, so nothing is pinned to What's on. If buyers can still see this event, end it from Event Manager.";
    }
    if (error.status === 409) {
      return `${error.message} Your camera has stopped, so buyers are still being shown this event with nobody on camera.`;
    }
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Your camera stopped, but this event is still showing to buyers at the top of What's on with nobody on camera: ${detail}`;
}
