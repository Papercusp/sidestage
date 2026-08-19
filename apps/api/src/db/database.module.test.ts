import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  CONNECTION_PRESSURE_WARN_RATIO,
  DEFAULT_DATABASE_URL,
  PgPoolLifecycle,
  TOO_MANY_CONNECTIONS_SQLSTATE,
  connectionPressureWarning,
  createPoolOrNull,
  dataBackendMode,
  databaseUrl,
  isConnectionExhaustion,
  poolApplicationName,
  readConnectionPressure,
} from './database.module';

/**
 * RECURRENCE GUARD (WI-39698). The sidestage-node suite must never dial a real
 * Postgres. Any test that boots a Nest module pulls in the @Global DatabaseModule,
 * whose PG_POOL factory calls createPoolOrNull(); in 'auto' mode that connects to
 * 127.0.0.1:55434 and asserts its live schema, making the suite's verdict depend on
 * a shared container nobody owns. That is what held the release gate on candidate
 * d6fee86480b0 with `schema drift — 39 table(s) missing`, on a web-only diff.
 *
 * vitest.config.mts pins DATA_BACKEND=memory for this project. Delete that line and
 * these assertions fail immediately — instead of the suite quietly going
 * non-hermetic again and surfacing hours later as a red gate on unrelated code.
 */
describe('sidestage-node suite is hermetic (no real Postgres)', () => {
  it('runs with DATA_BACKEND=memory so module bootstrap never dials a database', () => {
    expect(process.env.DATA_BACKEND).toBe('memory');
    expect(dataBackendMode()).toBe('memory');
  });

  it('createPoolOrNull resolves to null under the ambient test env', async () => {
    // Proves the consequence, not just the setting: no Pool is constructed, so no
    // socket is opened and no schema assertion runs during a unit test.
    await expect(createPoolOrNull()).resolves.toBeNull();
  });
});

describe('databaseUrl', () => {
  it('targets the isolated local data stack when DATABASE_URL is unset', () => {
    expect(DEFAULT_DATABASE_URL).toBe(
      'postgresql://sidestage:sidestage_dev@127.0.0.1:55434/sidestage',
    );
    expect(databaseUrl({})).toBe(DEFAULT_DATABASE_URL);
  });

  it('honors an explicit DATABASE_URL', () => {
    expect(databaseUrl({ DATABASE_URL: 'postgresql://example.test/override' })).toBe(
      'postgresql://example.test/override',
    );
  });
});

/**
 * EI-20739798038041966 — "dev Postgres sits at max_connections; ~100 leaked node
 * connections make every psql/DB-backed probe fail with `too many clients already`".
 *
 * Measured root cause: `bootstrapWithRetry` re-runs the WHOLE bootstrap, and a boot
 * that failed AFTER the pool was built never handed it back — Nest calls lifecycle
 * hooks only on providers that implement them, and a raw `pg.Pool` implements none,
 * so even an explicit `app.close()` released nothing. One process could therefore
 * strand a live 10-connection pool per retry, unbounded, while three duplicate API
 * trees sat on the box for 1.3–4.4 days re-attempting a port they could never win.
 *
 * The four properties below are what stop that recurring; each is exercised through
 * the real exported seam, not a description of it.
 */
describe('pg pool leak containment (EI-20739798038041966)', () => {
  const fakePool = (end: () => Promise<void>) => ({ end }) as unknown as Pool;
  const silentLogger = () => ({ log: vi.fn(), warn: vi.fn() });

  describe('holder attribution', () => {
    it('stamps every connection with a per-process application_name', () => {
      // The filer's `ss -tnp` showed 100x anonymous `node-MainThread`, which cannot
      // be traced once the holder is an orphan. pg_stat_activity now names it.
      expect(poolApplicationName(4242)).toBe('sidestage-api[4242]');
      expect(poolApplicationName()).toContain(String(process.pid));
    });
  });

  describe('PgPoolLifecycle', () => {
    it('ends the pool when the app shuts down', async () => {
      const end = vi.fn(async () => {});
      await new PgPoolLifecycle(fakePool(end), silentLogger()).onApplicationShutdown('SIGTERM');
      expect(end).toHaveBeenCalledOnce();
    });

    it('is idempotent — pg throws on a second end() and close paths can overlap', async () => {
      const end = vi.fn(async () => {});
      const lifecycle = new PgPoolLifecycle(fakePool(end), silentLogger());
      await lifecycle.onApplicationShutdown('SIGTERM');
      await lifecycle.onApplicationShutdown('SIGINT');
      expect(end).toHaveBeenCalledOnce();
    });

    it('tolerates the in-memory fallback, where there is no pool at all', async () => {
      await expect(
        new PgPoolLifecycle(null, silentLogger()).onApplicationShutdown('SIGTERM'),
      ).resolves.toBeUndefined();
    });

    it('never lets a failed close reject the shutdown — it warns instead', async () => {
      const logger = silentLogger();
      const lifecycle = new PgPoolLifecycle(
        fakePool(async () => {
          throw new Error('pool already ended');
        }),
        logger,
      );
      await expect(lifecycle.onApplicationShutdown('SIGTERM')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledOnce();
    });
  });

  describe('exhaustion is distinguished from an absent server', () => {
    it('recognises exhaustion by SQLSTATE and by message', () => {
      expect(isConnectionExhaustion(Object.assign(new Error('nope'), { code: TOO_MANY_CONNECTIONS_SQLSTATE }))).toBe(true);
      expect(isConnectionExhaustion(new Error('sorry, too many clients already'))).toBe(true);
    });

    it('control: a genuinely absent server is NOT reported as exhaustion', () => {
      // Without this the fix would "work" by classifying every connect failure as
      // exhaustion — and send everyone away from the real `docker compose up`.
      expect(isConnectionExhaustion(new Error('ECONNREFUSED 127.0.0.1:55434'))).toBe(false);
      expect(isConnectionExhaustion(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }))).toBe(false);
      expect(isConnectionExhaustion(null)).toBe(false);
    });
  });

  describe('readConnectionPressure', () => {
    const rows = [
      { application_name: 'sidestage-api[1]', connections: 60, used: 92, max: 100 },
      { application_name: '(unnamed)', connections: 32, used: 92, max: 100 },
    ];

    it('reports server-wide usage and per-application holders', async () => {
      const pressure = await readConnectionPressure({ query: vi.fn(async () => ({ rows })) } as never);
      expect(pressure).toEqual({
        used: 92,
        max: 100,
        holders: [
          { applicationName: 'sidestage-api[1]', connections: 60 },
          { applicationName: '(unnamed)', connections: 32 },
        ],
      });
    });

    it('is a diagnostic, never a boot failure: a broken probe resolves null', async () => {
      const pressure = await readConnectionPressure({
        query: vi.fn(async () => {
          throw new Error('permission denied for pg_stat_activity');
        }),
      } as never);
      expect(pressure).toBeNull();
    });
  });

  describe('connectionPressureWarning (the recurrence guard)', () => {
    const holders = [{ applicationName: 'sidestage-api[1]', connections: 60 }];

    it('fires at the threshold, naming the count, the ceiling and the holders', () => {
      const warning = connectionPressureWarning({ used: 92, max: 100, holders }, DEFAULT_DATABASE_URL);
      expect(warning).toContain('92/100');
      // The consequence, not just the number — a bare count reads as trivia, and
      // this failure's whole cost was that it looks like a broken query.
      expect(warning).toContain('too many clients already');
      expect(warning).toContain('sidestage-api[1]=60');
      // The diagnostic names the port actually in use, not a hardcoded one.
      expect(warning).toContain("grep ':55434'");
    });

    it('control: stays silent well below the threshold', () => {
      // A guard that fires at 12/100 would be tuned out long before it mattered.
      expect(connectionPressureWarning({ used: 12, max: 100, holders })).toBeNull();
    });

    it('control: fires exactly at the ratio, not one connection later', () => {
      const atThreshold = Math.ceil(CONNECTION_PRESSURE_WARN_RATIO * 100);
      expect(connectionPressureWarning({ used: atThreshold, max: 100, holders })).not.toBeNull();
      expect(connectionPressureWarning({ used: atThreshold - 1, max: 100, holders })).toBeNull();
    });

    it('control: an unreadable max_connections yields no warning rather than a divide-by-zero one', () => {
      expect(connectionPressureWarning({ used: 92, max: 0, holders })).toBeNull();
    });
  });
});
