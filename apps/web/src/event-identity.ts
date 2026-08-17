export const DEFAULT_EVENT_ID = 'sunday-drop';
export const DEFAULT_EVENT_TITLE = 'Sunday vintage drop';

export function mediaBaseUrl(): string | undefined {
  return import.meta.env.VITE_MEDIAMTX_URL;
}

/** The room-id grammar the chat/media transports accept. */
function normalizedEventId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized) ? normalized : null;
}

export function chatEventId(value: string): string {
  return normalizedEventId(value) ?? DEFAULT_EVENT_ID;
}

/**
 * The event the URL actually names, or null when it names none (D-001).
 *
 * Deliberately distinct from `browserEventId()`, which MANUFACTURES
 * DEFAULT_EVENT_ID for a URL that selects nothing. The buyer shell needs the
 * honest absence: a constant default is a second source of truth about which
 * rooms exist, and it drifts out of the live directory. That drift is a
 * reported defect, not a hypothetical — production's directory holds no
 * `sunday-drop` row at all, so the pinned default opened a room the Channel
 * Guide could not even list, while the guide's own first row sat unopened.
 * Callers that can consult the directory should follow it and use this;
 * `browserEventId()` remains for seller surfaces that need a seed before any
 * directory read.
 *
 * `search` is injectable for the same reason `app-routing`'s readers take a
 * URL: the parse is then verifiable without a DOM, so a node-environment test
 * exercises the real function rather than a re-implementation of it.
 */
export function urlEventId(search?: string): string | null {
  const query = search ?? (typeof window === 'undefined' ? null : window.location.search);
  if (query === null) return null;
  return normalizedEventId(new URLSearchParams(query).get('event') ?? '');
}

export function browserEventId(search?: string): string {
  return urlEventId(search) ?? DEFAULT_EVENT_ID;
}

/**
 * Which room the buyer shell opens (D-001).
 *
 * Precedence: an explicit choice — the URL's `?event=`, or a Channel Guide row
 * the buyer clicked — then the guide's FIRST row, then the seed.
 *
 * The middle term is the whole point, and is why this is a named function
 * rather than an inline `??` chain: the guide is ALREADY ordered by the server
 * (live by viewers, then soonest-scheduled, then most recently ended) and the
 * sidebar paints it in that order, so its first element IS the top row the
 * buyer can see. Anything else landing them somewhere the sidebar does not
 * point is the defect this replaces.
 *
 * DEFAULT_EVENT_ID survives only as the pre-directory seed, for the first
 * paint before any row has arrived. It must never outrank a row the guide
 * actually has — production's directory contains no `sunday-drop`, so when it
 * did, the shell opened a room the guide could not even list.
 */
export function resolveActiveEventId(
  pinnedEventId: string | null,
  guideEvents: readonly { eventId: string }[],
): string {
  return pinnedEventId ?? guideEvents[0]?.eventId ?? DEFAULT_EVENT_ID;
}
