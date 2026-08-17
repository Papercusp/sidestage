import { describe, expect, it, vi } from 'vitest';
import { EventApiError } from '../events/api';
import { retryEndEvent, runEndEvent } from './end-event';

/**
 * Records the ORDER of the two effects, because order is the rule (WI-39737):
 * the camera must stop before the API call, so a hanging request can never
 * leave a seller broadcasting after they pressed "End event".
 */
function harness(endLifecycle: () => Promise<unknown>) {
  const calls: string[] = [];
  const setWarning = vi.fn<(message: string | null) => void>();
  const invalidateDirectory = vi.fn(() => { calls.push('invalidate'); });
  return {
    calls,
    setWarning,
    invalidateDirectory,
    deps: {
      stopStream: () => { calls.push('stop'); },
      endLifecycle: () => { calls.push('end'); return endLifecycle(); },
      setWarning,
      invalidateDirectory,
    },
  };
}

describe('End event closes the event, not just the camera', () => {
  it('ends the lifecycle after stopping the camera, and refreshes the directory', async () => {
    const h = harness(() => Promise.resolve({ status: 'ended' }));

    await expect(runEndEvent(h.deps)).resolves.toBe(true);

    // The regression this file exists for: "End event" used to be `stream.stop`
    // alone, so `end` never ran and the event stayed `live` in the directory
    // forever, pinned to the top of the What's-On rail.
    expect(h.calls).toEqual(['stop', 'end', 'invalidate']);
    expect(h.setWarning).toHaveBeenCalledWith(null);
  });

  it('leaves the camera stopped and explains the stale row when the close fails', async () => {
    const h = harness(() => Promise.reject(new EventApiError('Event is not live.', 409)));

    await expect(runEndEvent(h.deps)).resolves.toBe(false);

    // Stopping is not rolled back — a failed close degrades to exactly the old
    // behavior plus a warning, never to a camera the seller cannot turn off.
    expect(h.calls).toEqual(['stop', 'end']);
    // The directory must NOT be refetched: nothing changed server-side, and a
    // refetch would replace the warning's premise with a badge still reading
    // "Live" as though that were the settled answer.
    expect(h.invalidateDirectory).not.toHaveBeenCalled();

    const [message] = h.setWarning.mock.calls.at(-1) ?? [];
    expect(message).toContain('Event is not live.');
    // The consequence, not the status code, is what the seller has to act on.
    expect(message).toContain('buyers are still being shown this event');
  });

  it('does not re-run the camera teardown when the seller retries the close', async () => {
    const h = harness(() => Promise.resolve({ status: 'ended' }));

    await expect(retryEndEvent({
      endLifecycle: h.deps.endLifecycle,
      setWarning: h.setWarning,
      invalidateDirectory: h.invalidateDirectory,
    })).resolves.toBe(true);

    // The retry is pressed in a state where the camera is ALREADY stopped, so
    // a second teardown would act on a session that no longer exists.
    expect(h.calls).toEqual(['end', 'invalidate']);
  });

  it('reports a missing event without claiming buyers can still see it', async () => {
    const h = harness(() => Promise.reject(new EventApiError('Not found', 404)));

    await expect(runEndEvent(h.deps)).resolves.toBe(false);

    const [message] = h.setWarning.mock.calls.at(-1) ?? [];
    // A 404 means there is no directory row to be pinned by, so the warning
    // must not tell the seller to go fix a rail entry that does not exist.
    expect(message).toContain('no event in your directory');
    expect(message).not.toContain('still being shown');
  });
});
