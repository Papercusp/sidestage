import { NestFactory } from '@nestjs/core';
import { firstValueFrom, filter, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SyncController } from './sync.controller';
import { SyncInvalidationService } from './sync-invalidation.service';
import { SyncModule } from './sync.module';
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
  it('injects the registry and invalidation stream when Nest boots under tsx', async () => {
    const context = await NestFactory.createApplicationContext(SyncModule, { logger: false });
    try {
      const controller = context.get(SyncController);
      await expect(firstValueFrom(controller.syncEvents().pipe(take(1)))).resolves.toMatchObject({
        type: 'heartbeat',
      });
      await expect(controller.restQueryBatch({ queries: [{ name: 'missing.query' }] })).resolves.toEqual({
        results: [expect.objectContaining({ error: 'unknown sync query: missing.query' })],
      });
    } finally {
      await context.close();
    }
  });

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

  it('passes the canonical demo principal to every named query in a batch', async () => {
    const { controller, queries } = createSync();
    queries.register('identity.current', (_args, context) => [{ principal: context.principal }]);

    await expect(controller.restQueryBatch({
      queries: [{ name: 'identity.current' }],
    }, '  demo-alice  ')).resolves.toMatchObject({
      results: [{ rows: [{ principal: 'demo-alice' }] }],
    });

    await expect(controller.restQueryBatch({
      queries: [{ name: 'identity.current' }],
    })).resolves.toMatchObject({
      results: [{ rows: [{ principal: null }] }],
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

  it('delivers targeted SSE invalidations only to the matching demo principal', async () => {
    vi.useFakeTimers();
    try {
      const { controller, invalidations } = createSync();
      const aliceEvent = firstValueFrom(
        controller.syncEvents(undefined, 'demo-alice').pipe(
          filter((event) => event.type === 'invalidate'),
          take(1),
        ),
      );
      const bobEvent = firstValueFrom(
        controller.syncEvents(undefined, 'demo-bob').pipe(
          filter((event) => event.type === 'invalidate'),
          take(1),
        ),
      );

      const bobOnly = invalidations.invalidate(
        'orders.byBuyer',
        { scope: 'mine' },
        { principal: 'demo-bob' },
      );
      const global = invalidations.invalidate('events.guide');

      await expect(bobEvent).resolves.toMatchObject({ data: JSON.stringify(bobOnly) });
      await expect(aliceEvent).resolves.toMatchObject({ data: JSON.stringify(global) });
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
