import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { firstValueFrom, filter, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PG_POOL } from '../db/database.module';
import { SyncController } from './sync.controller';
import { SyncInvalidationService } from './sync-invalidation.service';
import { SyncModule } from './sync.module';
import { SyncQueryRegistry } from './sync-query.registry';

/**
 * SyncModule's ZeroController injects PG_POOL, which DatabaseModule provides in
 * the real AppModule. Bootstrapping SyncModule ALONE has no DatabaseModule in
 * the graph, so PG_POOL would be unresolvable and Nest's bootstrap rejection
 * KILLS THE WHOLE VITEST WORKER rather than failing one test (the fork dies, so
 * the file's results vanish and the leg exits 1 with every test still "passing"
 * — EI-20689489448966446).
 *
 * Supply it here instead of importing DatabaseModule into SyncModule: that
 * creates a temporal-dead-zone circular import via event.module.ts. See the
 * warning in sync.module.ts. `null` is a legitimate PG_POOL value —
 * createPoolOrNull() returns null under DATA_BACKEND=memory — and it keeps this
 * spec hermetic (no database, no 2s connection probe).
 */
@Global()
@Module({ providers: [{ provide: PG_POOL, useValue: null }], exports: [PG_POOL] })
class NullPgPoolModule {}

@Module({ imports: [NullPgPoolModule, SyncModule] })
class SyncSpecHostModule {}

function createSync() {
  const queries = new SyncQueryRegistry();
  const invalidations = new SyncInvalidationService();
  return {
    controller: new SyncController(queries, invalidations),
    invalidations,
    queries,
  };
}

// CONTROL for the test below it. A guard that has never failed is a guard nobody has
// tested, so this module is deliberately unbootable: its only provider's factory throws,
// which is the same shape of failure (Nest cannot construct the graph while scanning)
// that hid EI-20689489448966446.
// NB: written with Module() applied as a plain function rather than as a @decorator.
// Decorator syntax does not parse under this spec's tsconfig (TS1206), and a file that
// fails to PARSE is worse than the bug this guards: bundle-host.sh esbuild-bundles the
// working tree, so an unparseable file here takes the staging/release hosts down with
// no commit involved.
// Applied as a STATEMENT on a declared class, not as `Module(...)(class {})` whose value
// is consumed: ClassDecorator returns `void | typeof T`, so consuming the call's result
// hands NestFactory a `void`-widened type (TS2345). Nest's Module() mutates the target
// via Reflect.defineMetadata and returns nothing, so the class binding is the real module.
class DeliberatelyBrokenModule {}
Module({
  providers: [
    {
      provide: 'DELIBERATELY_BROKEN',
      useFactory: () => {
        throw new Error('deliberate boot failure — this provider exists to fail');
      },
    },
  ],
})(DeliberatelyBrokenModule);

describe('Nest boot failures must be visible', () => {
  // If this test ever ABORTS the worker instead of failing, the abortOnError:false
  // contract has been lost somewhere and every boot failure in this file has silently
  // become a "flake" again: vitest would report "N-1 passed (N)" plus one unattributed
  // "Worker exited unexpectedly", naming no file. That is precisely how a real broken
  // SyncModule survived a full green-looking suite run and cost the fleet a morning.
  // Do NOT delete this control, and do NOT drop abortOnError:false to "clean it up".
  it('CONTROL: an unsatisfiable module REJECTS rather than killing the process', async () => {
    await expect(
      NestFactory.createApplicationContext(DeliberatelyBrokenModule, {
        abortOnError: false,
        logger: false,
      }),
    ).rejects.toThrow();
  });
});

describe('SyncController', () => {
  it('injects the registry and invalidation stream when Nest boots SyncModule\'s DI graph', async () => {
    // abortOnError:false is LOAD-BEARING, not tidiness. NestFactory's default is
    // abortOnError:true, and handleInitializationError then calls process.abort()
    // (nest-factory.js:123) instead of rejecting. Under the fork pool that aborts the
    // WORKER: vitest reports "99 passed (100)" + one unattributed "Worker exited
    // unexpectedly" and the suite exits 1 with no file named — so a real boot failure
    // reads as a no-fault flake. That is exactly how EI-20689489448966446 hid a broken
    // SyncModule (ZeroController -> @rocicorp/zero/server/adapters/pg) for hours.
    // With abortOnError:false the same failure surfaces here as a NAMED test failure.
    // Keep the logger on for the same reason: { logger: false } silences the cause.
    //
    // Bootstrap SyncSpecHostModule, NOT SyncModule: SyncModule's ZeroController injects
    // PG_POOL, which nothing in SyncModule's own graph provides, so booting it bare fails
    // to RESOLVE (a dependency error) — which is not the failure mode this test exists to
    // check. SyncSpecHostModule wraps it with NullPgPoolModule so the graph is
    // satisfiable and this test measures what it claims to: that SyncModule's DI graph
    // (ZeroController's adapter import included) resolves and initializes cleanly.
    //
    // ⚠ THIS DOES NOT COVER tsx RUNTIME PATH RESOLUTION (EI-20698695526784792). This
    // file is itself run by vitest — through vite, not tsx — so it resolves
    // apps/api/tsconfig.json's `paths` remap for @rocicorp/zero differently than a
    // real tsx process does at dev/prod boot; a `paths` target that vite happily
    // loads here can still MODULE_NOT_FOUND under tsx. Only an actual tsx child
    // process reproduces that class of regression — see
    // zero-adapter-runtime-resolution.spec.ts, which does exactly that.
    const context = await NestFactory.createApplicationContext(SyncSpecHostModule, {
      abortOnError: false,
    });
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

  /**
   * P-008 clause 2 (principal-aware invalidation), plan
   * sidestage-demo-user-isolation-2026-08-14, Decision D-011.
   *
   * The cell above proves the principal filter for two BUYERS on a buyer-scoped
   * query. This one proves it for two SELLERS on `events.mine` — the seller
   * directory, which is the query this plan exists to isolate. It is not a
   * restatement: seller writes fan out from a different call site
   * (`event.controller.ts` and `event-config.controller.ts` both call
   * `invalidate('events.mine', undefined, { principal })`), and a seller's
   * invalidation reaching a foreign seller is a live-refresh cross-identity
   * leak — the receiving Studio would re-fetch and repaint on a stranger's edit.
   *
   * Asserting the NEGATIVE directly is the point: Mira must receive her own
   * event and not Avi's. Racing two `firstValueFrom` takes would only prove
   * each got something, so Avi's invalidation is published FIRST and Mira's
   * second — if the filter were absent, Mira's stream would resolve with Avi's
   * payload and the assertion fails on identity, not on timing.
   */
  it('keeps one seller\'s events.mine invalidation off another seller\'s stream', async () => {
    vi.useFakeTimers();
    try {
      const { controller, invalidations } = createSync();
      const miraEvent = firstValueFrom(
        controller.syncEvents(undefined, 'seller-mira').pipe(
          filter((event) => event.type === 'invalidate'),
          take(1),
        ),
      );

      const aviOnly = invalidations.invalidate('events.mine', undefined, {
        principal: 'seller-avi',
      });
      const miraOnly = invalidations.invalidate('events.mine', undefined, {
        principal: 'seller-mira',
      });

      await expect(miraEvent).resolves.toMatchObject({ data: JSON.stringify(miraOnly) });
      expect(JSON.stringify(miraOnly)).not.toContain('seller-avi');
      expect(aviOnly.principal).toBe('seller-avi');
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
