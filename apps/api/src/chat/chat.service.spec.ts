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
    });
    expect(service.getMessages('demo-event')).toEqual([message]);
    expect(service.getPresence('demo-event')).toHaveLength(1);
    expect(service.getStats('demo-event')).toEqual({ activeUsers: 1, buyers: 1, sellers: 0, totalMessages: 1 });
    expect(events).toEqual(['event.chat.messages', 'event.chat.presence', 'event.chat.stats']);
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
