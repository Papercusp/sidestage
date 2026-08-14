import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';

export type ChatRole = 'buyer' | 'seller';

export interface ChatMessage {
  id: string;
  eventId: string;
  userId: string;
  displayName: string;
  role: ChatRole;
  text: string;
  createdAt: string;
  grounding?: ChatGrounding;
  /** Mutation idempotency key; Copilot approval uses the proposal id. */
  clientRequestId?: string;
}

export interface ChatGrounding {
  status: 'answered' | 'seller-queue';
  sourceMessageId?: string;
  citation?: {
    transcriptId: string;
    label: string;
    quote: string;
    startMs?: number;
  };
}

export interface TranscriptMomentInput {
  text?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  productId?: unknown;
  productTitle?: unknown;
}

export interface TranscriptMoment {
  id: string;
  text: string;
  startMs?: number;
  endMs?: number;
  productId?: string;
  productTitle?: string;
}

export interface ReplayChapter {
  id: string;
  productId: string;
  productTitle: string;
  startMs: number;
  endMs?: number;
  previewText: string;
  evidenceKind?: 'condition';
  evidenceLabel?: string;
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
  clientRequestId?: unknown;
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
  transcript: TranscriptMoment[];
  presence: Map<string, ChatPresence>;
  updates: Subject<ChatSseEvent>;
  idempotentMessages: Map<string, ChatMessage>;
}

const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PRESENCE_TTL_MS = 35_000;
const MAX_MESSAGES = 200;
const MAX_TRANSCRIPT_MOMENTS = 200;
const MAX_USER_ID_LENGTH = 80;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 500;
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'could', 'does', 'from',
  'have', 'into', 'just', 'that', 'their', 'there', 'these', 'they', 'this',
  'what', 'when', 'where', 'which', 'with', 'would', 'your',
]);

const CONDITION_EVIDENCE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'Serial or model number', pattern: /\b(serial|model number|sku|identifier)\b/i },
  { label: 'Item tag or label', pattern: /\b(tag|label|maker(?:'s)? mark)\b/i },
  { label: 'Condition or flaw', pattern: /\b(flaw|scratch|dent|chip|crack|stain|wear|damage|defect|condition)\b/i },
];

export function conditionEvidenceLabel(text: string): string | undefined {
  return CONDITION_EVIDENCE_PATTERNS.find(({ pattern }) => pattern.test(text))?.label;
}

function questionTokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

export function isBuyerQuestion(value: string): boolean {
  return value.includes('?') || /^(what|when|where|who|why|how|is|are|does|do|can|could|will|would)\b/i.test(value.trim());
}

function citationLabel(startMs?: number): string {
  if (startMs === undefined) return 'Live transcript';
  const totalSeconds = Math.max(0, Math.floor(startMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `Stream ${minutes}:${seconds}`;
}

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
  private readonly messages = new Subject<ChatMessage>();
  private readonly clock = () => Date.now();
  private sequence = 0;

  constructor(
    @Optional()
    @Inject(SyncInvalidationService)
    private readonly syncInvalidations?: SyncInvalidationService,
  ) {}

  getMessages(eventId: string): ChatMessage[] {
    const state = this.getEvent(eventId);
    this.prunePresence(state);
    return state.messages.map((message) => ({ ...message }));
  }

  getTranscript(eventId: string): TranscriptMoment[] {
    return this.getEvent(eventId).transcript.map((moment) => ({ ...moment }));
  }

  messageEvents(): Observable<ChatMessage> {
    return this.messages.asObservable();
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

  getReplayChapters(eventId: string): ReplayChapter[] {
    const chapters: ReplayChapter[] = [];
    let activeChapter: ReplayChapter | undefined;
    for (const moment of this.getEvent(eventId).transcript) {
      if (!moment.productId || !moment.productTitle || moment.startMs === undefined) {
        activeChapter = undefined;
        continue;
      }
      const evidenceLabel = conditionEvidenceLabel(moment.text);
      if (activeChapter?.productId === moment.productId && !evidenceLabel) {
        activeChapter.endMs = moment.endMs ?? activeChapter.endMs;
        continue;
      }
      activeChapter = {
        id: moment.id,
        productId: moment.productId,
        productTitle: moment.productTitle,
        startMs: moment.startMs,
        endMs: moment.endMs,
        previewText: moment.text,
        evidenceKind: evidenceLabel ? 'condition' : undefined,
        evidenceLabel,
      };
      chapters.push(activeChapter);
    }
    return chapters;
  }

  addMessage(eventId: string, input: ChatMessageInput): ChatMessage {
    const state = this.getEvent(eventId);
    const userId = this.readBoundedString(input.userId, 'userId', MAX_USER_ID_LENGTH);
    const displayName = this.readBoundedString(input.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH);
    const text = this.readBoundedString(input.text, 'text', MAX_MESSAGE_LENGTH);
    const role = this.readRole(input.role);
    const clientRequestId = this.readOptionalBoundedString(input.clientRequestId, 'clientRequestId', 160);
    if (clientRequestId) {
      const existing = state.idempotentMessages.get(clientRequestId);
      if (existing) return { ...existing };
    }
    const now = this.clock();
    const message: ChatMessage = {
      id: `${eventId}-${++this.sequence}`,
      eventId,
      userId,
      displayName,
      role,
      text,
      createdAt: new Date(now).toISOString(),
      ...(clientRequestId ? { clientRequestId } : {}),
    };
    if (role === 'buyer' && isBuyerQuestion(text)) message.grounding = { status: 'seller-queue' };
    state.messages.push(message);
    if (clientRequestId) state.idempotentMessages.set(clientRequestId, message);

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
    this.messages.next({ ...message });
    return { ...message };
  }

  addTranscriptMoment(eventId: string, input: TranscriptMomentInput): TranscriptMoment {
    const state = this.getEvent(eventId);
    const text = this.readBoundedString(input.text, 'text', MAX_MESSAGE_LENGTH);
    const moment: TranscriptMoment = {
      id: `transcript-${eventId}-${++this.sequence}`,
      text,
      startMs: this.readOptionalMilliseconds(input.startMs, 'startMs'),
      endMs: this.readOptionalMilliseconds(input.endMs, 'endMs'),
      productId: this.readOptionalBoundedString(input.productId, 'productId', MAX_USER_ID_LENGTH),
      productTitle: this.readOptionalBoundedString(input.productTitle, 'productTitle', MAX_DISPLAY_NAME_LENGTH),
    };
    state.transcript.push(moment);
    if (state.transcript.length > MAX_TRANSCRIPT_MOMENTS) {
      state.transcript.splice(0, state.transcript.length - MAX_TRANSCRIPT_MOMENTS);
    }
    this.emitInvalidation(eventId, 'event.replay.chapters');
    return { ...moment };
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
      state = {
        messages: [],
        transcript: [],
        presence: new Map(),
        updates: new Subject<ChatSseEvent>(),
        idempotentMessages: new Map(),
      };
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
    this.syncInvalidations?.invalidate(name, { eventId: resolvedEventId });
    if (name === 'event.chat.presence') {
      // Viewer counts and live-room ordering are part of the unscoped guide.
      // Do not attach eventId: events.guide is cached under empty args.
      this.syncInvalidations?.invalidate('events.guide');
    }
    if (name === 'event.chat.stats') {
      this.syncInvalidations?.invalidate('event.stats', { eventId: resolvedEventId });
    }
  }

  private readBoundedString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
    const result = value.trim();
    if (!result) throw new BadRequestException(`${field} is required`);
    if (result.length > maxLength) throw new BadRequestException(`${field} must be ${maxLength} characters or fewer`);
    return result;
  }

  private readOptionalBoundedString(value: unknown, field: string, maxLength: number): string | undefined {
    if (value === undefined || value === null) return undefined;
    return this.readBoundedString(value, field, maxLength);
  }

  private readRole(value: unknown): ChatRole {
    if (value === 'buyer' || value === 'seller') return value;
    throw new BadRequestException('role must be buyer or seller');
  }

  private readOptionalMilliseconds(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new BadRequestException(`${field} must be a non-negative number`);
    }
    return Math.round(value);
  }
}
