import { describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import type { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { EventController } from './event.controller';
import { EventService, InMemoryEventStore, type EventRecord } from './event.service';

const PROBE: EventRecord = {
  eventId: 'wi38795-e2e-1786717919',
  title: 'Release probe',
  sellerId: 'seller-probe',
  sellerName: 'Probe seller',
  status: 'scheduled',
  startsAt: null,
  endedAt: null,
  thumbnailUrl: 'https://placehold.co/320x180/png?text=Probe',
};

describe('EventController seller teardown', () => {
  function build() {
    const invalidated: Array<{
      name: string;
      args?: Record<string, unknown>;
      context?: { principal?: string | null };
    }> = [];
    const service = new EventService(new InMemoryEventStore([{ ...PROBE }]), new ChatService());
    const controller = new EventController(service, {
      invalidate: (
        name: string,
        args?: Record<string, unknown>,
        context?: { principal?: string | null },
      ) => invalidated.push({ name, args, context }),
    } as unknown as SyncInvalidationService);
    return { controller, invalidated };
  }

  it('drafts the seller-owned row, keeps it in My events, and invalidates both directories', async () => {
    const { controller, invalidated } = build();

    await expect(controller.unpublish(PROBE.eventId, PROBE.sellerId)).resolves.toEqual({
      eventId: PROBE.eventId,
      status: 'draft',
    });
    await expect(controller.list()).resolves.toEqual({ events: [] });
    await expect(controller.listMine(PROBE.sellerId)).resolves.toEqual({
      events: [expect.objectContaining({ eventId: PROBE.eventId, status: 'draft' })],
    });
    await expect(controller.unpublish(PROBE.eventId, PROBE.sellerId)).resolves.toEqual({
      eventId: PROBE.eventId,
      status: 'draft',
    });
    expect(invalidated.map(({ name }) => name)).toEqual([
      'events.guide',
      'events.mine',
      'events.guide',
      'events.mine',
    ]);
    expect(invalidated.filter(({ name }) => name === 'events.mine')).toEqual([
      { name: 'events.mine', args: undefined, context: { principal: PROBE.sellerId } },
      { name: 'events.mine', args: undefined, context: { principal: PROBE.sellerId } },
    ]);
  });

  it('does not reveal whether another seller owns the event', async () => {
    const { controller, invalidated } = build();

    await expect(controller.unpublish(PROBE.eventId, 'seller-other')).rejects.toThrow(
      'Event not found for this seller.',
    );
    await expect(controller.list()).resolves.toEqual({
      events: [expect.objectContaining({ eventId: PROBE.eventId })],
    });
    expect(invalidated).toEqual([]);
  });

  it('never returns another seller\'s rows from My events', async () => {
    const { controller } = build();

    await expect(controller.listMine('seller-other')).resolves.toEqual({ events: [] });
  });
});
