import { BadRequestException, Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

export type ChatRole = 'buyer' | 'seller';

export interface ChatMessage {
  id: string;
  eventId: string;
  userId: string;
  displayName: string;
  role: ChatRole;
  text: string;
  createdAt: string;
}

export interface ChatPresence {
  userId: string;
  displayName: string;
  role: ChatRole;
  lastSeenAt: string;
}

export interface ChatStats {
  activeUsers: number;
  buyers: number;
  sellers: number;
  totalMessages: number;
}

export interface ChatMessageInput {
  userId?: unknown;
  displayName?: unknown;
  role?: unknown;
  text?: unknown;
}

export interface PresenceInput {
  userId?: unknown;
  displayName?: unknown;
  role?: unknown;
}

export interface ChatSseEvent {
  id: string;
  type: 'heartbeat' | 'invalidate';
  data: string;
}

interface EventState {
  messages: ChatMessage[];
  presence: Map<string, ChatPresence>;
  updates: Subject<ChatSseEvent>;
}

const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PRESENCE_TTL_MS = 35_000;
const MAX_MESSAGES = 200;
const MAX_USER_ID_LENGTH = 80;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 500;

/**
 * The event chat's sync boundary.
 *
 * The service deliberately owns both the query-shaped read models and the
 * invalidation stream. That keeps the web app transport-agnostic: the same
 * query names work with the shared SSE adapter today and can move to a
 * durable Postgres/Zero backing store later without changing the UI.
 */
@Injectable()
export class ChatService {
  private readonly events = new Map<string, EventState>();
  private readonly clock = () => Date.now();
  private sequence = 0;

  getMessages(eventId: string): ChatMessage[] {
    const state = this.getEvent(eventId);
    this.prunePresence(state);
    return state.messages.map((message) => ({ ...message }));
  }

  getPresence(eventId: string): ChatPresence[] {
    const state = this.getEvent(eventId);
    this.prunePresence(state);
    return [...state.presence.values()].map((presence) => ({ ...presence }));
  }

  getStats(eventId: string): ChatStats {
    const presence = this.getPresence(eventId);
    return {
      activeUsers: presence.length,
      buyers: presence.filter((entry) => entry.role === 'buyer').length,
      sellers: presence.filter((entry) => entry.role === 'seller').length,
      totalMessages: this.getEvent(eventId).messages.length,
    };
  }

  addMessage(eventId: string, input: ChatMessageInput): ChatMessage {
    const state = this.getEvent(eventId);
    const userId = this.readBoundedString(input.userId, 'userId', MAX_USER_ID_LENGTH);
    const displayName = this.readBoundedString(input.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH);
    const text = this.readBoundedString(input.text, 'text', MAX_MESSAGE_LENGTH);
    const role = this.readRole(input.role);
    const now = this.clock();
    const message: ChatMessage = {
      id: `${eventId}-${++this.sequence}`,
      eventId,
      userId,
      displayName,
      role,
      text,
      createdAt: new Date(now).toISOString(),
    };

    state.messages.push(message);
    if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
    state.presence.set(userId, {
      userId,
      displayName,
      role,
      lastSeenAt: message.createdAt,
    });
    this.emitInvalidation(eventId, 'event.chat.messages');
    this.emitInvalidation(eventId, 'event.chat.presence');
    this.emitInvalidation(eventId, 'event.chat.stats');
    return { ...message };
  }

  touchPresence(eventId: string, input: PresenceInput): ChatPresence {
    const state = this.getEvent(eventId);
    const userId = this.readBoundedString(input.userId, 'userId', MAX_USER_ID_LENGTH);
    const displayName = this.readBoundedString(input.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH);
    const role = this.readRole(input.role);
    const presence: ChatPresence = {
      userId,
      displayName,
      role,
      lastSeenAt: new Date(this.clock()).toISOString(),
    };
    state.presence.set(userId, presence);
    this.emitInvalidation(eventId, 'event.chat.presence');
    this.emitInvalidation(eventId, 'event.chat.stats');
    return { ...presence };
  }

  removePresence(eventId: string, userId: string): void {
    const state = this.getEvent(eventId);
    if (!state.presence.delete(userId)) return;
    this.emitInvalidation(eventId, 'event.chat.presence');
    this.emitInvalidation(eventId, 'event.chat.stats');
  }

  updates(eventId: string): Observable<ChatSseEvent> {
    return this.getEvent(eventId).updates.asObservable();
  }

  private getEvent(eventId: string): EventState {
    if (!EVENT_ID_RE.test(eventId)) {
      throw new BadRequestException('eventId must contain 1-64 letters, numbers, hyphens, or underscores');
    }
    let state = this.events.get(eventId);
    if (!state) {
      state = { messages: [], presence: new Map(), updates: new Subject<ChatSseEvent>() };
      this.events.set(eventId, state);
    }
    return state;
  }

  private prunePresence(state: EventState): void {
    const cutoff = this.clock() - PRESENCE_TTL_MS;
    let changed = false;
    for (const [userId, presence] of state.presence) {
      if (Date.parse(presence.lastSeenAt) < cutoff) {
        state.presence.delete(userId);
        changed = true;
      }
    }
    if (changed) {
      // A stale viewer disappearing is itself a live update. The next query
      // sees the pruned map, while connected clients update their stats.
      this.emitInvalidationForState(state, 'event.chat.presence');
      this.emitInvalidationForState(state, 'event.chat.stats');
    }
  }

  private emitInvalidation(eventId: string, name: string): void {
    this.emitInvalidationForState(this.getEvent(eventId), name, eventId);
  }

  private emitInvalidationForState(state: EventState, name: string, eventId?: string): void {
    const resolvedEventId = eventId ?? [...this.events.entries()].find(([, value]) => value === state)?.[0];
    if (!resolvedEventId) return;
    const now = this.clock();
    state.updates.next({
      id: `${resolvedEventId}-${now}-${++this.sequence}`,
      type: 'invalidate',
      data: JSON.stringify({ name, args: { eventId: resolvedEventId }, tsMs: now }),
    });
  }

  private readBoundedString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
    const result = value.trim();
    if (!result) throw new BadRequestException(`${field} is required`);
    if (result.length > maxLength) throw new BadRequestException(`${field} must be ${maxLength} characters or fewer`);
    return result;
  }

  private readRole(value: unknown): ChatRole {
    if (value === 'buyer' || value === 'seller') return value;
    throw new BadRequestException('role must be buyer or seller');
  }
}
