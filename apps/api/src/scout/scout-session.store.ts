import type { ScoutMessage, ScoutSession, ScoutSessionStore } from './scout.types';

/**
 * Transcript versioning + the in-memory store.
 *
 * The version helpers are pure and live here (not in the controller) because
 * they are the whole correctness surface of the conditional GET: an ETag that
 * fails to change when the transcript changes serves a stale conversation
 * forever, and one that changes when nothing changed defeats the 304 entirely.
 * Both are testable without an HTTP layer.
 */

/**
 * count + last-write = the version.
 *
 * Neither half suffices alone: the count misses an in-place edit of the last
 * message, and the timestamp alone has second-ish granularity in transports
 * that round it. Together they move on every real change. (Ported from
 * Restart's scout session transcript.)
 */
export function transcriptVersion(session: Pick<ScoutSession, 'messages' | 'lastActiveAt'>): string {
  return `${session.messages.length}-${session.lastActiveAt}`;
}

/** The weak ETag for a session's transcript at `version`. */
export function transcriptEtag(sessionId: string, version: string): string {
  return `W/"scout-session-${sessionId}-${version}"`;
}

/**
 * User-facing turns only, with text.
 *
 * Drops empty-content turns (e.g. a products-only assistant step) so a restored
 * transcript has no blank bubbles where the drawer would render an empty
 * assistant row.
 */
export function visibleTranscript(
  messages: readonly ScoutMessage[],
): Array<{ role: string; content: string }> {
  return messages
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0,
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Does an `If-None-Match` header match `etag`?
 *
 * The header is a COMMA-SEPARATED LIST (RFC 9110), so a substring or equality
 * test silently fails to 304 for any client that sends more than one validator
 * — the cache then never engages and the bug looks like "the ETag isn't
 * working" rather than a parsing error.
 */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .includes(etag);
}

/** Non-durable transcripts — the fallback when Postgres is not reachable. */
export class InMemoryScoutSessionStore implements ScoutSessionStore {
  private readonly sessions = new Map<string, ScoutSession>();

  async get(id: string): Promise<ScoutSession | null> {
    const session = this.sessions.get(id);
    return session ? clone(session) : null;
  }

  async append(id: string, messages: readonly ScoutMessage[]): Promise<ScoutSession> {
    const existing = this.sessions.get(id);
    const next: ScoutSession = {
      id,
      messages: [...(existing?.messages ?? []), ...messages],
      lastActiveAt: new Date().toISOString(),
    };
    this.sessions.set(id, next);
    return clone(next);
  }
}

function clone(session: ScoutSession): ScoutSession {
  return { ...session, messages: session.messages.map((m) => ({ ...m })) };
}
