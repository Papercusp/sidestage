import { describe, expect, it } from 'vitest';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

describe('ChatController sync contract', () => {
  it('returns index-aligned rows for the shared sync batch endpoint', () => {
    const service = new ChatService();
    const controller = new ChatController(service);
    service.addMessage('demo-event', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: 'Hello host',
    });

    const response = controller.restQueryBatch({
      queries: [
        { name: 'event.chat.messages', args: { eventId: 'demo-event' } },
        { name: 'event.chat.stats', args: { eventId: 'demo-event' } },
      ],
    });

    expect(response.results).toHaveLength(2);
    expect(response.results[0]?.rows).toHaveLength(1);
    expect(response.results[1]?.rows).toEqual([{ activeUsers: 1, buyers: 1, sellers: 0, totalMessages: 1 }]);
  });

  it('returns a typed query error instead of shifting batch positions', () => {
    const controller = new ChatController(new ChatService());
    const response = controller.restQueryBatch({
      queries: [
        { name: 'event.chat.unknown', args: { eventId: 'demo-event' } },
        { name: 'event.chat.presence', args: { eventId: 'demo-event' } },
      ],
    });

    expect(response.results[0]?.error).toContain('unknown sync query');
    expect(response.results[1]).toMatchObject({ rows: [], error: undefined });
  });
});
