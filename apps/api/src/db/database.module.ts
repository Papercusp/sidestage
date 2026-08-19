import { Global, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

import {
  REQUIRED_ACTION_AUDIT_STRUCTURES,
  REQUIRED_CHAT_STRUCTURES,
  REQUIRED_LINEUP_STRUCTURES,
  REQUIRED_OWNERSHIP_STRUCTURES,
  REQUIRED_ORDER_STRUCTURES,
  REQUIRED_TABLES,
  assertSchemaCurrent,
} from './schema-guard';

/**
 * PG_POOL resolves to a connected pg Pool, or null when Postgres is not
 * reachable. Every store seam (auction inventory, cart, orders, catalog)
 * chooses its Postgres implementation when the pool exists and falls back to
 * the in-memory implementation otherwise — so a clean clone without Docker
 * still boots, while starting the local data stack + restart gives durable
 * state. That stack is infra/docker-compose.data.yml, NOT the root
 * docker-compose.yml: only the former publishes DEFAULT_DATABASE_URL's port
 * (55434) and mounts db/schema.sql + db/seed/demo.sql as initdb scripts.
 *
 * DATA_BACKEND overrides the probe: 'memory' forces in-memory even with a
 * reachable database (useful in tests); 'pg' makes an unreachable database a
 * boot failure instead of a silent fallback (useful in production).
 */
export const PG_POOL = Symbol('PG_POOL');

/** The isolated local data stack defined by infra/docker-compose.data.yml. */
export const DEFAULT_DATABASE_URL = 'postgresql://sidestage:sidestage_dev@127.0.0.1:55434/sidestage';

export type DataBackendMode = 'auto' | 'pg' | 'memory';

export function dataBackendMode(raw: string | undefined = process.env.DATA_BACKEND): DataBackendMode {
  const value = (raw ?? 'auto').trim().toLowerCase();
  if (value === 'pg' || value === 'memory') return value;
  return 'auto';
}

/**
 * Demo records are an explicit development affordance, never a production
 * recovery path. DATA_BACKEND is authoritative when set; auto mode follows
 * NODE_ENV so a clean development clone stays useful while production source
 * loss remains visible and cannot manufacture durable-looking records.
 */
export function demoDataEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = dataBackendMode(env.DATA_BACKEND);
  if (mode === 'memory') return true;
  if (mode === 'pg') return false;
  return env.NODE_ENV !== 'production';
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

/**
 * EI-20739798038041966. Every connection this process opens is stamped with an
 * application_name, so `pg_stat_activity` names the holder. Without it every row
 * reads as an anonymous `node-MainThread` in `ss -tnp` and the first step of
 * diagnosing exhaustion — "which writer is this?" — costs a pid-to-process hunt
 * that a killed orphan has already made unanswerable.
 */
export function poolApplicationName(pid: number = process.pid): string {
  return `sidestage-api[${pid}]`;
}

/** Postgres SQLSTATE for "sorry, too many clients already". */
export const TOO_MANY_CONNECTIONS_SQLSTATE = '53300';

/**
 * Connection exhaustion arrives as a CONNECT failure, which is the same shape as
 * "the container is not running" — and the two want opposite remediations.
 */
export function isConnectionExhaustion(error: unknown): boolean {
  if ((error as { code?: unknown } | null | undefined)?.code === TOO_MANY_CONNECTIONS_SQLSTATE) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /too many clients already/i.test(message);
}

/** Warn once the server is this full — well before the ceiling makes probes fail. */
export const CONNECTION_PRESSURE_WARN_RATIO = 0.8;

export interface ConnectionPressure {
  /** Backends currently connected, server-wide. */
  used: number;
  /** The server's max_connections. */
  max: number;
  /** Per-application_name counts, busiest first. */
  holders: { applicationName: string; connections: number }[];
}

type PressureQuery = Pick<Pool, 'query'>;

/**
 * Server-wide connection pressure. Returns null rather than throwing: this is a
 * diagnostic, and a boot must never fail because its own health probe did.
 */
export async function readConnectionPressure(db: PressureQuery): Promise<ConnectionPressure | null> {
  try {
    const { rows } = await db.query<{
      application_name: string;
      connections: number;
      used: number;
      max: number;
    }>(
      `select coalesce(nullif(application_name, ''), '(unnamed)') as application_name,
              count(*)::int as connections,
              (sum(count(*)) over ())::int as used,
              current_setting('max_connections')::int as max
         from pg_stat_activity
        group by 1
        order by connections desc`,
    );
    const first = rows[0];
    if (!first) return null;
    return {
      used: Number(first.used),
      max: Number(first.max),
      holders: rows.map((row) => ({
        applicationName: row.application_name,
        connections: Number(row.connections),
      })),
    };
  } catch {
    return null;
  }
}

function hostPort(url: string): string {
  try {
    return new URL(url).port || '5432';
  } catch {
    return '5432';
  }
}

/**
 * The RECURRENCE GUARD. Exhaustion is silent until it is total: every DB-backed
 * probe on the box starts returning a connect error that reads like a broken
 * query rather than a full server, so agents report confident wrong answers.
 * Returns null below the threshold so the happy path stays quiet.
 */
export function connectionPressureWarning(
  pressure: ConnectionPressure,
  url: string = DEFAULT_DATABASE_URL,
): string | null {
  if (!Number.isFinite(pressure.max) || pressure.max <= 0) return null;
  if (pressure.used / pressure.max < CONNECTION_PRESSURE_WARN_RATIO) return null;
  const holders = pressure.holders
    .slice(0, 5)
    .map((holder) => `${holder.applicationName}=${holder.connections}`)
    .join(', ');
  return (
    `Postgres connection pressure: ${pressure.used}/${pressure.max} backends in use ` +
    `(>=${Math.round(CONNECTION_PRESSURE_WARN_RATIO * 100)}% of max_connections). ` +
    'At the ceiling EVERY psql and DB-backed probe on this box fails with ' +
    '"sorry, too many clients already" — which reads like a broken query, not a full server. ' +
    `Top holders: ${holders}. ` +
    `List them with: ss -tnp | grep ':${hostPort(url)}'`
  );
}

export async function createPoolOrNull(
  mode: DataBackendMode = dataBackendMode(),
  url: string = databaseUrl(),
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('Database'),
): Promise<Pool | null> {
  if (mode === 'memory') {
    logger.log('DATA_BACKEND=memory — using in-memory stores.');
    return null;
  }
  const pool = new Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 2_000,
    application_name: poolApplicationName(),
  });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (mode === 'pg') {
      throw new Error(`DATA_BACKEND=pg but Postgres is unreachable: ${message}`);
    }
    // EI-20739798038041966: a FULL server and a STOPPED one fail the connect
    // identically, and the remediations are opposites. Telling someone to start a
    // container that is already up sends them away from the real cause (a client
    // leaking pools) and leaves this warning firing verbatim on every boot — the
    // same dead end the "unreachable" text below was written to avoid.
    if (isConnectionExhaustion(error)) {
      logger.warn(
        `Postgres is UP but has no free connection slots (${message}) — falling back to in-memory stores. ` +
          'Starting the data stack will NOT fix this. Some client is leaking pools: find the holders with ' +
          `\`ss -tnp | grep ':${hostPort(url)}'\`, or once a slot frees up ` +
          '`select application_name, count(*) from pg_stat_activity group by 1 order by 2 desc;`.',
      );
      return null;
    }
    // The remediation MUST name the data stack. `docker compose up -d` (the root
    // file) publishes 5432 and mounts no initdb scripts, so it can neither answer
    // DEFAULT_DATABASE_URL's 55434 nor create the schema this fallback is warning
    // about — following it leaves the warning firing verbatim on every boot.
    logger.warn(
      `Postgres unreachable (${message}) — falling back to in-memory stores. ` +
        'Run: docker compose -f infra/docker-compose.data.yml up -d postgres',
    );
    return null;
  }

  const pressure = await readConnectionPressure(pool);
  if (pressure) {
    const warning = connectionPressureWarning(pressure, url);
    if (warning) logger.warn(warning);
  }

  // REACHABLE IS NOT USABLE. db/schema.sql is init-only, so an existing volume can
  // be missing tables the code queries. This check sits OUTSIDE the probe's catch
  // on purpose: drift is fatal in every mode, never a fallback. Routing it into
  // the branch above would silently demote a database that holds real rows to the
  // in-memory stores — stranding that data, and re-hiding exactly the failure this
  // guard exists to surface.
  try {
    await assertSchemaCurrent(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  logger.log(
    `Postgres reachable — durable stores active (${url.replace(/:[^:@/]+@/, ':***@')}), ` +
      `schema OK (${REQUIRED_TABLES.length}/${REQUIRED_TABLES.length} tables, ` +
      `${REQUIRED_OWNERSHIP_STRUCTURES.length}/${REQUIRED_OWNERSHIP_STRUCTURES.length} ownership structures, ` +
      `${REQUIRED_ORDER_STRUCTURES.length}/${REQUIRED_ORDER_STRUCTURES.length} payable-order structures, ` +
      `${REQUIRED_CHAT_STRUCTURES.length}/${REQUIRED_CHAT_STRUCTURES.length} durable-chat structures, ` +
      `${REQUIRED_LINEUP_STRUCTURES.length}/${REQUIRED_LINEUP_STRUCTURES.length} durable-lineup structures, ` +
      `${REQUIRED_ACTION_AUDIT_STRUCTURES.length}/${REQUIRED_ACTION_AUDIT_STRUCTURES.length} action-audit structures).`,
  );
  return pool;
}

/**
 * EI-20739798038041966 — THE POOL'S OWNER AT SHUTDOWN.
 *
 * Nest invokes lifecycle hooks only on providers that IMPLEMENT them. PG_POOL is
 * a raw `pg.Pool` handed back by a useFactory; it implements none, so `app.close()`
 * used to return having released nothing and the connections survived the app that
 * opened them. That is invisible while a process is short-lived and lethal when it
 * is not: `bootstrapWithRetry` re-runs the WHOLE bootstrap after a failed attempt,
 * so a boot that dies AFTER the pool is built (a port conflict is the common one)
 * stranded a live 10-connection pool per attempt, inside one process, forever.
 *
 * This provider exists purely to own that teardown. Nothing injects it.
 */
@Injectable()
export class PgPoolLifecycle implements OnApplicationShutdown {
  private ended = false;

  // Constructed by the module's useFactory, never by Nest's injector — so no
  // @Inject() here, and the defaulted logger stays a plain testing seam.
  constructor(
    private readonly pool: Pool | null,
    private readonly logger: Pick<Logger, 'log' | 'warn'> = new Logger('Database'),
  ) {}

  /** Idempotent: `pool.end()` throws if called twice, and close paths can overlap. */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.pool || this.ended) return;
    this.ended = true;
    try {
      await this.pool.end();
      this.logger.log(`Postgres pool closed${signal ? ` on ${signal}` : ''}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Postgres pool failed to close cleanly: ${message}`);
    }
  }
}

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: () => createPoolOrNull() },
    // Registered via useFactory, not bare: the defaulted `logger` parameter is not
    // injectable under tsc's emitDecoratorMetadata (see
    // nest-bare-provider-registration.test.ts).
    { provide: PgPoolLifecycle, inject: [PG_POOL], useFactory: (pool: Pool | null) => new PgPoolLifecycle(pool) },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
