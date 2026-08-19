import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_PORT_CONFLICT_MAX_ATTEMPTS,
  bootRetryMaxAttempts,
  bootstrapWithRetry,
  isPortConflict,
} from './bootstrap-retry';

/**
 * EI-20491819050412730 — "SideStage API exits during fresh Watch browser QA
 * after initially passing health check".
 *
 * :3100 answered healthz at QA start, then stopped listening mid-run while
 * :5173 and :8889 stayed up. Cause: `createPoolOrNull` throws on schema drift,
 * `main.ts` ran `void bootstrap()`, so the rejection killed the process — and
 * `start:dev`'s surviving `tsx watch` parent only re-runs the entrypoint on a
 * WATCHED FILE change, which a database-only `npm run db:apply` never makes.
 * The listener therefore never came back on its own.
 */
describe('API bootstrap retry (EI-20491819050412730)', () => {
  const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it('reclaims the listener once the drifted schema is repaired', async () => {
    // The exact reported sequence: boot fails while the schema is drifted, an
    // operator runs db:apply, and the API must come back WITHOUT a file edit.
    let schemaRepaired = false;
    const bootstrap = vi.fn(async () => {
      if (!schemaRepaired) throw new Error('Schema drift: missing tables. Run: npm run db:apply');
    });
    const sleep = vi.fn(async () => {
      schemaRepaired = true; // the repair lands between attempts
    });

    await expect(
      bootstrapWithRetry(bootstrap, { sleep, logger: silentLogger }),
    ).resolves.toBeUndefined();

    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('survives a failed boot instead of exiting the process', async () => {
    // Before the fix the first rejection was terminal. Retrying at all is the
    // property that keeps the process alive to be recovered.
    const bootstrap = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Postgres unreachable'))
      .mockRejectedValueOnce(new Error('Postgres unreachable'))
      .mockResolvedValueOnce(undefined);

    await bootstrapWithRetry(bootstrap, { sleep: vi.fn(async () => {}), logger: silentLogger });

    expect(bootstrap).toHaveBeenCalledTimes(3);
  });

  it('does not sleep or retry when the first attempt succeeds', async () => {
    const bootstrap = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});

    await bootstrapWithRetry(bootstrap, { sleep, logger: silentLogger });

    expect(bootstrap).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('backs off exponentially and caps the delay', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    const bootstrap = vi.fn(async () => {
      if (delays.length < 8) throw new Error('still drifted');
    });

    await bootstrapWithRetry(bootstrap, {
      sleep,
      logger: silentLogger,
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
    });

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000]);
  });

  it('rethrows once a finite attempt budget is exhausted', async () => {
    const bootstrap = vi.fn(async () => {
      throw new Error('Schema drift: missing tables');
    });

    await expect(
      bootstrapWithRetry(bootstrap, {
        maxAttempts: 3,
        sleep: vi.fn(async () => {}),
        logger: silentLogger,
      }),
    ).rejects.toThrow('Schema drift');

    expect(bootstrap).toHaveBeenCalledTimes(3);
  });

  it('retries unattended by default so a dev box self-heals', () => {
    expect(bootRetryMaxAttempts({})).toBe(Number.POSITIVE_INFINITY);
    expect(bootRetryMaxAttempts({ API_BOOT_MAX_ATTEMPTS: '  ' })).toBe(Number.POSITIVE_INFINITY);
    // A malformed budget must not silently become "give up immediately".
    expect(bootRetryMaxAttempts({ API_BOOT_MAX_ATTEMPTS: 'nope' })).toBe(Number.POSITIVE_INFINITY);
    expect(bootRetryMaxAttempts({ API_BOOT_MAX_ATTEMPTS: '0' })).toBe(Number.POSITIVE_INFINITY);
    expect(bootRetryMaxAttempts({ API_BOOT_MAX_ATTEMPTS: '5' })).toBe(5);
  });

  it('caps the default backoff so a stuck dependency cannot spin', () => {
    expect(DEFAULT_MAX_DELAY_MS).toBeLessThanOrEqual(60_000);
  });
});

/**
 * EI-20739798038041966 — a retry that CANNOT succeed is not resilience, it is a
 * process that never dies. Three duplicate API trees were measured alive on the dev
 * box for 1.3, 1.8 and 4.4 days, each re-running the whole bootstrap against a port
 * another process already owned, and (before the pool-teardown fix) stranding a live
 * pg Pool on every attempt until Postgres ran out of connection slots.
 *
 * The distinction that has to hold: a DEPENDENCY failure is repairable by someone
 * else and stays unbounded; a PORT conflict is not, and exits.
 */
describe('duplicate API server does not spin forever (EI-20739798038041966)', () => {
  const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const addrInUse = () => Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:3100'), {
    code: 'EADDRINUSE',
  });

  it('classifies a port conflict by its code, not its wording', () => {
    expect(isPortConflict(addrInUse())).toBe(true);
    // Control: the failures that SHOULD retry unbounded must not be swept up.
    expect(isPortConflict(new Error('Schema drift: missing tables'))).toBe(false);
    expect(isPortConflict(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isPortConflict(undefined)).toBe(false);
  });

  it('gives up after a bounded number of port conflicts instead of retrying forever', async () => {
    const bootstrap = vi.fn(async () => {
      throw addrInUse();
    });

    await expect(
      bootstrapWithRetry(bootstrap, {
        portConflictMaxAttempts: 3,
        sleep: vi.fn(async () => {}),
        logger: silentLogger,
      }),
    ).rejects.toThrow('EADDRINUSE');

    // Bounded even though maxAttempts is still the default Infinity.
    expect(bootstrap).toHaveBeenCalledTimes(3);
  });

  it('still tolerates the watch-restart race, where the outgoing child briefly holds the port', async () => {
    // tsx watch signals the old child and starts the new one; losing the port for a
    // beat is normal. Exiting on the FIRST conflict would make every reload flaky.
    let attempts = 0;
    const bootstrap = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 2) throw addrInUse();
    });

    await expect(
      bootstrapWithRetry(bootstrap, { sleep: vi.fn(async () => {}), logger: silentLogger }),
    ).resolves.toBeUndefined();
    expect(bootstrap).toHaveBeenCalledTimes(3);
    expect(DEFAULT_PORT_CONFLICT_MAX_ATTEMPTS).toBeGreaterThan(2);
  });

  it('control: a repairable dependency failure is still retried unbounded', async () => {
    // The property EI-20491819050412730 added. Bounding port conflicts must not
    // quietly bound schema drift too — that would reopen the earlier bug.
    let attempts = 0;
    const bootstrap = vi.fn(async () => {
      attempts += 1;
      if (attempts <= DEFAULT_PORT_CONFLICT_MAX_ATTEMPTS + 5) {
        throw new Error('Schema drift: missing tables. Run: npm run db:apply');
      }
    });

    await expect(
      bootstrapWithRetry(bootstrap, { sleep: vi.fn(async () => {}), logger: silentLogger }),
    ).resolves.toBeUndefined();
    expect(bootstrap).toHaveBeenCalledTimes(DEFAULT_PORT_CONFLICT_MAX_ATTEMPTS + 6);
  });
});

/**
 * The behavioural tests above prove the retry helper works; this proves the
 * entrypoint still USES it. Without it a future edit could restore the bare
 * `void bootstrap()` and silently reopen the bug with every unit test green.
 *
 * The subject path is overridable so falsifiability can be demonstrated against
 * a COPY, never by mutating this shared checkout (a sweep can commit an in-tree
 * mutation even when nothing goes wrong).
 */
describe('API entrypoint wiring (EI-20491819050412730 recurrence guard)', () => {
  const mainPath = process.env.SIDESTAGE_MAIN_TS_PATH ?? resolve(__dirname, 'main.ts');
  const mainSource = readFileSync(mainPath, 'utf8');

  it('routes startup through the retrying bootstrap', () => {
    expect(mainSource).toContain("from './bootstrap-retry'");
    expect(mainSource).toMatch(/bootstrapWithRetry\(\s*bootstrap\s*\)/);
  });

  it('never fires the entrypoint as an unsupervised `void bootstrap()`', () => {
    expect(mainSource).not.toMatch(/^\s*void\s+bootstrap\s*\(\s*\)\s*;/m);
  });

  /**
   * EI-20739798038041966. These two lines are what make the retry loop safe to run
   * unbounded: without them each failed attempt strands the pg Pool it just built,
   * inside the same process, and the loop that keeps a dev box self-healing becomes
   * the thing that exhausts Postgres. The retry helper cannot enforce this itself —
   * only the entrypoint knows what an attempt allocated.
   */
  it('closes the partially-built app so a failed attempt strands no pg Pool', () => {
    expect(mainSource).toMatch(/\bcatch\s*\([\s\S]*?await app\.close\(\)/);
  });

  it('enables shutdown hooks so SIGTERM/SIGINT close the pool instead of abandoning it', () => {
    expect(mainSource).toContain('app.enableShutdownHooks()');
  });
});
