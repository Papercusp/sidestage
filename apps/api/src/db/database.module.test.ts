import { describe, expect, it } from 'vitest';

import { DEFAULT_DATABASE_URL, databaseUrl } from './database.module';

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
