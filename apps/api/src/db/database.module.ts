import { Global, Logger, Module } from '@nestjs/common';
import { Pool } from 'pg';

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

export type DataBackendMode = 'auto' | 'pg' | 'memory';

export function dataBackendMode(raw: string | undefined = process.env.DATA_BACKEND): DataBackendMode {
  const value = (raw ?? 'auto').trim().toLowerCase();
  if (value === 'pg' || value === 'memory') return value;
  return 'auto';
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? 'postgresql://sidestage:dev-only-change-me@localhost:5432/sidestage';
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
    logger.log(`Postgres reachable — durable stores active (${url.replace(/:[^:@/]+@/, ':***@')}).`);
    return pool;
  } catch (error) {
    await pool.end().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    if (mode === 'pg') {
      throw new Error(`DATA_BACKEND=pg but Postgres is unreachable: ${message}`);
    }
    logger.warn(`Postgres unreachable (${message}) — falling back to in-memory stores. Run: docker compose up -d`);
    return null;
  }
}

@Global()
@Module({
  providers: [{ provide: PG_POOL, useFactory: () => createPoolOrNull() }],
  exports: [PG_POOL],
})
export class DatabaseModule {}
