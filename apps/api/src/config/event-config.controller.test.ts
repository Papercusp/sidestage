import { describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { EventController } from '../events/event.controller';
import { EventService, InMemoryEventStore } from '../events/event.service';
import type { PolicyService } from '../policies/policy.service';
import type { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { EventConfigController } from './event-config.controller';
import { EventConfigService, InMemoryEventConfigStore } from './event-config.service';

/**
 * The regression test for EI-20426845001666103 (P-014): the seller create flow
 * PUTs /events/:id/config, and before the fix NOTHING on that path wrote the
 * event-directory row — the created event was reachable by direct link but
 * never appeared in the buyer Channel Guide (GET /events stayed []).
 *
 * This exercises the real controller objects end to end over the in-memory
 * stores: one config PUT, then the collection read the buyer client calls.
 */
describe('create → GET /events (EI-20426845001666103 / P-014)', () => {
  function build() {
    const events = new EventService(new InMemoryEventStore([]), new ChatService());
    const invalidated: string[] = [];
    const controller = new EventConfigController(
      new EventConfigService(new InMemoryEventConfigStore()),
      { effectiveCopilotPolicy: async () => null } as unknown as PolicyService,
      {
        invalidate: (key: string) => {
          invalidated.push(key);
        },
      } as unknown as SyncInvalidationService,
      events,
    );
    return { events, controller, invalidated };
  }

  it('one config PUT makes the event appear in the buyer guide with its thumbnail', async () => {
    const { events, controller, invalidated } = build();

    await controller.put(
      'acceptance-dock-thumbnail-2026-08-14',
      {
        name: 'Acceptance dock thumbnail',
        thumbnailUrl: 'data:image/png;base64,AAAA',
      },
      'seller-acceptance',
      'Acceptance Studio',
    );

    const guide = await new EventController(events, {
      invalidate: () => undefined,
    } as unknown as SyncInvalidationService).list();
    expect(guide.events).toHaveLength(1);
    expect(guide.events[0]).toMatchObject({
      eventId: 'acceptance-dock-thumbnail-2026-08-14',
      title: 'Acceptance dock thumbnail',
      sellerId: 'seller-acceptance',
      sellerName: 'Acceptance Studio',
      status: 'scheduled',
      thumbnailUrl: 'data:image/png;base64,AAAA',
    });
    expect(invalidated).toEqual(['event.config', 'events.guide', 'events.mine']);
  });

  it('a follow-up rename PUT updates the guide row without duplicating it', async () => {
    const { events, controller } = build();

    await controller.put('my-drop', { name: 'My drop' }, 'seller-renamer', 'Rename Studio');
    await controller.put('my-drop', { name: 'My renamed drop' }, 'seller-renamer', 'Rename Studio');

    const guide = await new EventController(events, {
      invalidate: () => undefined,
    } as unknown as SyncInvalidationService).list();
    expect(guide.events).toHaveLength(1);
    expect(guide.events[0]?.title).toBe('My renamed drop');
  });

  it('publishes independently identified sellers together with their own display identities', async () => {
    const { events, controller } = build();

    await controller.put('alpha-drop', { name: 'Alpha drop' }, 'seller-alpha', 'Alpha Atelier');
    await controller.put('beta-drop', { name: 'Beta drop' }, 'seller-beta', 'Beta Bazaar');

    const guide = await new EventController(events, {
      invalidate: () => undefined,
    } as unknown as SyncInvalidationService).list();
    expect(guide.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventId: 'alpha-drop',
        sellerId: 'seller-alpha',
        sellerName: 'Alpha Atelier',
      }),
      expect.objectContaining({
        eventId: 'beta-drop',
        sellerId: 'seller-beta',
        sellerName: 'Beta Bazaar',
      }),
    ]));
    await expect(events.listForSeller('seller-alpha')).resolves.toEqual([
      expect.objectContaining({ eventId: 'alpha-drop', sellerName: 'Alpha Atelier' }),
    ]);
    await expect(events.listForSeller('seller-beta')).resolves.toEqual([
      expect.objectContaining({ eventId: 'beta-drop', sellerName: 'Beta Bazaar' }),
    ]);
  });
});
