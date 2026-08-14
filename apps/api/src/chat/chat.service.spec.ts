import { describe, expect, it } from 'vitest';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { ChatSyncQueries } from './chat.module';
import { ChatService } from './chat.service';

describe('ChatService', () => {
  it('stores a message, upserts its presence, and emits sync invalidations', () => {
    const sharedInvalidations = new SyncInvalidationService();
    const service = new ChatService(sharedInvalidations);
    const events: string[] = [];
    const sharedEvents: string[] = [];
    service.updates('demo-event').subscribe((event) => {
      events.push(JSON.parse(event.data).name as string);
    });
    sharedInvalidations.events().subscribe((event) => sharedEvents.push(event.name));

    const message = service.addMessage('demo-event', {
      userId: 'buyer-1',
      displayName: 'Maya',
      role: 'buyer',
      text: 'Is this available in blue?',
    });

    expect(message).toMatchObject({
      eventId: 'demo-event',
      userId: 'buyer-1',
      displayName: 'Maya',
      role: 'buyer',
      text: 'Is this available in blue?',
      grounding: { status: 'seller-queue' },
    });
    expect(service.getMessages('demo-event')).toEqual([message]);
    expect(service.getPresence('demo-event')).toHaveLength(1);
    expect(service.getStats('demo-event')).toEqual({ activeUsers: 1, buyers: 1, sellers: 0, totalMessages: 1 });
    expect(events).toEqual(['event.chat.messages', 'event.chat.presence', 'event.chat.stats']);
    expect(sharedEvents).toEqual([
      'event.chat.messages',
      'event.chat.presence',
      'events.guide',
      'event.chat.stats',
      'event.stats',
    ]);
  });

  it('registers chat and replay reads with the shared sync query registry', async () => {
    const service = new ChatService();
    const queries = new SyncQueryRegistry();
    new ChatSyncQueries(service, queries).onModuleInit();
    service.addMessage('demo-event', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: 'Hello host',
    });

    await expect(queries.resolve('event.chat.messages', { eventId: 'demo-event' })).resolves.toHaveLength(1);
    await expect(queries.resolve('event.chat.stats', { eventId: 'demo-event' })).resolves.toEqual([
      { activeUsers: 1, buyers: 1, sellers: 0, totalMessages: 1 },
    ]);
    await expect(queries.resolve('event.replay.chapters', { eventId: 'demo-event' })).resolves.toEqual([]);
  });

  it('answers from the closest transcript moment and cites the stream timestamp', () => {
    const service = new ChatService();
    service.addTranscriptMoment('demo-event', {
      text: 'The Aurora cup is dishwasher safe and made in Portugal.',
      startMs: 83_000,
    });

    const question = service.addMessage('demo-event', {
      userId: 'buyer-1',
      displayName: 'Maya',
      role: 'buyer',
      text: 'Is the Aurora cup dishwasher safe?',
    });
    const messages = service.getMessages('demo-event');

    expect(question.grounding).toMatchObject({
      status: 'answered',
      citation: { label: 'Stream 1:23' },
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      displayName: 'SideStage copilot',
      role: 'seller',
      grounding: {
        status: 'answered',
        sourceMessageId: question.id,
        citation: { label: 'Stream 1:23' },
      },
    });
    expect(messages[1]?.text).toContain('dishwasher safe');
    expect(service.getStats('demo-event').totalMessages).toBe(2);
  });

  it('indexes product-tagged transcript moments as replay chapters and invalidates sync', () => {
    const service = new ChatService();
    const events: string[] = [];
    service.updates('demo-event').subscribe((event) => {
      events.push(JSON.parse(event.data).name as string);
    });

    service.addTranscriptMoment('demo-event', {
      text: 'Here is the hand-painted detail on the Aurora cup.',
      startMs: 83_000,
      endMs: 98_000,
      productId: 'aurora-cup',
      productTitle: 'Aurora cup',
    });
    service.addTranscriptMoment('demo-event', {
      text: 'The base carries the same glaze.',
      startMs: 99_000,
      endMs: 105_000,
      productId: 'aurora-cup',
      productTitle: 'Aurora cup',
    });
    service.addTranscriptMoment('demo-event', {
      text: 'This general update is not tied to a listing.',
      startMs: 106_000,
    });

    expect(service.getReplayChapters('demo-event')).toEqual([{
      id: expect.stringMatching(/^transcript-demo-event-/),
      productId: 'aurora-cup',
      productTitle: 'Aurora cup',
      startMs: 83_000,
      endMs: 105_000,
      previewText: 'Here is the hand-painted detail on the Aurora cup.',
    }]);
    expect(events).toEqual([
      'event.replay.chapters',
      'event.replay.chapters',
      'event.replay.chapters',
    ]);
  });

  it('preserves condition disclosures as distinct provenance chapters', () => {
    const service = new ChatService();
    service.addTranscriptMoment('demo-event', {
      text: 'Here is the Aurora cup from every angle.', startMs: 10_000, endMs: 18_000,
      productId: 'aurora-cup', productTitle: 'Aurora cup',
    });
    service.addTranscriptMoment('demo-event', {
      text: 'This tag shows serial AC-2048.', startMs: 19_000, endMs: 24_000,
      productId: 'aurora-cup', productTitle: 'Aurora cup',
    });
    service.addTranscriptMoment('demo-event', {
      text: 'There is a small scratch on the base.', startMs: 25_000, endMs: 31_000,
      productId: 'aurora-cup', productTitle: 'Aurora cup',
    });

    expect(service.getReplayChapters('demo-event')).toEqual([
      expect.objectContaining({ startMs: 10_000, evidenceKind: undefined }),
      expect.objectContaining({ startMs: 19_000, evidenceKind: 'condition', evidenceLabel: 'Serial or model number' }),
      expect.objectContaining({ startMs: 25_000, evidenceKind: 'condition', evidenceLabel: 'Condition or flaw' }),
    ]);
  });

  it('rejects blank or oversized messages before mutating state', () => {
    const service = new ChatService();
    expect(() => service.addMessage('demo-event', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: '   ',
    })).toThrow('text is required');
    expect(service.getMessages('demo-event')).toEqual([]);
  });

  it('removes a viewer and emits presence/stat updates', () => {
    const service = new ChatService();
    const events: string[] = [];
    service.updates('demo-event').subscribe((event) => {
      events.push(JSON.parse(event.data).name as string);
    });
    service.touchPresence('demo-event', { userId: 'seller-1', displayName: 'Host', role: 'seller' });
    service.removePresence('demo-event', 'seller-1');

    expect(service.getPresence('demo-event')).toEqual([]);
    expect(events.slice(-2)).toEqual(['event.chat.presence', 'event.chat.stats']);
  });

  it('invalidates the unscoped event guide whenever presence changes', () => {
    const invalidations = new SyncInvalidationService();
    const service = new ChatService(invalidations);
    const guideEvents: Array<{ name: string; args?: Record<string, unknown> }> = [];
    invalidations.events().subscribe((event) => {
      if (event.name === 'events.guide') guideEvents.push(event);
    });

    service.touchPresence('demo-event', { userId: 'buyer-1', displayName: 'Maya', role: 'buyer' });
    service.removePresence('demo-event', 'buyer-1');

    expect(guideEvents).toEqual([
      { name: 'events.guide', tsMs: expect.any(Number) },
      { name: 'events.guide', tsMs: expect.any(Number) },
    ]);
    expect(guideEvents.every((event) => event.args === undefined)).toBe(true);
  });
});
