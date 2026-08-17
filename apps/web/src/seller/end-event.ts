import { endOnStopWarning } from './active-event-status';

/**
 * What "End event" has to do, as one testable unit (WI-39737).
 *
 * This lives outside SellerTab because the defect it fixes was never visible in
 * any value SellerTab exposes — the bug WAS the wiring, `onEndEvent:
 * stream.stop`, a single expression with no seam a test could reach. Pulling
 * the sequence out gives it one, and the sequence is the part with rules worth
 * asserting: what runs first, what a failure does, and what a failure must NOT
 * undo.
 */
export interface EndEventDeps {
  /** Stop the local publisher. Local and synchronous — this cannot fail. */
  stopStream: () => void;
  /** Transition the event out of `live` (the `end` lifecycle action). */
  endLifecycle: () => Promise<unknown>;
  /** Show or clear the seller-facing warning; `null` clears it. */
  setWarning: (message: string | null) => void;
  /** Refetch the directory so the console's status badge stops saying "Live". */
  invalidateDirectory: () => void;
}

/**
 * Stop the camera, then close the event, and report whether the close landed.
 *
 * THE ORDER IS THE POINT, and it is the reverse of the start path (which
 * publishes BEFORE opening the camera). Stopping first is what the seller
 * asked for and is the half that cannot fail; awaiting the API first would
 * keep them broadcasting for the length of a slow request, and forever if the
 * request never settles. Every failure branch therefore leaves the camera
 * stopped — a failure here degrades to exactly the old behavior (a stale
 * `live` row) plus a warning, never to something worse.
 *
 * Returns whether the lifecycle actually closed, so a caller can tell "ended"
 * from "camera off, still listed".
 */
export async function runEndEvent(deps: EndEventDeps): Promise<boolean> {
  deps.stopStream();
  try {
    await deps.endLifecycle();
    deps.setWarning(null);
    // The badge reads the directory, so without this it keeps saying "Live"
    // about the event this call just closed — the same refetch the publish
    // path needs for the same reason.
    deps.invalidateDirectory();
    return true;
  } catch (error) {
    deps.setWarning(endOnStopWarning(error));
    return false;
  }
}

/**
 * Retry only the lifecycle close, leaving the camera alone.
 *
 * The retry beside the warning is pressed in a state where the camera is
 * ALREADY stopped, so re-running `stopStream` would be at best redundant and
 * at worst a second teardown of a session that no longer exists. `end` is
 * idempotent from `ended` server-side, so pressing it twice is safe.
 */
export async function retryEndEvent(deps: Omit<EndEventDeps, 'stopStream'>): Promise<boolean> {
  return runEndEvent({ ...deps, stopStream: () => {} });
}
