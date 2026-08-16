/**
 * Thrown by requestChatJson on a non-2xx response. Carries the HTTP status so
 * callers can tell a permanent rejection (404 — the room/identity does not
 * exist or is not owned by this principal) from a transient one worth
 * retrying, without re-parsing the message string.
 */
export class ChatRequestError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Chat request failed (${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'ChatRequestError';
    this.status = status;
  }
}

/** Shared JSON transport used only as the REST fallback for named chat mutations. */
export async function requestChatJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      // Keep the transport status when a proxy closes without a body.
    }
    throw new ChatRequestError(response.status, detail);
  }
  return response.json() as Promise<T>;
}
