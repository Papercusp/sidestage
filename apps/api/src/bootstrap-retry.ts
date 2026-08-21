import { Logger } from '@nestjs/common';

/**
 * A boot failure caused by an EXTERNAL dependency — Postgres unreachable, or
 * `assertSchemaCurrent` finding drift — is recoverable: an operator repairs the
 * database and the API should come back on its own.
 *
 * `void bootstrap()` could not do that (EI-20491819050412730). The rejection
 * went unhandled, Node exited, and under `start:dev` the surviving `tsx watch`
 * parent only re-runs the entrypoint when a WATCHED FILE changes — a
 * database-only repair (`npm run db:apply`) never touches one. So :3110 passed
 * healthz at QA start, went away mid-run when the schema drifted, and never
 * came back; only an unrelated file edit revived it.
 *
 * Retrying keeps the process alive and re-attempts the WHOLE bootstrap, so the
 * listener is reclaimed within one backoff interval of the schema being fixed.
 *
 * Two properties this deliberately preserves:
 *   - Drift stays fatal to the ATTEMPT. `createPoolOrNull` still throws rather
 *     than demoting a real database to the in-memory stores; this only decides
 *     whether we try again, never whether the guard fires.
 *   - A failing boot never fakes health. The process stays alive but does NOT
 *     listen, so healthz remains down and the broken dependency stays visible.
 */

export interface BootRetryOptions {
  /** Attempts before giving up. Default Infinity — see `bootRetryMaxAttempts`. */
  maxAttempts?: number;
  /**
   * Attempts that may fail with EADDRINUSE before giving up, counted across the
   * whole run. Default `DEFAULT_PORT_CONFLICT_MAX_ATTEMPTS`.
   */
  portConflictMaxAttempts?: number;
  /** Delay before the 2nd attempt; doubles up to `maxDelayMs`. Default 1000. */
  initialDelayMs?: number;
  /** Ceiling for the exponential backoff. Default 30_000. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
}

export const DEFAULT_INITIAL_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * EI-20739798038041966. Retrying is right for a dependency an operator can repair;
 * it is wrong for a port another process owns, because THIS process can never win —
 * it just spins, unlistening, until someone notices. Nobody did: three duplicate API
 * trees were found alive 1.3, 1.8 and 4.4 days, each re-running the whole bootstrap
 * every 30s and (before the pool-teardown fix) stranding a pg Pool per attempt.
 *
 * A few attempts are still allowed because `tsx watch` restarts race the outgoing
 * child for the port; past that it is a duplicate server, and exiting is the answer.
 */
export const DEFAULT_PORT_CONFLICT_MAX_ATTEMPTS = 5;

/** `app.listen()` on a port another process holds. */
export function isPortConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'EADDRINUSE';
}

/**
 * Unbounded by default so a development box self-heals unattended. A deployment
 * that would rather crash-loop under an external supervisor sets
 * API_BOOT_MAX_ATTEMPTS to a finite count; exhausting it rethrows.
 */
export function bootRetryMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.API_BOOT_MAX_ATTEMPTS ?? '').trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `bootstrap`, retrying a failed attempt with capped exponential backoff.
 * Resolves once an attempt succeeds; rejects with the LAST error only when a
 * finite attempt budget is exhausted.
 */
export async function bootstrapWithRetry(
  bootstrap: () => Promise<void>,
  options: BootRetryOptions = {},
): Promise<void> {
  const {
    maxAttempts = bootRetryMaxAttempts(),
    portConflictMaxAttempts = DEFAULT_PORT_CONFLICT_MAX_ATTEMPTS,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    sleep = defaultSleep,
    logger = new Logger('Bootstrap'),
  } = options;

  let delayMs = initialDelayMs;
  let portConflicts = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await bootstrap();
      if (attempt > 1) {
        logger.log(`API bootstrap recovered on attempt ${attempt} — listener reclaimed.`);
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isPortConflict(error)) {
        portConflicts += 1;
        if (portConflicts >= portConflictMaxAttempts) {
          logger.error(
            `API bootstrap hit a port conflict on ${portConflicts} attempt(s) (${message}) — giving up. ` +
              'Another process already owns this port, so retrying can never succeed; ' +
              'this is a DUPLICATE API server and is exiting rather than spinning unlistening. ' +
              'Find the owner with `ss -ltnp | grep :<port>`, or set API_PORT to a free port.',
          );
          throw error;
        }
      }
      if (attempt >= maxAttempts) {
        logger.error(`API bootstrap failed after ${attempt} attempt(s), giving up: ${message}`);
        throw error;
      }
      logger.warn(
        `API bootstrap attempt ${attempt} failed (${message}) — not listening; ` +
          `retrying in ${delayMs}ms. If this is schema drift, run: npm run db:apply`,
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}
