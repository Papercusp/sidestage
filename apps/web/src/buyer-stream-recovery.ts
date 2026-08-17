/**
 * Keeping a buyer attached to a live room while the seller's camera comes and
 * goes (WI-39733).
 *
 * The media plane and the event lifecycle are two independent systems, and the
 * lifecycle moves FIRST: `Start event` takes the event live before the seller's
 * WHIP publisher exists, because the camera permission grant sits between them.
 * MediaMTX answers WHEP with 404 for a path that has no publisher, so a buyer
 * who joins in that window — which is every buyer already watching when the
 * seller goes live — got `Media server rejected the WHEP offer (404).` and a
 * black pane that never recovered, because the auto-connect was a ONE SHOT: its
 * effect never re-ran while the event stayed live, so the publisher arriving
 * seconds later changed nothing until the buyer reloaded the page.
 *
 * That 404 is not an error, it is a NOT-YET. The viewer therefore stays armed
 * and re-offers until the publisher appears. A 404 is the only status treated
 * that way: every other failure (a wrong host, a rejected offer, a broken
 * browser) is a real error and still latches so the buyer sees it.
 */

import { MediaTransportError } from './streaming';

/** MediaMTX's answer for "this path has no publisher right now". */
export const PUBLISHER_NOT_READY_STATUS = 404;

/**
 * Shown while the room is live but the seller has not gone on camera yet.
 * Deliberately about the SELLER rather than the media server: a buyer waiting
 * for a person to appear is the actual situation, and the raw transport status
 * told them nothing they could act on.
 */
export const WAITING_FOR_PUBLISHER_MESSAGE =
  'Waiting for the seller to start their camera…';

/**
 * Is this failure "the seller has not started publishing yet"?
 *
 * Narrow by construction: only a WHEP/WHIP transport 404 qualifies. A network
 * error, a 500, or a browser-side WebRTC failure is a genuine fault and must
 * keep its current latched-error behaviour, retry button included.
 */
export function isPublisherNotReady(error: unknown): boolean {
  return error instanceof MediaTransportError
    && error.status === PUBLISHER_NOT_READY_STATUS;
}

/**
 * Backoff for re-offering while waiting for a publisher — and the reason it is
 * a FINITE schedule rather than a steady poll.
 *
 * Fast at first because the common case is a buyer already in the room when the
 * seller hits `Start event`: the gap is one camera prompt, a second or two.
 * It then widens, and it ENDS. A `live` event is not proof that a seller is
 * ever coming: `End event` today only stops the camera and leaves the row
 * `live` in the directory (WI-39737), so dead rooms sit at the top of the
 * What's-On rail indefinitely. An unbounded poll would have every buyer who
 * opens one re-offering against MediaMTX forever. After the schedule is spent
 * the viewer gives up and hands the buyer an explicit retry instead.
 *
 * The total is ~96s across 10 offers, which comfortably covers a seller
 * fumbling a permission prompt while staying cheap for a room nobody is
 * running.
 */
export const PUBLISHER_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 3_000, 5_000, 5_000, 10_000, 10_000, 15_000, 15_000, 30_000,
];

/** Shown once the wait above is spent, replacing the raw transport status. */
export const PUBLISHER_ABSENT_MESSAGE =
  'The seller has not started their camera yet. Retry once they are on.';

/**
 * How long to wait before re-offering after `attempt` failed offers, or `null`
 * once the bounded wait is spent and the viewer should stop and surface a
 * retry. `attempt` is 0-based: 0 is the delay after the first failure.
 */
export function publisherRetryDelayMs(attempt: number): number | null {
  if (attempt < 0) return PUBLISHER_RETRY_DELAYS_MS[0] ?? null;
  return PUBLISHER_RETRY_DELAYS_MS[attempt] ?? null;
}

/**
 * A peer connection state that means the media is gone and will not come back
 * on its own. `failed` is terminal for an established WebRTC session, so it is
 * the honest trigger for re-arming; `disconnected` is routinely transient (ICE
 * recovers from it) and re-connecting on it would tear down working streams.
 */
export function isLostConnectionState(state: RTCPeerConnectionState): boolean {
  return state === 'failed';
}
