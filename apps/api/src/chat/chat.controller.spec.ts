import { describe, expect, it } from 'vitest';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

describe('ChatController', () => {
  it('accepts seller transcript moments for grounded chat answers', () => {
    const service = new ChatService();
    const controller = new ChatController(service);
    const moment = controller.addTranscriptMoment('demo-event', {
      text: 'Shipping takes two business days.',
      startMs: 12_000,
    });

    expect(moment).toMatchObject({ text: 'Shipping takes two business days.', startMs: 12_000 });
    expect(service.addMessage('demo-event', {
      userId: 'buyer-1',
      displayName: 'Maya',
      role: 'buyer',
      text: 'How long does shipping take?',
    }).grounding).toMatchObject({ status: 'answered' });
  });

  it('accepts product-tagged transcript moments through the legacy REST route', () => {
    const service = new ChatService();
    const controller = new ChatController(service);
    const moment = controller.addTranscriptMoment('demo-event', {
      text: 'The Aurora cup glaze catches the light here.',
      startMs: 24_000,
      productId: 'aurora-cup',
      productTitle: 'Aurora cup',
    });

    expect(moment).toMatchObject({ productId: 'aurora-cup', productTitle: 'Aurora cup', startMs: 24_000 });
    expect(service.getReplayChapters('demo-event')).toEqual([
      expect.objectContaining({ productId: 'aurora-cup', productTitle: 'Aurora cup', startMs: 24_000 }),
    ]);
  });
});
