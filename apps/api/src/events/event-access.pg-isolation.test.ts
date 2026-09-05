/**
 * P-008 clause 1 — two-seller isolation under the **pg** backend.
 * Plan sidestage-demo-user-isolation-2026-08-14, Decision D-011.
 *
 * ## Why this file exists when event-access.cross-seller.test.ts already passes
 *
 * That matrix is exhaustive but runs entirely on the in-memory stores:
 * `vitest.config.mts` pins `DATA_BACKEND: 'memory'` so the default suite stays
 * hermetic and docker-free. The parity suites next door
 * (`sync/parity/{seller,buyer,operational}.parity.test.ts`) do compare memory
 * against pg, but they carry only policy-CLASS strings — `seller-owned`,
 * `seller-scoped` — and no concrete principals, so they prove parity of query
 * SHAPES, not that isolation survives the swap.
 *
 * That leaves the gap D-011 named: an isolation guarantee proven only in
 * memory is not proven for what ships. The in-memory stores enforce ownership
 * in TypeScript; the pg stores enforce it in SQL predicates. Those are two
 * different implementations of one invariant, and only one of them was under
 * test. This file asserts the invariant against the implementation that
 * actually runs in production.
 *
 * ## Gating
 *
 * `SIDESTAGE_PG_INTEGRATION=1`, this repo's existing opt-in for real-Postgres
 * coverage (`sync/parity/differential.integration.test.ts`). Run it with:
 *
 *   SIDESTAGE_PG_INTEGRATION=1 npm run test:file -- \
 *     apps/api/src/events/event-access.pg-isolation.test.ts
 *
 * The database is provisioned HERMETICALLY by `createMigratedTestDb`, which
 * applies `db/schema.sql` to a throwaway database on a reused test container.
 * It deliberately does NOT dial `DEFAULT_DATABASE_URL` (127.0.0.1:55434): that
 * is the shared dev database, and unit tests reaching it is the exact
 * non-hermeticity that red-pinned the gate once already (plan
 * sidestage-websocket-sync-cutover-2026-08-17, D-019).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { bootNestTestApp, type NestTestApp } from '@papercusp/test-config/nest';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';

const ARMED = process.env.SIDESTAGE_PG_INTEGRATION === '1';

const AVI = 'seller-avi-pg';
const MIRA = 'seller-mira-pg';
const AVI_EVENT = 'avi-pg-drop-2026-09-05';
const MIRA_EVENT = 'mira-pg-drop-2026-09-05';
const ABSENT_EVENT = 'no-such-pg-event-2026-09-05';

/** Walk up from the vitest cwd to the repo root (the one holding db/schema.sql). */
function findSchemaSql(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'db', 'schema.sql');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate db/schema.sql from ${process.cwd()}`);
}

const principal = <T extends { set: (name: string, value: string) => unknown }>(
  request: T,
  value: string,
): T => {
  request.set(DEMO_PRINCIPAL_HEADER, value);
  return request;
};

describe.runIf(ARMED)('two-seller isolation under the pg backend', () => {
  let db: MigratedTestDb;
  let nest: NestTestApp;

  beforeAll(async () => {
    db = await createMigratedTestDb([findSchemaSql()]);

    // Both must be set BEFORE AppModule is imported: createPoolOrNull() reads
    // them at bootstrap, so a static import at the top of this file would have
    // already chosen the in-memory stores and the suite would silently test
    // nothing. Hence the dynamic import below.
    process.env.DATABASE_URL = db.url;
    process.env.DATA_BACKEND = 'pg';

    const { AppModule } = await import('../app.module');
    nest = await bootNestTestApp({ metadata: { imports: [AppModule] } });

    // Each seller creates its own event through the real create seam, exactly
    // as the in-memory matrix does — the ids under test are real rows written
    // by production code paths, not fixtures inserted behind the app's back.
    await principal(nest.request.put(`/events/${AVI_EVENT}/config`), AVI)
      .send({ name: 'Avi pg drop' })
      .expect(200);
    await principal(nest.request.put(`/events/${MIRA_EVENT}/config`), MIRA)
      .send({ name: 'Mira pg drop' })
      .expect(200);
  }, 180_000);

  // DROP DATABASE is I/O-heavy and serialised behind the shared drop lock
  // (pg-migrate.ts: TEST_DB_DROP_STATEMENT_TIMEOUT_MS = 20s), so the default
  // 10s hook budget fails the suite on teardown alone while every test passed.
  afterAll(async () => {
    await nest?.close();
    await db?.drop();
  }, 60_000);

  it('is really running against Postgres, not the in-memory stores', () => {
    // Guards the whole file against passing vacuously: every assertion below
    // would also pass on the memory backend, so if the env opt-in above ever
    // stops taking effect this suite must fail rather than re-prove the matrix.
    expect(process.env.DATA_BACKEND).toBe('pg');
    expect(db.url).toContain('postgres');
  });

  it('hides seller A\'s event from seller B, indistinguishably from an absent id', async () => {
    const own = await principal(nest.request.get(`/events/${AVI_EVENT}/config`), AVI);
    expect(own.status).toBe(200);

    const foreign = await principal(nest.request.get(`/events/${AVI_EVENT}/config`), MIRA);
    const absent = await principal(nest.request.get(`/events/${ABSENT_EVENT}/config`), MIRA);

    // Not merely "denied": a 403 would confirm the resource EXISTS, which is
    // itself a cross-identity disclosure. Foreign must be byte-identical to absent.
    expect(foreign.status).toBe(absent.status);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(absent.body);
  });

  it('refuses to let seller B overwrite seller A\'s event through the create seam', async () => {
    const hijack = await principal(nest.request.put(`/events/${AVI_EVENT}/config`), MIRA)
      .send({ name: 'hijacked' });
    expect(hijack.status).toBe(404);

    // The owner's row must be untouched by the attempt.
    const after = await principal(nest.request.get(`/events/${AVI_EVENT}/config`), AVI);
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).not.toContain('hijacked');
  });

  it('GET /events/mine shows each seller only its own rows', async () => {
    const aviIds = await principal(nest.request.get('/events/mine'), AVI);
    const miraIds = await principal(nest.request.get('/events/mine'), MIRA);

    const ids = (response: { body: unknown }): string[] =>
      JSON.stringify(response.body).match(/[a-z0-9-]+-pg-drop-2026-09-05/g) ?? [];

    expect(ids(aviIds)).toContain(AVI_EVENT);
    expect(ids(aviIds)).not.toContain(MIRA_EVENT);
    expect(ids(miraIds)).toContain(MIRA_EVENT);
    expect(ids(miraIds)).not.toContain(AVI_EVENT);
  });
});
