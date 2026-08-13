import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { SyncProvider, useSyncMutate, useSyncQuery } from '@papercusp/sync';
import { MESSAGE_IMPORTANCE_ORDER, triageMessages, type MessageImportance, type TriagedMessage } from './message-triage';

export type EventChatRole = 'buyer' | 'seller';

export interface EventChatMessage {
  id: string;
  eventId: string;
  userId: string;
  displayName: string;
  role: EventChatRole;
  text: string;
  createdAt: string;
}

export interface EventChatPresence {
  userId: string;
  displayName: string;
  role: EventChatRole;
  lastSeenAt: string;
}

export interface EventChatStats {
  activeUsers: number;
  buyers: number;
  sellers: number;
  totalMessages: number;
}

interface MessageInput {
  userId: string;
  displayName: string;
  role: EventChatRole;
  text: string;
}

type QueueView = 'focused' | 'all';

export interface EventChatProps {
  eventId: string;
  role: EventChatRole;
  userId: string;
  displayName: string;
  eventTitle?: string;
  /** API origin without a trailing slash. Defaults to the local API port. */
  apiBaseUrl?: string;
}

const DEFAULT_API_ORIGIN = 'http://localhost:3100';
const PRESENCE_HEARTBEAT_MS = 15_000;

export function resolveApiOrigin(apiBaseUrl?: string): string {
  const configured = apiBaseUrl ?? import.meta.env.VITE_API_URL;
  return (configured || DEFAULT_API_ORIGIN).replace(/\/+$/, '');
}

export function syncEndpointFor(apiBaseUrl?: string): string {
  return `${resolveApiOrigin(apiBaseUrl)}/sync`;
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
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

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'now';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

function EventChatSurface({
  eventId,
  role,
  userId,
  displayName,
  eventTitle = 'Live event',
  apiBaseUrl,
}: EventChatProps) {
  const apiOrigin = resolveApiOrigin(apiBaseUrl);
  const messagesQuery = useSyncQuery<EventChatMessage>({
    queryName: 'event.chat.messages',
    args: { eventId },
    pollIntervalMs: 10_000,
  });
  const presenceQuery = useSyncQuery<EventChatPresence>({
    queryName: 'event.chat.presence',
    args: { eventId },
    pollIntervalMs: 10_000,
  });
  const statsQuery = useSyncQuery<EventChatStats>({
    queryName: 'event.chat.stats',
    args: { eventId },
    pollIntervalMs: 10_000,
  });

  const [draft, setDraft] = useState('');
  const [optimisticMessages, setOptimisticMessages] = useState<EventChatMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [presenceError, setPresenceError] = useState<string | null>(null);
  const [queueView, setQueueView] = useState<QueueView>(role === 'seller' ? 'focused' : 'all');

  const sendMessageFallback = useCallback(async (input: MessageInput) => {
    return requestJson<EventChatMessage>(`${apiOrigin}/chat/events/${encodeURIComponent(eventId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }, [apiOrigin, eventId]);
  const sendMessage = useSyncMutate<MessageInput, EventChatMessage>('chat.sendMessage', sendMessageFallback);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const presenceUrl = `${apiOrigin}/chat/events/${encodeURIComponent(eventId)}/presence`;
    const input = { userId, displayName, role };

    const touch = async () => {
      try {
        await requestJson<EventChatPresence>(presenceUrl, {
          method: 'POST',
          body: JSON.stringify(input),
        });
        if (!stopped) setPresenceError(null);
      } catch (error) {
        if (!stopped) setPresenceError(error instanceof Error ? error.message : 'Presence is unavailable.');
      } finally {
        if (!stopped) timer = setTimeout(() => void touch(), PRESENCE_HEARTBEAT_MS);
      }
    };

    void touch();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      void fetch(`${presenceUrl}/${encodeURIComponent(userId)}`, { method: 'DELETE' }).catch(() => undefined);
    };
  }, [apiOrigin, displayName, eventId, role, userId]);

  const remoteMessages = messagesQuery.data ?? [];
  const messages = useMemo(() => {
    const remoteIds = new Set(remoteMessages.map((message) => message.id));
    return [...remoteMessages, ...optimisticMessages.filter((message) => !remoteIds.has(message.id))];
  }, [optimisticMessages, remoteMessages]);
  const triagedMessages = useMemo(() => triageMessages(messages), [messages]);
  const focusedMessages = useMemo(
    () => triagedMessages
      .filter(({ triage }) => triage.importance !== 'low')
      .sort((left, right) => MESSAGE_IMPORTANCE_ORDER[left.triage.importance] - MESSAGE_IMPORTANCE_ORDER[right.triage.importance]),
    [triagedMessages],
  );
  const visibleMessages: readonly TriagedMessage<EventChatMessage>[] = role === 'seller' && queueView === 'focused'
    ? focusedMessages
    : triagedMessages;
  const importanceCounts = useMemo(() => triagedMessages.reduce<Record<MessageImportance, number>>((counts, entry) => {
    counts[entry.triage.importance] += 1;
    return counts;
  }, { high: 0, normal: 0, low: 0 }), [triagedMessages]);
  const presence = presenceQuery.data ?? [];
  const stats = statsQuery.data?.[0] ?? {
    activeUsers: presence.length,
    buyers: presence.filter((entry) => entry.role === 'buyer').length,
    sellers: presence.filter((entry) => entry.role === 'seller').length,
    totalMessages: messages.length,
  };
  const canSend = role === 'buyer';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!canSend || !text) return;
    setSendError(null);
    try {
      const message = await sendMessage({ userId, displayName, role, text });
      setOptimisticMessages((current) => [...current, message]);
      setDraft('');
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Message could not be sent.');
    }
  };

  return (
    <section className="stage-panel event-chat-card" aria-label={`${eventTitle} chat`}>
      <div className="panel-kicker">
        <span>{role === 'seller' ? 'Seller console' : 'In the room'}</span>
        <span className="connection-pill"><span className="connection-dot" /> {stats.activeUsers} active</span>
      </div>
      <div className="event-chat-heading">
        <div>
          <p className="eyebrow">{eventTitle}</p>
          <h2>Live chat</h2>
        </div>
        <div className="event-chat-stats" aria-label="Chat activity">
          <span>{stats.buyers} buyers</span>
          <span>{stats.sellers} sellers</span>
          <span>{stats.totalMessages} messages</span>
        </div>
      </div>

      {role === 'seller' ? (
        <div className="event-chat-queue" aria-label="Message triage queue">
          <div className="event-chat-queue-heading">
            <div>
              <span className="panel-kicker">Message triage</span>
              <strong>{importanceCounts.high} priority · {importanceCounts.normal} questions · {importanceCounts.low} social</strong>
            </div>
            <div className="event-chat-queue-controls" role="group" aria-label="Message queue view">
              <button
                className={queueView === 'focused' ? 'is-active' : ''}
                type="button"
                aria-pressed={queueView === 'focused'}
                onClick={() => setQueueView('focused')}
              >
                Focused <span>{focusedMessages.length}</span>
              </button>
              <button
                className={queueView === 'all' ? 'is-active' : ''}
                type="button"
                aria-pressed={queueView === 'all'}
                onClick={() => setQueueView('all')}
              >
                All <span>{triagedMessages.length}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="event-chat-messages" aria-live="polite">
        {visibleMessages.length === 0 ? (
          <p className="muted">
            {messages.length === 0 ? 'No messages yet. Start the conversation.' : 'No messages need your attention right now.'}
          </p>
        ) : null}
        {visibleMessages.map(({ message, triage }) => (
          <article className={`event-chat-message event-chat-message-${triage.importance}`} key={message.id}>
            <div className={`event-chat-avatar event-chat-avatar-${message.role}`} aria-hidden="true">
              {message.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div className="event-chat-message-meta">
                <strong>{message.displayName}</strong>
                <span>{formatTimestamp(message.createdAt)}</span>
                <span className="event-chat-role">{message.role}</span>
                {role === 'seller' ? (
                  <span className={`event-chat-importance event-chat-importance-${triage.importance}`} title={triage.reason}>
                    {triage.label}
                  </span>
                ) : null}
              </div>
              <p>{message.text}</p>
            </div>
          </article>
        ))}
      </div>

      {canSend ? (
        <form className="event-chat-form" onSubmit={(event) => void submit(event)}>
          <label className="sr-only" htmlFor={`event-chat-message-${eventId}`}>Message the room</label>
          <input
            id={`event-chat-message-${eventId}`}
            className="text-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask the seller something…"
            maxLength={500}
          />
          <button className="button primary" type="submit" disabled={!draft.trim()}>Send</button>
        </form>
      ) : (
        <p className="muted event-chat-readonly">Seller view is read-only; buyers can send messages from the room.</p>
      )}

      {sendError ? <p className="event-chat-error" role="alert">{sendError}</p> : null}
      {presenceError ? <p className="event-chat-error" role="status">{presenceError}</p> : null}

      <div className="event-chat-presence" aria-label="Active participants">
        <span className="panel-kicker">Active participants</span>
        {presence.length === 0 ? <span className="muted">Waiting for the room…</span> : null}
        {presence.map((participant) => (
          <span className="event-chat-participant" key={participant.userId}>
            <span className="live-dot" aria-hidden="true" />
            {participant.displayName}
          </span>
        ))}
      </div>
    </section>
  );
}

/**
 * Event chat with the shared sync transport mounted at the feature boundary.
 * The shell can later lift this provider to the app root without changing the
 * query or mutation contract used by the chat surface.
 */
export function EventChat(props: EventChatProps) {
  const syncEndpoint = syncEndpointFor(props.apiBaseUrl);
  const endpointOverride = `${syncEndpoint}/sse?eventId=${encodeURIComponent(props.eventId)}`;
  return (
    <SyncProvider
      syncType="SSE"
      restEndpoint={syncEndpoint}
      endpointOverride={endpointOverride}
      pollIntervalMs={10_000}
    >
      <EventChatSurface {...props} />
    </SyncProvider>
  );
}
