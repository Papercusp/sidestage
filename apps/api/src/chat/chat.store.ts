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
  appendMessage(message: ChatMessage): Promise<AppendMessageResult>;
  listTranscript(eventId: string, limit: number): Promise<TranscriptMoment[]>;
  appendTranscript(eventId: string, moment: TranscriptMoment): Promise<TranscriptMoment>;
  listPresence(eventId: string, cutoffIso: string): Promise<ChatPresence[]>;
  touchPresence(eventId: string, presence: ChatPresence): Promise<ChatPresence>;
  removePresence(eventId: string, userId: string): Promise<boolean>;
  countMessages(eventId: string): Promise<number>;
  moderateMessage(eventId: string, messageId: string, moderatorId: string, reason: string): Promise<boolean>;
}

interface MemoryEvent {
  messages: ChatMessage[];
  transcript: TranscriptMoment[];
  presence: Map<string, ChatPresence>;
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

  async listTranscript(eventId: string, limit: number): Promise<TranscriptMoment[]> {
    return this.event(eventId).transcript.slice(-limit).map((moment) => ({ ...moment }));
  }

  async appendTranscript(eventId: string, moment: TranscriptMoment): Promise<TranscriptMoment> {
    this.event(eventId).transcript.push({ ...moment });
    return { ...moment };
  }

  async listPresence(eventId: string, cutoffIso: string): Promise<ChatPresence[]> {
    const state = this.event(eventId);
    for (const [userId, presence] of state.presence) {
      if (presence.lastSeenAt < cutoffIso) state.presence.delete(userId);
    }
    return [...state.presence.values()].map((presence) => ({ ...presence }));
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
