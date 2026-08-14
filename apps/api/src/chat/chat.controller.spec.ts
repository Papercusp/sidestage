import { describe, expect, it, vi } from 'vitest';
import { AuctionAccessService } from '../auction/auction-access.service';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { EventService, InMemoryEventStore } from '../events/event.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import type { ConfiguredProductFocusClassifier } from './product-focus.classifier';

function ownership(chat: ChatService): EventOwnershipGuard {
  return new EventOwnershipGuard(new EventService(
    new InMemoryEventStore([{
      eventId: 'demo-event',
      title: 'Demo event',
      sellerId: 'seller-demo',
      sellerName: 'Demo seller',
      status: 'live',
      startsAt: null,
      endedAt: null,
    }]),
    chat,
  ));
}

describe('ChatController', () => {
  it('accepts seller transcript moments while queuing buyer questions for Copilot review', async () => {
    const service = new ChatService();
    const controller = new ChatController(
      service,
      {} as ConfiguredProductFocusClassifier,
      new AuctionAccessService(),
      ownership(service),
    );
    const moment = await controller.addTranscriptMoment('demo-event', {
      text: 'Shipping takes two business days.',
      startMs: 12_000,
    }, {
      authorization: 'Bearer sidestage-local-seller-token',
      'x-demo-principal': 'seller-demo',
    }, '127.0.0.1');

    expect(moment).toMatchObject({ text: 'Shipping takes two business days.', startMs: 12_000 });
    expect((await service.addMessage('demo-event', {
      userId: 'buyer-1',
      displayName: 'Maya',
      role: 'buyer',
      text: 'How long does shipping take?',
    })).grounding).toEqual({ status: 'seller-queue' });
    expect(await service.getTranscript('demo-event')).toEqual([moment]);
  });

  it('accepts product-tagged transcript moments through the legacy REST route', async () => {
    const service = new ChatService();
    const controller = new ChatController(
      service,
      {} as ConfiguredProductFocusClassifier,
      new AuctionAccessService(),
      ownership(service),
    );
    const moment = await controller.addTranscriptMoment('demo-event', {
      text: 'The Aurora cup glaze catches the light here.',
      startMs: 24_000,
      productId: 'aurora-cup',
      productTitle: 'Aurora cup',
    }, {
      authorization: 'Bearer sidestage-local-seller-token',
      'x-demo-principal': 'seller-demo',
    }, '127.0.0.1');

    expect(moment).toMatchObject({ productId: 'aurora-cup', productTitle: 'Aurora cup', startMs: 24_000 });
    expect(await service.getReplayChapters('demo-event')).toEqual([
      expect.objectContaining({ productId: 'aurora-cup', productTitle: 'Aurora cup', startMs: 24_000 }),
    ]);
  });

  it('routes product-focus classification through the fail-safe classifier seam', async () => {
    const service = new ChatService();
    const classify = vi.fn(async () => ({
      decision: 'different' as const,
      productId: 'hoodie',
      confidence: 0.93,
      evidenceSegmentIds: ['segment-1'],
      requestSequence: 4,
      source: 'model' as const,
    }));
    const controller = new ChatController(
      service,
      { classify } as unknown as ConfiguredProductFocusClassifier,
      new AuctionAccessService(),
      ownership(service),
    );
    const input = {
      activeProductId: 'mug',
      requestSequence: 4,
      transcriptWindow: [{ id: 'segment-1', text: 'Moving on to the hoodie.' }],
      products: [{ id: 'mug', label: 'Mug' }, { id: 'hoodie', label: 'Hoodie' }],
    };

    await expect(controller.classifyTranscriptProductFocus(
      'demo-event',
      input,
      {
        authorization: 'Bearer sidestage-local-seller-token',
        'x-demo-principal': 'seller-demo',
      },
      '127.0.0.1',
    )).resolves.toMatchObject({
      decision: 'different', productId: 'hoodie', requestSequence: 4,
    });
    expect(classify).toHaveBeenCalledWith(input);
  });

  it('owner-checks seller writes while leaving buyer chat writes public', async () => {
    const service = new ChatService();
    const controller = new ChatController(
      service,
      {} as ConfiguredProductFocusClassifier,
      new AuctionAccessService(),
      ownership(service),
    );

    await expect(controller.sendMessage(
      'demo-event',
      { userId: 'forged', displayName: 'Host', role: 'seller', text: 'Seller update' },
      {
        authorization: 'Bearer sidestage-local-seller-token',
        'x-demo-principal': 'seller-other',
      },
      '127.0.0.1',
    )).rejects.toThrow('Event not found for this seller.');
    await expect(controller.sendMessage(
      'demo-event',
      { userId: 'buyer-one', displayName: 'Buyer', role: 'seller', text: 'Hello' },
      {},
      '127.0.0.1',
    )).resolves.toMatchObject({ userId: 'buyer-one', role: 'buyer' });
  });
});
