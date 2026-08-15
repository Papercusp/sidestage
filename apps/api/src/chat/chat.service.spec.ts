import { describe, expect, it } from 'vitest';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { EventVisibilityGuard } from '../events/event-visibility.guard';
import { InMemoryEventStore } from '../events/event.service';
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
    const eventStore = new InMemoryEventStore([{
        eventId: 'demo-event',
        title: 'Demo event',
        sellerId: 'seller-demo',
        sellerName: 'Demo seller',
        status: 'live',
        startsAt: null,
        endedAt: null,
      }, {
        eventId: 'draft-event',
        title: 'Private draft',
        sellerId: 'seller-demo',
        sellerName: 'Demo seller',
        status: 'draft',
        startsAt: null,
        endedAt: null,
    }]);
    const visibility = new EventVisibilityGuard(eventStore);
    new ChatSyncQueries(service, queries, visibility).onModuleInit();
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
      { principal: 'buyer-demo' },
    )).resolves.toEqual([transcript]);
    await expect(queries.resolve(
      'event.chat.transcript',
      { eventId: 'draft-event' },
      { principal: 'seller-demo' },
    )).rejects.toThrow('Unknown event: draft-event');
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

    expect(question.grounding).toEqual({
      status: 'seller-queue',
      route: {
        version: 1,
        destination: 'seller-review',
        category: 'general',
        signal: 'question-opener',
      },
    });
    expect(messages).toEqual([question]);
    expect(observed).toEqual([question.id]);
    expect(await service.getTranscript('demo-event')).toEqual([
      expect.objectContaining({ text: expect.stringContaining('dishwasher safe'), startMs: 83_000 }),
    ]);
    expect((await service.getStats('demo-event')).totalMessages).toBe(1);
  });

  it('persists one structured routing decision and excludes social questions from Copilot', async () => {
    const service = new ChatService();
    const routed = await Promise.all([
      service.addMessage('demo-event', {
        userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: 'How many blue mugs are left?',
      }),
      service.addMessage('demo-event', {
        userId: 'buyer-2', displayName: 'Noah', role: 'buyer', text: 'Please reserve this for me',
      }),
    ]);
    const social = await service.addMessage('demo-event', {
      userId: 'buyer-3', displayName: 'Priya', role: 'buyer', text: 'Are you ready?',
    });
    const statement = await service.addMessage('demo-event', {
      userId: 'buyer-4', displayName: 'Eli', role: 'buyer', text: 'The blue mug looks great.',
    });

    expect(routed.map((message) => message.grounding?.route?.category)).toEqual(['availability', 'commerce']);
    expect(routed.map((message) => message.grounding?.status)).toEqual(['seller-queue', 'seller-queue']);
    expect(social.grounding).toMatchObject({
      status: 'not-routed',
      route: { destination: 'none', category: 'social', signal: 'social-question' },
    });
    expect(statement.grounding).toMatchObject({
      status: 'not-routed',
      route: { destination: 'none', signal: 'not-a-question' },
    });
    expect(await service.getQueuedQuestions('demo-event')).toEqual(routed);
  });

  it('updates a source question lifecycle without losing its routing decision', async () => {
    const service = new ChatService();
    const question = await service.addMessage('demo-event', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: 'Is the blue mug available?',
    });

    await service.setCopilotQuestionState('demo-event', question.id, {
      status: 'answered',
      proposalId: 'proposal-1',
      responseMessageId: 'reply-1',
    });

    expect((await service.getMessages('demo-event'))[0]?.grounding).toMatchObject({
      status: 'answered',
      proposalId: 'proposal-1',
      responseMessageId: 'reply-1',
      route: { destination: 'seller-review', category: 'availability' },
    });
    expect(await service.getQueuedQuestions('demo-event')).toEqual([]);
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
