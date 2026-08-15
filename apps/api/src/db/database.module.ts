import { Global, Logger, Module } from '@nestjs/common';
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
 * still boots, while `docker compose up -d` + restart gives durable state.
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

export async function createPoolOrNull(
  mode: DataBackendMode = dataBackendMode(),
  url: string = databaseUrl(),
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('Database'),
): Promise<Pool | null> {
  if (mode === 'memory') {
    logger.log('DATA_BACKEND=memory — using in-memory stores.');
    return null;
  }
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 2_000 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (mode === 'pg') {
      throw new Error(`DATA_BACKEND=pg but Postgres is unreachable: ${message}`);
    }
    logger.warn(`Postgres unreachable (${message}) — falling back to in-memory stores. Run: docker compose up -d`);
    return null;
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

@Global()
@Module({
  providers: [{ provide: PG_POOL, useFactory: () => createPoolOrNull() }],
  exports: [PG_POOL],
})
export class DatabaseModule {}
