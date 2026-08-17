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
 */
export function urlEventId(): string | null {
  if (typeof window === 'undefined') return null;
  return normalizedEventId(new URLSearchParams(window.location.search).get('event') ?? '');
}

export function browserEventId(): string {
  return urlEventId() ?? DEFAULT_EVENT_ID;
}
