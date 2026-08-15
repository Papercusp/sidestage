import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSyncMutate, useSyncPrincipal, useSyncQuery } from '@papercusp/sync';
import { requestChatJson } from './chat-api';
import { sellerPrivateRequestHeaders } from './events/api';
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
  grounding?: {
    status: 'answered' | 'seller-queue';
    sourceMessageId?: string;
    citation?: {
      transcriptId: string;
      label: string;
      quote: string;
      startMs?: number;
    };
  };
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

export interface EventChatMessageInput {
  userId: string;
  displayName: string;
  role: EventChatRole;
  text: string;
}

export interface EventChatPresenceInput {
  userId: string;
  displayName: string;
  role: EventChatRole;
}

type QueueView = 'focused' | 'all';

export interface EventChatProps {
  eventId: string;
  role: EventChatRole;
  userId: string;
  displayName: string;
  eventTitle?: string;
  /** Dense dock management by default; video mounts opt into the lightweight audience surface. */
  surface?: 'management' | 'audience-overlay';
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

/** The one chat write seam shared by the room composer and seller copilot. */
export function useEventChatSender({
  eventId,
  apiBaseUrl,
}: Pick<EventChatProps, 'eventId' | 'apiBaseUrl'>) {
  const apiOrigin = resolveApiOrigin(apiBaseUrl);
  const principal = useSyncPrincipal() ?? undefined;
  const fallback = useCallback(async (input: EventChatMessageInput) => {
    return requestChatJson<EventChatMessage>(`${apiOrigin}/chat/events/${encodeURIComponent(eventId)}/messages`, {
      method: 'POST',
      headers: input.role === 'seller'
        ? sellerPrivateRequestHeaders(principal ?? input.userId)
        : undefined,
      body: JSON.stringify(input),
    });
  }, [apiOrigin, eventId, principal]);
  return useSyncMutate<EventChatMessageInput, EventChatMessage>('chat.sendMessage', fallback);
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
  surface = 'management',
  apiBaseUrl,
}: EventChatProps) {
  const apiOrigin = resolveApiOrigin(apiBaseUrl);
  const principal = useSyncPrincipal() ?? userId;
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
  const audienceMessagesRef = useRef<HTMLDivElement>(null);

  const sendMessage = useEventChatSender({ eventId, apiBaseUrl });
  const touchPresenceFallback = useCallback((input: EventChatPresenceInput) => (
    requestChatJson<EventChatPresence>(`${apiOrigin}/chat/events/${encodeURIComponent(eventId)}/presence`, {
      method: 'POST',
      headers: input.role === 'seller' ? sellerPrivateRequestHeaders(principal) : undefined,
      body: JSON.stringify(input),
    })
  ), [apiOrigin, eventId, principal]);
  const leavePresenceFallback = useCallback(({ userId: leavingUserId }: { userId: string }) => (
    requestChatJson<{ ok: true }>(
      `${apiOrigin}/chat/events/${encodeURIComponent(eventId)}/presence/${encodeURIComponent(leavingUserId)}`,
      {
        method: 'DELETE',
        headers: role === 'seller' ? sellerPrivateRequestHeaders(principal) : undefined,
      },
    )
  ), [apiOrigin, eventId, principal, role]);
  const touchPresence = useSyncMutate<EventChatPresenceInput, EventChatPresence>(
    'chat.touchPresence',
    touchPresenceFallback,
  );
  const leavePresence = useSyncMutate<{ userId: string }, { ok: true }>(
    'chat.leavePresence',
    leavePresenceFallback,
  );

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const input = { userId, displayName, role };

    const touch = async () => {
      try {
        await touchPresence(input);
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
      void leavePresence({ userId }).catch(() => undefined);
    };
  }, [displayName, eventId, leavePresence, role, touchPresence, userId]);

  const remoteMessages = messagesQuery.data ?? [];
  const messages = useMemo(() => {
    const remoteIds = new Set(remoteMessages.map((message) => message.id));
    return [...remoteMessages, ...optimisticMessages.filter((message) => !remoteIds.has(message.id))];
  }, [optimisticMessages, remoteMessages]);
  const triagedMessages = useMemo(() => triageMessages(messages), [messages]);
  useEffect(() => {
    if (surface !== 'audience-overlay') return;
    const list = audienceMessagesRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, surface]);
  const focusedMessages = useMemo(
    () => triagedMessages
      .filter(({ message, triage }) => (
        message.role === 'buyer'
        && triage.importance !== 'low'
        && message.grounding?.status !== 'answered'
      ))
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

  if (surface === 'audience-overlay') {
    return (
      <section
        className="event-chat-audience"
        data-surface="audience-overlay"
        aria-label={`${eventTitle} audience chat`}
      >
        <div
          className="event-chat-audience-messages"
          ref={audienceMessagesRef}
          data-video-chat-scroll
          aria-live="polite"
        >
          {triagedMessages.length === 0 ? (
            <p className="event-chat-audience-empty">Chat will appear here when the room starts talking.</p>
          ) : null}
          {triagedMessages.map(({ message, triage }) => (
            <article
              className={`event-chat-audience-message event-chat-audience-message-${triage.importance}`}
              key={message.id}
            >
              <div className={`event-chat-audience-avatar event-chat-audience-avatar-${message.role}`} aria-hidden="true">
                {message.displayName.slice(0, 1).toUpperCase()}
              </div>
              <div className="event-chat-audience-copy">
                <div className="event-chat-audience-meta">
                  <strong>{message.displayName}</strong>
                  {triage.importance !== 'low' ? (
                    <span className={`event-chat-audience-tag event-chat-audience-tag-${triage.importance}`}>
                      {triage.label}
                    </span>
                  ) : null}
                </div>
                <p>{message.text}</p>
                {message.grounding?.status === 'answered' ? (
                  <span className="event-chat-audience-state">Answered from transcript</span>
                ) : null}
                {message.grounding?.status === 'seller-queue' ? (
                  <span className="event-chat-audience-state">Queued for seller</span>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        {canSend ? (
          <form className="event-chat-audience-form" onSubmit={(event) => void submit(event)}>
            <label className="sr-only" htmlFor={`event-chat-audience-message-${eventId}`}>Message the room</label>
            <input
              id={`event-chat-audience-message-${eventId}`}
              className="event-chat-audience-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Say something…"
              maxLength={500}
            />
            <button className="event-chat-audience-send" type="submit" disabled={!draft.trim()}>Send</button>
          </form>
        ) : null}

        {sendError ? <p className="event-chat-audience-error" role="alert">{sendError}</p> : null}
        {presenceError ? <p className="event-chat-audience-error" role="status">{presenceError}</p> : null}
      </section>
    );
  }

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
              {message.grounding?.status === 'answered' ? (
                <span className="event-chat-grounding event-chat-grounding-answered">
                  Answered from transcript{message.grounding.citation ? ` · ${message.grounding.citation.label}` : ''}
                </span>
              ) : null}
              {message.grounding?.status === 'seller-queue' ? (
                <span className="event-chat-grounding event-chat-grounding-queued">Queued for seller</span>
              ) : null}
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
  return <EventChatSurface {...props} />;
}
