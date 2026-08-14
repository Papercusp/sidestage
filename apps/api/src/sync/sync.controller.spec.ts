import { firstValueFrom, filter, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SyncController } from './sync.controller';
import { SyncInvalidationService } from './sync-invalidation.service';
import { SyncQueryRegistry } from './sync-query.registry';

function createSync() {
  const queries = new SyncQueryRegistry();
  const invalidations = new SyncInvalidationService();
  return {
    controller: new SyncController(queries, invalidations),
    invalidations,
    queries,
  };
}

describe('SyncController', () => {
  it('resolves async named queries and preserves batch positions', async () => {
    const { controller, queries } = createSync();
    queries.register('catalog.page', async (args) => [{ page: args.page }]);

    const response = await controller.restQueryBatch({
      queries: [
        { name: 'catalog.page', args: { page: 2 } },
        { name: 'catalog.missing', args: {} },
      ],
    });

    expect(response.results[0]).toMatchObject({ rows: [{ page: 2 }] });
    expect(response.results[1]).toMatchObject({
      rows: [],
      error: 'unknown sync query: catalog.missing',
    });
  });

  it('turns handler failures into per-query errors', async () => {
    const { controller, queries } = createSync();
    queries.register('event.stats', () => {
      throw new Error('stats unavailable');
    });

    const response = await controller.restQueryBatch({
      queries: [{ name: 'event.stats' }],
    });

    expect(response.results[0]).toMatchObject({
      rows: [],
      error: 'stats unavailable',
    });
  });

  it('publishes matching and global invalidations on the SSE contract', async () => {
    vi.useFakeTimers();
    try {
      const { controller, invalidations } = createSync();
      const nextInvalidation = firstValueFrom(
        controller.syncEvents('event-2').pipe(
          filter((event) => event.type === 'invalidate'),
          take(1),
        ),
      );

      invalidations.invalidate('event.stats', { eventId: 'event-1' });
      const published = invalidations.invalidate('event.stats', { eventId: 'event-2' });

      await expect(nextInvalidation).resolves.toMatchObject({
        type: 'invalidate',
        data: JSON.stringify(published),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SyncQueryRegistry', () => {
  it('rejects ambiguous duplicate registrations but permits idempotent registration', () => {
    const queries = new SyncQueryRegistry();
    const handler = () => [];
    queries.register('event.config', handler);

    expect(() => queries.register('event.config', handler)).not.toThrow();
    expect(() => queries.register('event.config', () => [])).toThrow(
      'sync query already registered: event.config',
    );
  });
});
