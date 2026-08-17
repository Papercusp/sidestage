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
 * Backoff for re-offering while waiting for a publisher.
 *
 * Fast at first because the common case is a buyer already in the room when the
 * seller hits `Start event` — the gap is one camera prompt, a second or two —
 * then settling to a steady poll so a room left open overnight is not hammering
 * the media server. WHEP re-offers are cheap (one POST that 404s immediately),
 * so the floor is chosen for perceived latency, not for load.
 */
export const PUBLISHER_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 3_000, 5_000];

export function publisherRetryDelayMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), PUBLISHER_RETRY_DELAYS_MS.length - 1);
  return PUBLISHER_RETRY_DELAYS_MS[index] ?? PUBLISHER_RETRY_DELAYS_MS[PUBLISHER_RETRY_DELAYS_MS.length - 1] ?? 5_000;
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
