import { describe, expect, it } from 'vitest';

import { DEFAULT_DATABASE_URL, createPoolOrNull, dataBackendMode, databaseUrl } from './database.module';

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
