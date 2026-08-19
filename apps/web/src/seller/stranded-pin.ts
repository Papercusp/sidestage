/**
 * Should the Studio stand down because the URL names an event the seller's own
 * directory does not contain? (WI-39864)
 *
 * The reported defect: a deep link into the Studio
 * (`?tab=seller&studio=active-event&event=avi-real-test`) named an event the
 * owner really created — under a seller identity their browser no longer
 * resolves to. `EventOwnershipGuard` deliberately answers 404 for missing and
 * foreign ids alike (anti-enumeration), so every event-scoped board fetched,
 * every fetch 404ed, and the seller's OWN screen filled with raw
 * "Chat request failed (404)" toasts — with no hint that switching identities
 * in the top bar would have fixed it.
 *
 * This module is the one place that decides when that state holds, so the
 * Studio can render a single ownership/identity notice INSTEAD of mounting the
 * boards that can only 404. Pure by construction, like
 * `active-event-status.ts`: every input is a value, so the contract is
 * unit-testable without a DOM or a network.
 *
 * Only the URL-seeded pin qualifies, and the distinction is load-bearing:
 * TYPING a room id also pins (WI-39272), and typing a brand-new id then
 * pressing Start is the legitimate create flow — the seller is mid-workflow on
 * an id the directory cannot contain yet, and the `unlisted` badge
 * (`activeEventStatus`) already narrates that state without blocking the
 * boards. Blocking it here would break event creation. So the caller tells us
 * where the pin came from, and only `'url'` — an id the seller did NOT choose
 * in this session — can strand.
 */

export type SellerPinSource = 'url' | 'user';

/**
 * The stranded event id, or null when the Studio should proceed normally.
 *
 * Holds fire while the directory is loading (the id may yet appear) and when
 * the directory query ERRORED (an unreachable directory says nothing about
 * ownership — the pre-WI-39864 behavior, boards fetching and reporting their
 * own failures, is the honest fallback there). Both guards mirror
 * `activeEventStatus`'s reason for taking `directoryLoading` explicitly:
 * "your directory has not arrived" and "you own no such event" must never be
 * conflated.
 */
export function strandedUrlPin(
  pinnedEventId: string | null,
  pinSource: SellerPinSource,
  ownedEvents: readonly { eventId: string }[],
  directoryLoading: boolean,
  directoryError: unknown,
): string | null {
  if (pinnedEventId === null || pinSource !== 'url') return null;
  if (directoryLoading || directoryError != null) return null;
  return ownedEvents.some((event) => event.eventId === pinnedEventId)
    ? null
    : pinnedEventId;
}

export interface StrandedPinNotice {
  headline: string;
  /** What happened, naming the id and the current identity. */
  body: string;
  /** The recovery the guard's 404 can never suggest: switch identities. */
  identityHint: string;
  /** Label for the action that clears the pin and follows the directory. */
  action: string;
}

/**
 * The notice copy, in one testable place.
 *
 * It names BOTH readings — foreign identity and stale id — because the server
 * deliberately will not let the client tell them apart (missing and foreign
 * produce the same 404), so claiming either one alone would be guessing. The
 * identity hint leads, since identity rotation is the reported, recurring way
 * sellers hit this on their own events.
 */
export function strandedPinNotice(
  eventId: string,
  sellerId: string,
): StrandedPinNotice {
  return {
    headline: 'This link points at an event that is not in your directory',
    body:
      `The link names the event "${eventId}", but your current seller identity ` +
      `(${sellerId}) owns no event with that id — so the Studio's boards would ` +
      'all answer "not found" about it.',
    identityHint:
      'If you created it under a different seller identity, switch identities ' +
      'with the identity control in the top bar and this link will work ' +
      'unchanged. If the id is stale, show your own events instead.',
    action: 'Show my events instead',
  };
}
