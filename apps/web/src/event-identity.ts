export const DEFAULT_EVENT_ID = 'sunday-drop';
export const DEFAULT_EVENT_TITLE = 'Sunday vintage drop';

export function mediaBaseUrl(): string | undefined {
  return import.meta.env.VITE_MEDIAMTX_URL;
}

export function chatEventId(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized) ? normalized : DEFAULT_EVENT_ID;
}

export function browserEventId(): string {
  if (typeof window === 'undefined') return DEFAULT_EVENT_ID;
  const eventId = new URLSearchParams(window.location.search).get('event');
  return chatEventId(eventId ?? '');
}
