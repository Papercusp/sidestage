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

    await controller.put('acceptance-dock-thumbnail-2026-08-14', {
      name: 'Acceptance dock thumbnail',
      thumbnailUrl: 'data:image/png;base64,AAAA',
    });

    const guide = await new EventController(events).list();
    expect(guide.events).toHaveLength(1);
    expect(guide.events[0]).toMatchObject({
      eventId: 'acceptance-dock-thumbnail-2026-08-14',
      title: 'Acceptance dock thumbnail',
      status: 'scheduled',
      thumbnailUrl: 'data:image/png;base64,AAAA',
    });
    expect(invalidated).toEqual(['event.config', 'events.guide']);
  });

  it('a follow-up rename PUT updates the guide row without duplicating it', async () => {
    const { events, controller } = build();

    await controller.put('my-drop', { name: 'My drop' });
    await controller.put('my-drop', { name: 'My renamed drop' });

    const guide = await new EventController(events).list();
    expect(guide.events).toHaveLength(1);
    expect(guide.events[0]?.title).toBe('My renamed drop');
  });
});
