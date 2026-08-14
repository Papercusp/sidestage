import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ChatService } from '../chat/chat.service';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { EventService, InMemoryEventStore } from '../events/event.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { SyncQueryRegistry } from '../sync/sync-query.registry';
import { RunOfShowController } from './run-of-show.controller';
import { RunOfShowSyncQueries } from './run-of-show.module';
import { InMemoryRunOfShowStore, RunOfShowService } from './run-of-show.service';

function harness() {
  const invalidations = new SyncInvalidationService();
  const fired: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const realInvalidate = invalidations.invalidate.bind(invalidations);
  invalidations.invalidate = (name: string, args?: Record<string, unknown>) => {
    fired.push({ name, args });
    return realInvalidate(name, args);
  };
  const ownership = new EventOwnershipGuard(new EventService(
    new InMemoryEventStore([{
      eventId: 'demo-event',
      title: 'Demo event',
      sellerId: 'seller-owner',
      sellerName: 'Owner',
      status: 'scheduled',
      startsAt: null,
      endedAt: null,
    }]),
    new ChatService(),
  ));
  const runOfShow = new RunOfShowService(new InMemoryRunOfShowStore());
  const controller = new RunOfShowController(
    runOfShow,
    invalidations,
    ownership,
  );
  return { controller, fired, ownership, runOfShow };
}

describe('RunOfShowController', () => {
  it('GET returns the empty default before any save', async () => {
    const { controller } = harness();
    const plan = await controller.get('demo-event', 'seller-owner');
    expect(plan).toMatchObject({ eventId: 'demo-event', entries: [] });
  });

  it('PUT saves, returns the plan, and invalidates the event-scoped sync query', async () => {
    const { controller, fired } = harness();
    const entries = [
      { productId: 'first', plannedDurationSec: 120, notes: 'open strong' },
      { productId: 'second', plannedDurationSec: null, notes: '' },
    ];
    const saved = await controller.put('demo-event', { entries }, 'seller-owner');
    expect(saved.entries.map((e) => e.productId)).toEqual(['first', 'second']);
    expect(fired).toEqual([{ name: 'event.runOfShow', args: { eventId: 'demo-event' } }]);
    const read = await controller.get('demo-event', 'seller-owner');
    expect(read.entries).toEqual(entries);
  });

  it('PUT tolerates a missing body without invalidating with a bad id', async () => {
    const { controller, fired } = harness();
    const saved = await controller.put(
      'demo-event',
      undefined as unknown as { entries?: unknown },
      'seller-owner',
    );
    expect(saved.entries).toEqual([]);
    expect(fired[0]?.args).toEqual({ eventId: 'demo-event' });
  });

  it('returns the same not-found response for foreign and absent event ids', async () => {
    const { controller, fired } = harness();
    const capture = async (eventId: string): Promise<unknown> => {
      try {
        await controller.get(eventId, 'seller-other');
        expect.unreachable('expected owner check to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        return (error as NotFoundException).getResponse();
      }
    };

    await expect(capture('demo-event')).resolves.toEqual(
      await capture('missing-event'),
    );
    await expect(controller.put(
      'demo-event',
      { entries: [{ productId: 'stolen', notes: '' }] },
      'seller-other',
    )).rejects.toThrow('Event not found for this seller.');
    expect(fired).toEqual([]);
  });

  it('owner-checks the event.runOfShow sync query with request context', async () => {
    const { ownership, runOfShow } = harness();
    const queries = new SyncQueryRegistry();
    new RunOfShowSyncQueries(runOfShow, queries, ownership).onModuleInit();

    await expect(queries.resolve(
      'event.runOfShow',
      { eventId: 'demo-event' },
      { principal: 'seller-owner' },
    )).resolves.toEqual([expect.objectContaining({ eventId: 'demo-event' })]);
    await expect(queries.resolve(
      'event.runOfShow',
      { eventId: 'demo-event' },
      { principal: 'seller-other' },
    )).rejects.toThrow('Event not found for this seller.');
  });
});
