import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Subject, type Observable } from 'rxjs';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import {
  classifyBuyerMessage,
  type BuyerMessageRouting,
} from './buyer-question-routing';
import { CHAT_STORE, InMemoryChatStore, type ChatMessagePage, type ChatStore } from './chat.store';

export { classifyBuyerMessage, isBuyerQuestion } from './buyer-question-routing';

export type ChatRole = 'buyer' | 'seller';
export interface ChatMessage { id: string; eventId: string; userId: string; displayName: string; role: ChatRole; text: string; createdAt: string; grounding?: ChatGrounding; clientRequestId?: string; }
export type ChatGroundingStatus = 'not-routed' | 'seller-queue' | 'answered' | 'skipped' | 'blocked';
export interface ChatGrounding {
  status: ChatGroundingStatus;
  route?: BuyerMessageRouting;
  sourceMessageId?: string;
  proposalId?: string;
  responseMessageId?: string;
  assistant?: {
    kind: 'copilot-assisted';
    approvedBy: string;
    edited: boolean;
    citationSourceIds: string[];
  };
  citation?: { transcriptId: string; label: string; quote: string; startMs?: number; };
}
export interface TranscriptMomentInput { text?: unknown; startMs?: unknown; endMs?: unknown; productId?: unknown; productTitle?: unknown; }
export interface TranscriptMoment { id: string; text: string; startMs?: number; endMs?: number; productId?: string; productTitle?: string; }
export interface ReplayChapter { id: string; productId: string; productTitle: string; startMs: number; endMs?: number; previewText: string; evidenceKind?: 'condition'; evidenceLabel?: string; }
export interface ChatPresence { userId: string; displayName: string; role: ChatRole; lastSeenAt: string; }
export interface ChatStats { activeUsers: number; buyers: number; sellers: number; totalMessages: number; }
export interface ChatMessageInput { userId?: unknown; displayName?: unknown; role?: unknown; text?: unknown; clientRequestId?: unknown; }
export interface CopilotReplyInput {
  actorId: string;
  text: string;
  proposalId: string;
  sourceMessageId: string;
  edited: boolean;
  citationSourceIds: readonly string[];
}
export interface CopilotQuestionStateInput {
  status: Extract<ChatGroundingStatus, 'seller-queue' | 'answered' | 'skipped' | 'blocked'>;
  proposalId: string;
  responseMessageId?: string;
}
export interface PresenceInput { userId?: unknown; displayName?: unknown; role?: unknown; }
export interface ChatSseEvent { id: string; type: 'heartbeat' | 'invalidate'; data: string; }
export interface ChatOperationalMetrics { messagesCreated: number; idempotentReplays: number; rejectedWrites: number; transcriptMomentsCreated: number; presenceTouches: number; presenceExpirySweeps: number; presenceRowsExpired: number; moderationActions: number; moderationMisses: number; lastPersistedAt?: string; }

const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PRESENCE_TTL_MS = 35_000;
const MAX_PAGE_SIZE = 100;
const MAX_TRANSCRIPT_MOMENTS = 200;
const MAX_USER_ID_LENGTH = 80;
const MAX_DISPLAY_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 500;
const COPILOT_QUEUE_PAGE_SIZE = 100;
const CONDITION_EVIDENCE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'Serial or model number', pattern: /\b(serial|model number|sku|identifier)\b/i },
  { label: 'Item tag or label', pattern: /\b(tag|label|maker(?:'s)? mark)\b/i },
  { label: 'Condition or flaw', pattern: /\b(flaw|scratch|dent|chip|crack|stain|wear|damage|defect|condition)\b/i },
];

export function conditionEvidenceLabel(text: string): string | undefined { return CONDITION_EVIDENCE_PATTERNS.find(({ pattern }) => pattern.test(text))?.label; }

@Injectable()
export class ChatService {
  private readonly updatesByEvent = new Map<string, Subject<ChatSseEvent>>();
  private readonly messages = new Subject<ChatMessage>();
  private readonly store: ChatStore;
  private readonly metrics: ChatOperationalMetrics = {
    messagesCreated: 0, idempotentReplays: 0, rejectedWrites: 0, transcriptMomentsCreated: 0,
    presenceTouches: 0, presenceExpirySweeps: 0, presenceRowsExpired: 0,
    moderationActions: 0, moderationMisses: 0,
  };
  private sequence = 0;

  constructor(
    @Optional() @Inject(SyncInvalidationService) private readonly syncInvalidations?: SyncInvalidationService,
    @Optional() @Inject(CHAT_STORE) store?: ChatStore,
  ) { this.store = store ?? new InMemoryChatStore(); }

  async getMessages(eventId: string, limit = MAX_PAGE_SIZE, cursor?: string): Promise<ChatMessage[]> {
    return (await this.getMessagesPage(eventId, limit, cursor)).items;
  }

  async getMessagesPage(eventId: string, limit = MAX_PAGE_SIZE, cursor?: string): Promise<{ items: ChatMessage[]; nextCursor?: string }> {
    this.assertEventId(eventId);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new BadRequestException(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
    const page: ChatMessagePage = await this.store.listMessages(eventId, limit, cursor ? this.decodeCursor(cursor) : undefined);
    return { items: page.items, ...(page.nextCursor ? { nextCursor: this.encodeCursor(page.nextCursor) } : {}) };
  }

  async getQueuedQuestions(eventId: string): Promise<ChatMessage[]> {
    this.assertEventId(eventId);
    const questions: ChatMessage[] = [];
    let cursor: { createdAt: string; id: string } | undefined;
    do {
      const page = await this.store.listQueuedQuestions(eventId, COPILOT_QUEUE_PAGE_SIZE, cursor);
      questions.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return questions;
  }

  async getTranscript(eventId: string): Promise<TranscriptMoment[]> {
    this.assertEventId(eventId);
    return this.store.listTranscript(eventId, MAX_TRANSCRIPT_MOMENTS);
  }

  messageEvents(): Observable<ChatMessage> { return this.messages.asObservable(); }

  async getPresence(eventId: string): Promise<ChatPresence[]> {
    this.assertEventId(eventId);
    return this.store.listPresence(eventId, new Date(Date.now() - PRESENCE_TTL_MS).toISOString());
  }

  async getStats(eventId: string): Promise<ChatStats> {
    const [presence, totalMessages] = await Promise.all([this.getPresence(eventId), this.store.countMessages(eventId)]);
    return { activeUsers: presence.length, buyers: presence.filter((entry) => entry.role === 'buyer').length, sellers: presence.filter((entry) => entry.role === 'seller').length, totalMessages };
  }

  async getReplayChapters(eventId: string): Promise<ReplayChapter[]> {
    const chapters: ReplayChapter[] = [];
    let activeChapter: ReplayChapter | undefined;
    for (const moment of await this.getTranscript(eventId)) {
      if (!moment.productId || !moment.productTitle || moment.startMs === undefined) { activeChapter = undefined; continue; }
      const evidenceLabel = conditionEvidenceLabel(moment.text);
      if (activeChapter?.productId === moment.productId && !evidenceLabel) { activeChapter.endMs = moment.endMs ?? activeChapter.endMs; continue; }
      activeChapter = { id: moment.id, productId: moment.productId, productTitle: moment.productTitle, startMs: moment.startMs, endMs: moment.endMs, previewText: moment.text, evidenceKind: evidenceLabel ? 'condition' : undefined, evidenceLabel };
      chapters.push(activeChapter);
    }
    return chapters;
  }

  async addMessage(eventId: string, input: ChatMessageInput): Promise<ChatMessage> {
    this.assertEventId(eventId);
    const userId = this.readBoundedString(input.userId, 'userId', MAX_USER_ID_LENGTH);
    const displayName = this.readBoundedString(input.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH);
    const text = this.readBoundedString(input.text, 'text', MAX_MESSAGE_LENGTH);
    const role = this.readRole(input.role);
    const clientRequestId = this.readOptionalBoundedString(input.clientRequestId, 'clientRequestId', 160);
    const message: ChatMessage = { id: `chat_${randomUUID()}`, eventId, userId, displayName, role, text, createdAt: new Date().toISOString(), ...(clientRequestId ? { clientRequestId } : {}) };
    if (role === 'buyer') {
      const route = classifyBuyerMessage(text);
      message.grounding = {
        status: route.destination === 'seller-review' ? 'seller-queue' : 'not-routed',
        route,
      };
    }
    return this.persistMessage(message);
  }

  async addCopilotReply(eventId: string, input: CopilotReplyInput): Promise<ChatMessage> {
    this.assertEventId(eventId);
    const actorId = this.readBoundedString(input.actorId, 'actorId', MAX_USER_ID_LENGTH);
    const proposalId = this.readBoundedString(input.proposalId, 'proposalId', 120);
    const sourceMessageId = this.readBoundedString(input.sourceMessageId, 'sourceMessageId', 120);
    const message: ChatMessage = {
      id: `chat_${randomUUID()}`,
      eventId,
      userId: actorId,
      displayName: 'Host',
      role: 'seller',
      text: this.readBoundedString(input.text, 'text', MAX_MESSAGE_LENGTH),
      createdAt: new Date().toISOString(),
      clientRequestId: `copilot-proposal:${proposalId}`,
      grounding: {
        status: 'answered',
        sourceMessageId,
        proposalId,
        assistant: {
          kind: 'copilot-assisted',
          approvedBy: actorId,
          edited: input.edited,
          citationSourceIds: [...new Set(input.citationSourceIds.filter(Boolean))],
        },
      },
    };
    return this.persistMessage(message);
  }

  async setCopilotQuestionState(
    eventId: string,
    messageId: string,
    input: CopilotQuestionStateInput,
  ): Promise<ChatMessage | undefined> {
    this.assertEventId(eventId);
    const updated = await this.store.patchMessageGrounding(eventId, messageId, {
      status: input.status,
      proposalId: input.proposalId,
      ...(input.responseMessageId ? { responseMessageId: input.responseMessageId } : {}),
    });
    if (updated) this.emitInvalidation(eventId, 'event.chat.messages');
    return updated;
  }

  private async persistMessage(message: ChatMessage): Promise<ChatMessage> {
    const persisted = await this.store.appendMessage(message);
    if (!persisted.created) { this.metrics.idempotentReplays += 1; return { ...persisted.message }; }
    this.metrics.messagesCreated += 1; this.metrics.lastPersistedAt = persisted.message.createdAt;
    this.emitInvalidation(message.eventId, 'event.chat.messages'); this.emitInvalidation(message.eventId, 'event.chat.presence'); this.emitInvalidation(message.eventId, 'event.chat.stats');
    this.messages.next({ ...persisted.message });
    return { ...persisted.message };
  }

  async addTranscriptMoment(eventId: string, input: TranscriptMomentInput): Promise<TranscriptMoment> {
    this.assertEventId(eventId);
    const moment: TranscriptMoment = { id: `transcript_${randomUUID()}`, text: this.readBoundedString(input.text, 'text', MAX_MESSAGE_LENGTH), startMs: this.readOptionalMilliseconds(input.startMs, 'startMs'), endMs: this.readOptionalMilliseconds(input.endMs, 'endMs'), productId: this.readOptionalBoundedString(input.productId, 'productId', MAX_USER_ID_LENGTH), productTitle: this.readOptionalBoundedString(input.productTitle, 'productTitle', MAX_DISPLAY_NAME_LENGTH) };
    const persisted = await this.store.appendTranscript(eventId, moment);
    this.metrics.transcriptMomentsCreated += 1; this.metrics.lastPersistedAt = new Date().toISOString();
    this.emitInvalidation(eventId, 'event.chat.transcript'); this.emitInvalidation(eventId, 'event.replay.chapters');
    return { ...persisted };
  }

  async touchPresence(eventId: string, input: PresenceInput): Promise<ChatPresence> {
    this.assertEventId(eventId);
    const presence = await this.store.touchPresence(eventId, { userId: this.readBoundedString(input.userId, 'userId', MAX_USER_ID_LENGTH), displayName: this.readBoundedString(input.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH), role: this.readRole(input.role), lastSeenAt: new Date().toISOString() });
    this.metrics.presenceTouches += 1; this.emitInvalidation(eventId, 'event.chat.presence'); this.emitInvalidation(eventId, 'event.chat.stats'); return presence;
  }

  /**
   * Expire every presence row older than the presence TTL, across all events,
   * and invalidate the surfaces that read them. Driven by ChatPresenceSweeper
   * so liveness is a property of the durable table rather than of whoever last
   * issued a REST presence read — the property a Zero/WebSocket client reading
   * `chat_presence` directly depends on.
   */
  async expireStalePresence(nowMs: number = Date.now()): Promise<string[]> {
    const cutoff = new Date(nowMs - PRESENCE_TTL_MS).toISOString();
    const eventIds = await this.store.expireStalePresence(cutoff);
    this.metrics.presenceExpirySweeps += 1;
    this.metrics.presenceRowsExpired += eventIds.length;
    for (const eventId of eventIds) {
      this.emitInvalidation(eventId, 'event.chat.presence');
      this.emitInvalidation(eventId, 'event.chat.stats');
    }
    return eventIds;
  }

  async removePresence(eventId: string, userId: string): Promise<void> {
    this.assertEventId(eventId);
    if (!await this.store.removePresence(eventId, this.readBoundedString(userId, 'userId', MAX_USER_ID_LENGTH))) return;
    this.emitInvalidation(eventId, 'event.chat.presence'); this.emitInvalidation(eventId, 'event.chat.stats');
  }

  async moderateMessage(eventId: string, messageId: string, moderatorId: string, reason: unknown): Promise<boolean> {
    this.assertEventId(eventId);
    const changed = await this.store.moderateMessage(eventId, this.readBoundedString(messageId, 'messageId', 120), this.readBoundedString(moderatorId, 'moderatorId', MAX_USER_ID_LENGTH), this.readBoundedString(reason, 'reason', 240));
    changed ? this.metrics.moderationActions += 1 : this.metrics.moderationMisses += 1;
    if (changed) { this.emitInvalidation(eventId, 'event.chat.messages'); this.emitInvalidation(eventId, 'event.chat.stats'); }
    return changed;
  }

  recordRejectedWrite(): void { this.metrics.rejectedWrites += 1; }
  getOperationalMetrics(): ChatOperationalMetrics { return { ...this.metrics }; }
  updates(eventId: string): Observable<ChatSseEvent> { this.assertEventId(eventId); return this.updatesFor(eventId).asObservable(); }

  private emitInvalidation(eventId: string, name: string): void {
    const now = Date.now();
    this.updatesFor(eventId).next({ id: `${eventId}-${now}-${++this.sequence}`, type: 'invalidate', data: JSON.stringify({ name, args: { eventId }, tsMs: now }) });
    this.syncInvalidations?.invalidate(name, { eventId });
    if (name === 'event.chat.presence') this.syncInvalidations?.invalidate('events.guide');
    if (name === 'event.chat.stats') this.syncInvalidations?.invalidate('event.stats', { eventId });
  }

  private updatesFor(eventId: string): Subject<ChatSseEvent> { let subject = this.updatesByEvent.get(eventId); if (!subject) { subject = new Subject(); this.updatesByEvent.set(eventId, subject); } return subject; }
  private assertEventId(eventId: string): void { if (!EVENT_ID_RE.test(eventId)) throw new BadRequestException('eventId must contain 1-64 letters, numbers, hyphens, or underscores'); }
  private encodeCursor(cursor: { createdAt: string; id: string }): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
  private decodeCursor(value: string): { createdAt: string; id: string } { try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown }; if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== 'string' || !parsed.id) throw new Error(); return { createdAt: parsed.createdAt, id: parsed.id }; } catch { throw new BadRequestException('cursor is invalid'); } }
  private readBoundedString(value: unknown, field: string, maxLength: number): string { if (typeof value !== 'string') throw new BadRequestException(`${field} is required`); const result = value.trim(); if (!result) throw new BadRequestException(`${field} is required`); if (result.length > maxLength) throw new BadRequestException(`${field} must be ${maxLength} characters or fewer`); return result; }
  private readOptionalBoundedString(value: unknown, field: string, maxLength: number): string | undefined { return value === undefined || value === null ? undefined : this.readBoundedString(value, field, maxLength); }
  private readRole(value: unknown): ChatRole { if (value === 'buyer' || value === 'seller') return value; throw new BadRequestException('role must be buyer or seller'); }
  private readOptionalMilliseconds(value: unknown, field: string): number | undefined { if (value === undefined || value === null) return undefined; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new BadRequestException(`${field} must be a non-negative number`); return Math.round(value); }
}
