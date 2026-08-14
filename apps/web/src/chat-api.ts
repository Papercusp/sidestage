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
    throw new Error(`Chat request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return response.json() as Promise<T>;
}
