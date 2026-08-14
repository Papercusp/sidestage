import { describe, expect, it } from 'vitest';
import { ChatService } from './chat.service';

describe('ChatService', () => {
  it('stores a message, upserts its presence, and emits sync invalidations', () => {
    const service = new ChatService();
    const events: string[] = [];
    service.updates('demo-event').subscribe((event) => {
      events.push(JSON.parse(event.data).name as string);
    });

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
});
