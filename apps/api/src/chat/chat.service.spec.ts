import { describe, expect, it } from 'vitest';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { EventService, InMemoryEventStore } from '../events/event.service';
import { ChatSyncQueries } from './chat.module';
import { ChatService } from './chat.service';

describe('ChatService', () => {
  it('stores a message, upserts its presence, and emits sync invalidations', async () => {
    const sharedInvalidations = new SyncInvalidationService();
    const service = new ChatService(sharedInvalidations);
    const events: string[] = [];
    const sharedEvents: string[] = [];
    service.updates('demo-event').subscribe((event) => {
      events.push(JSON.parse(event.data).name as string);
    });
    sharedInvalidations.events().subscribe((event) => sharedEvents.push(event.name));

    const message = await service.addMessage('demo-event', {
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
    expect(await service.getMessages('demo-event')).toEqual([message]);
    expect(await service.getPresence('demo-event')).toHaveLength(1);
    expect(await service.getStats('demo-event')).toEqual({ activeUsers: 1, buyers: 1, sellers: 0, totalMessages: 1 });
    expect(events).toEqual(['event.chat.messages', 'event.chat.presence', 'event.chat.stats']);
    expect(sharedEvents).toEqual([
      'event.chat.messages',
      'event.chat.presence',
      'events.guide',
      'event.chat.stats',
      'event.stats',
    ]);
  });

  it('registers chat, transcript, and replay reads with the shared sync query registry', async () => {
    const service = new ChatService();
    const queries = new SyncQueryRegistry();
    const ownership = new EventOwnershipGuard(new EventService(
      new InMemoryEventStore([{
        eventId: 'demo-event',
        title: 'Demo event',
        sellerId: 'seller-demo',
        sellerName: 'Demo seller',
        status: 'live',
        startsAt: null,
        endedAt: null,
      }]),
      service,
    ));
    new ChatSyncQueries(service, queries, ownership).onModuleInit();
    await service.addMessage('demo-event', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: 'Hello host',
    });
    const transcript = await service.addTranscriptMoment('demo-event', {
      text: 'The glaze is food safe.',
      startMs: 12_000,
    });

    await expect(queries.resolve('event.chat.messages', { eventId: 'demo-event' })).resolves.toHaveLength(1);
    await expect(queries.resolve(
      'event.chat.transcript',
      { eventId: 'demo-event' },
      { principal: 'seller-demo' },
    )).resolves.toEqual([transcript]);
    await expect(queries.resolve(
      'event.chat.transcript',
      { eventId: 'demo-event' },
      { principal: 'seller-other' },
    )).rejects.toThrow('Event not found for this seller.');
    await expect(queries.resolve('event.chat.stats', { eventId: 'demo-event' })).resolves.toEqual([
      { activeUsers: 1, buyers: 1, sellers: 0, totalMessages: 1 },
    ]);
    await expect(queries.resolve('event.replay.chapters', { eventId: 'demo-event' })).resolves.toEqual([]);
  });

  it('queues buyer questions for Copilot without auto-sending a transcript quote', async () => {
    const service = new ChatService();
    const observed: string[] = [];
    service.messageEvents().subscribe((message) => observed.push(message.id));
    await service.addTranscriptMoment('demo-event', {
      text: 'The Aurora cup is dishwasher safe and made in Portugal.',
      startMs: 83_000,
    });

    const question = await service.addMessage('demo-event', {
      userId: 'buyer-1',
      displayName: 'Maya',
      role: 'buyer',
      text: 'Is the Aurora cup dishwasher safe?',
    });
    const messages = await service.getMessages('demo-event');

    expect(question.grounding).toEqual({ status: 'seller-queue' });
    expect(messages).toEqual([question]);
    expect(observed).toEqual([question.id]);
    expect(await service.getTranscript('demo-event')).toEqual([
      expect.objectContaining({ text: expect.stringContaining('dishwasher safe'), startMs: 83_000 }),
    ]);
    expect((await service.getStats('demo-event')).totalMessages).toBe(1);
  });

  it('deduplicates Copilot-approved messages by client request id', async () => {
    const service = new ChatService();
    const observed: string[] = [];
    service.messageEvents().subscribe((message) => observed.push(message.id));

    const first = await service.addMessage('demo-event', {
      userId: 'seller-1', displayName: 'Host', role: 'seller', text: 'The cup is available.',
      clientRequestId: 'copilot-proposal:p-1',
    });
    const retry = await service.addMessage('demo-event', {
      userId: 'seller-1', displayName: 'Host', role: 'seller', text: 'The cup is available.',
      clientRequestId: 'copilot-proposal:p-1',
    });

    expect(retry).toEqual(first);
    expect(await service.getMessages('demo-event')).toEqual([first]);
    expect(observed).toEqual([first.id]);
  });

  it('indexes product-tagged transcript moments as replay chapters and invalidates sync', async () => {
    const service = new ChatService();
    const events: string[] = [];
    service.updates('demo-event').subscribe((event) => {
      events.push(JSON.parse(event.data).name as string);
    });

    await service.addTranscriptMoment('demo-event', {
      text: 'Here is the hand-painted detail on the Aurora cup.',
      startMs: 83_000,
      endMs: 98_000,
      productId: 'aurora-cup',
      productTitle: 'Aurora cup',
    });
    await service.addTranscriptMoment('demo-event', {
      text: 'The base carries the same glaze.',
      startMs: 99_000,
      endMs: 105_000,
      productId: 'aurora-cup',
      productTitle: 'Aurora cup',
    });
    await service.addTranscriptMoment('demo-event', {
      text: 'This general update is not tied to a listing.',
      startMs: 106_000,
    });

    expect(await service.getReplayChapters('demo-event')).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^transcript_/),
      productId: 'aurora-cup',
      productTitle: 'Aurora cup',
      startMs: 83_000,
      endMs: 105_000,
      previewText: 'Here is the hand-painted detail on the Aurora cup.',
    })]);
    expect(events).toEqual([
      'event.chat.transcript',
      'event.replay.chapters',
      'event.chat.transcript',
      'event.replay.chapters',
      'event.chat.transcript',
      'event.replay.chapters',
    ]);
  });

  it('preserves condition disclosures as distinct provenance chapters', async () => {
    const service = new ChatService();
    await service.addTranscriptMoment('demo-event', {
      text: 'Here is the Aurora cup from every angle.', startMs: 10_000, endMs: 18_000,
      productId: 'aurora-cup', productTitle: 'Aurora cup',
    });
    await service.addTranscriptMoment('demo-event', {
      text: 'This tag shows serial AC-2048.', startMs: 19_000, endMs: 24_000,
      productId: 'aurora-cup', productTitle: 'Aurora cup',
    });
    await service.addTranscriptMoment('demo-event', {
      text: 'There is a small scratch on the base.', startMs: 25_000, endMs: 31_000,
      productId: 'aurora-cup', productTitle: 'Aurora cup',
    });

    expect(await service.getReplayChapters('demo-event')).toEqual([
      expect.objectContaining({ startMs: 10_000, evidenceKind: undefined }),
      expect.objectContaining({ startMs: 19_000, evidenceKind: 'condition', evidenceLabel: 'Serial or model number' }),
      expect.objectContaining({ startMs: 25_000, evidenceKind: 'condition', evidenceLabel: 'Condition or flaw' }),
    ]);
  });

  it('rejects blank or oversized messages before mutating state', async () => {
    const service = new ChatService();
    await expect(service.addMessage('demo-event', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: '   ',
    })).rejects.toThrow('text is required');
    expect(await service.getMessages('demo-event')).toEqual([]);
  });

  it('removes a viewer and emits presence/stat updates', async () => {
    const service = new ChatService();
    const events: string[] = [];
    service.updates('demo-event').subscribe((event) => {
      events.push(JSON.parse(event.data).name as string);
    });
    await service.touchPresence('demo-event', { userId: 'seller-1', displayName: 'Host', role: 'seller' });
    await service.removePresence('demo-event', 'seller-1');

    expect(await service.getPresence('demo-event')).toEqual([]);
    expect(events.slice(-2)).toEqual(['event.chat.presence', 'event.chat.stats']);
  });

  it('invalidates the unscoped event guide whenever presence changes', async () => {
    const invalidations = new SyncInvalidationService();
    const service = new ChatService(invalidations);
    const guideEvents: Array<{ name: string; args?: Record<string, unknown> }> = [];
    invalidations.events().subscribe((event) => {
      if (event.name === 'events.guide') guideEvents.push(event);
    });

    await service.touchPresence('demo-event', { userId: 'buyer-1', displayName: 'Maya', role: 'buyer' });
    await service.removePresence('demo-event', 'buyer-1');

    expect(guideEvents).toEqual([
      { name: 'events.guide', tsMs: expect.any(Number) },
      { name: 'events.guide', tsMs: expect.any(Number) },
    ]);
    expect(guideEvents.every((event) => event.args === undefined)).toBe(true);
  });
});
