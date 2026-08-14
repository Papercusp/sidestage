import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { BuyerQuestionCopilotSubscriber, CopilotSyncQueries } from './copilot.module';
import type { CopilotProposalService } from './copilot.service';

describe('Copilot runtime composition', () => {
  it('registers event.copilot.proposals with the shared sync registry', async () => {
    const copilot = {
      list: vi.fn(async (eventId: string) => [{ id: 'p-1', eventId }]),
    } as unknown as CopilotProposalService;
    const queries = new SyncQueryRegistry();

    new CopilotSyncQueries(copilot, queries).onModuleInit();

    await expect(queries.resolve('event.copilot.proposals', { eventId: 'event-1' }))
      .resolves.toEqual([{ id: 'p-1', eventId: 'event-1' }]);
    expect(copilot.list).toHaveBeenCalledWith('event-1');
  });

  it('turns buyer questions into proposals without ingesting statements or seller replies', async () => {
    const chat = new ChatService();
    const copilot = {
      createFromChat: vi.fn(async () => ({ id: 'p-1' })),
    } as unknown as CopilotProposalService;
    const subscriber = new BuyerQuestionCopilotSubscriber(chat, copilot);
    subscriber.onModuleInit();

    const question = chat.addMessage('event-1', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: 'Is the blue mug available?',
    });
    chat.addMessage('event-1', {
      userId: 'buyer-1', displayName: 'Maya', role: 'buyer', text: 'The blue mug looks great.',
    });
    chat.addMessage('event-1', {
      userId: 'seller-1', displayName: 'Host', role: 'seller', text: 'It is still available.',
    });

    await vi.waitFor(() => expect(copilot.createFromChat).toHaveBeenCalledTimes(1));
    expect(copilot.createFromChat).toHaveBeenCalledWith(question);

    subscriber.onModuleDestroy();
    chat.addMessage('event-1', {
      userId: 'buyer-2', displayName: 'Noah', role: 'buyer', text: 'Can you ship it tomorrow?',
    });
    await Promise.resolve();
    expect(copilot.createFromChat).toHaveBeenCalledTimes(1);
  });
});
