import { describe, expect, it } from 'vitest';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { RunOfShowController } from './run-of-show.controller';
import { InMemoryRunOfShowStore, RunOfShowService } from './run-of-show.service';

function harness() {
  const invalidations = new SyncInvalidationService();
  const fired: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const realInvalidate = invalidations.invalidate.bind(invalidations);
  invalidations.invalidate = (name: string, args?: Record<string, unknown>) => {
    fired.push({ name, args });
    return realInvalidate(name, args);
  };
  const controller = new RunOfShowController(
    new RunOfShowService(new InMemoryRunOfShowStore()),
    invalidations,
  );
  return { controller, fired };
}

describe('RunOfShowController', () => {
  it('GET returns the empty default before any save', async () => {
    const { controller } = harness();
    const plan = await controller.get('demo-event');
    expect(plan).toMatchObject({ eventId: 'demo-event', entries: [] });
  });

  it('PUT saves, returns the plan, and invalidates the event-scoped sync query', async () => {
    const { controller, fired } = harness();
    const entries = [
      { productId: 'first', plannedDurationSec: 120, notes: 'open strong' },
      { productId: 'second', plannedDurationSec: null, notes: '' },
    ];
    const saved = await controller.put('demo-event', { entries });
    expect(saved.entries.map((e) => e.productId)).toEqual(['first', 'second']);
    expect(fired).toEqual([{ name: 'event.runOfShow', args: { eventId: 'demo-event' } }]);
    const read = await controller.get('demo-event');
    expect(read.entries).toEqual(entries);
  });

  it('PUT tolerates a missing body without invalidating with a bad id', async () => {
    const { controller, fired } = harness();
    const saved = await controller.put('demo-event', undefined as unknown as { entries?: unknown });
    expect(saved.entries).toEqual([]);
    expect(fired[0]?.args).toEqual({ eventId: 'demo-event' });
  });
});
