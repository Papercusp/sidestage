import { ConflictException } from '@nestjs/common';
import type { ChatMessage, ChatPresence, TranscriptMoment } from './chat.service';

export const CHAT_STORE = Symbol('CHAT_STORE');

export interface ChatCursor {
  createdAt: string;
  id: string;
}

export interface ChatMessagePage {
  items: ChatMessage[];
  nextCursor?: ChatCursor;
}

export interface AppendMessageResult {
  message: ChatMessage;
  created: boolean;
}

export interface ChatStore {
  listMessages(eventId: string, limit: number, before?: ChatCursor): Promise<ChatMessagePage>;
  listQueuedQuestions(eventId: string, limit: number, after?: ChatCursor): Promise<ChatMessagePage>;
  appendMessage(message: ChatMessage): Promise<AppendMessageResult>;
  patchMessageGrounding(eventId: string, messageId: string, patch: Partial<NonNullable<ChatMessage['grounding']>>): Promise<ChatMessage | undefined>;
  listTranscript(eventId: string, limit: number): Promise<TranscriptMoment[]>;
  appendTranscript(eventId: string, moment: TranscriptMoment): Promise<TranscriptMoment>;
  listPresence(eventId: string, cutoffIso: string): Promise<ChatPresence[]>;
  touchPresence(eventId: string, presence: ChatPresence): Promise<ChatPresence>;
  removePresence(eventId: string, userId: string): Promise<boolean>;
  /**
   * Delete every presence row last seen before `cutoffIso`, across all events,
   * and return the distinct event ids that lost at least one row.
   *
   * Presence liveness must be a property of the STORE, not of whoever happens
   * to read it. The REST read path used to prune stale rows as a side effect of
   * `listPresence`, which is invisible to a client that reads the replicated
   * `chat_presence` table directly (Zero/WebSocket sync) — those readers would
   * see ghost participants forever and the table would grow without bound. The
   * sweeper (chat-presence.sweeper.ts) drives this on a timer so Postgres stays
   * the sole authority for who is in the room.
   */
  expireStalePresence(cutoffIso: string): Promise<string[]>;
  countMessages(eventId: string): Promise<number>;
  moderateMessage(eventId: string, messageId: string, moderatorId: string, reason: string): Promise<boolean>;
}

interface MemoryEvent {
  messages: ChatMessage[];
  transcript: TranscriptMoment[];
  presence: Map<string, ChatPresence>;
  /**
   * messageId -> the retained moderation record, mirroring the
   * `chat_message.moderated_at / moderated_by / moderation_reason` columns.
   *
   * Moderation is a SOFT delete in Postgres: the row survives so the audit
   * trail survives and so the (event_id, user_id, client_request_id) unique
   * index keeps rejecting a replayed idempotency key. Keeping the record in a
   * side map reproduces that exactly without leaking moderation state into the
   * `ChatMessage` DTO, which PgChatStore's own row mapper never exposes either.
   */
  moderated: Map<string, ModerationRecord>;
}

interface ModerationRecord {
  moderatedAt: string;
  moderatedBy: string;
  moderationReason: string;
}

export class InMemoryChatStore implements ChatStore {
  private readonly events = new Map<string, MemoryEvent>();

  async listMessages(eventId: string, limit: number, before?: ChatCursor): Promise<ChatMessagePage> {
    const eligible = this.event(eventId).messages
      .filter((message) => !before || compareCursor(message, before) < 0)
      .sort(compareMessages);
    const items = eligible.slice(Math.max(0, eligible.length - limit)).map(cloneMessage);
    const hasOlder = eligible.length > items.length;
    return {
      items,
      ...(hasOlder && items[0] ? { nextCursor: { createdAt: items[0].createdAt, id: items[0].id } } : {}),
    };
  }

  async listQueuedQuestions(eventId: string, limit: number, after?: ChatCursor): Promise<ChatMessagePage> {
    const eligible = this.event(eventId).messages
      .filter((message) => (
        message.role === 'buyer'
        && message.grounding?.status === 'seller-queue'
        && (!after || compareCursor(message, after) > 0)
      ))
      .sort(compareMessages);
    const items = eligible.slice(0, limit).map(cloneMessage);
    return {
      items,
      ...(eligible.length > items.length && items.at(-1)
        ? { nextCursor: { createdAt: items.at(-1)!.createdAt, id: items.at(-1)!.id } }
        : {}),
    };
  }

  async appendMessage(message: ChatMessage): Promise<AppendMessageResult> {
    const state = this.event(message.eventId);
    if (message.clientRequestId) {
      const existing = state.messages.find((candidate) => (
        candidate.userId === message.userId && candidate.clientRequestId === message.clientRequestId
      ));
      if (existing) {
        if (!sameMutation(existing, message)) throw new ConflictException('Idempotency key was already used for a different message');
        return { message: cloneMessage(existing), created: false };
      }
    }
    state.messages.push(cloneMessage(message));
    state.presence.set(message.userId, {
      userId: message.userId,
      displayName: message.displayName,
      role: message.role,
      lastSeenAt: message.createdAt,
    });
    return { message: cloneMessage(message), created: true };
  }

  async patchMessageGrounding(
    eventId: string,
    messageId: string,
    patch: Partial<NonNullable<ChatMessage['grounding']>>,
  ): Promise<ChatMessage | undefined> {
    const message = this.event(eventId).messages.find((candidate) => candidate.id === messageId);
    if (!message) return undefined;
    const grounding = { ...(message.grounding ?? { status: 'not-routed' as const }), ...structuredClone(patch) };
    if (JSON.stringify(grounding) === JSON.stringify(message.grounding)) return undefined;
    message.grounding = grounding;
    return cloneMessage(message);
  }

  async listTranscript(eventId: string, limit: number): Promise<TranscriptMoment[]> {
    return this.event(eventId).transcript.slice(-limit).map((moment) => ({ ...moment }));
  }

  async appendTranscript(eventId: string, moment: TranscriptMoment): Promise<TranscriptMoment> {
    this.event(eventId).transcript.push({ ...moment });
    return { ...moment };
  }

  async listPresence(eventId: string, cutoffIso: string): Promise<ChatPresence[]> {
    // A pure read: expiry belongs to expireStalePresence, so every reader —
    // REST or a direct reader of the replicated table — sees the same set.
    return [...this.event(eventId).presence.values()]
      .filter((presence) => presence.lastSeenAt >= cutoffIso)
      .map((presence) => ({ ...presence }));
  }

  async expireStalePresence(cutoffIso: string): Promise<string[]> {
    const expired: string[] = [];
    for (const [eventId, state] of this.events) {
      let removed = false;
      for (const [userId, presence] of state.presence) {
        if (presence.lastSeenAt < cutoffIso) {
          state.presence.delete(userId);
          removed = true;
        }
      }
      if (removed) expired.push(eventId);
    }
    return expired;
  }

  async touchPresence(eventId: string, presence: ChatPresence): Promise<ChatPresence> {
    this.event(eventId).presence.set(presence.userId, { ...presence });
    return { ...presence };
  }

  async removePresence(eventId: string, userId: string): Promise<boolean> {
    return this.event(eventId).presence.delete(userId);
  }

  async countMessages(eventId: string): Promise<number> {
    return this.event(eventId).messages.length;
  }

  async moderateMessage(eventId: string, messageId: string): Promise<boolean> {
    const messages = this.event(eventId).messages;
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return false;
    messages.splice(index, 1);
    return true;
  }

  private event(eventId: string): MemoryEvent {
    let state = this.events.get(eventId);
    if (!state) {
      state = { messages: [], transcript: [], presence: new Map() };
      this.events.set(eventId, state);
    }
    return state;
  }
}

function compareMessages(left: ChatMessage, right: ChatMessage): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareCursor(message: ChatMessage, cursor: ChatCursor): number {
  return message.createdAt.localeCompare(cursor.createdAt) || message.id.localeCompare(cursor.id);
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return { ...message, ...(message.grounding ? { grounding: structuredClone(message.grounding) } : {}) };
}

function sameMutation(left: ChatMessage, right: ChatMessage): boolean {
  return left.displayName === right.displayName
    && left.role === right.role
    && left.text === right.text
    && JSON.stringify(left.grounding ?? null) === JSON.stringify(right.grounding ?? null);
}
