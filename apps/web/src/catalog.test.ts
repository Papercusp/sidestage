import { describe, expect, it } from 'vitest';
import { filterOfflineCatalog, resolveCatalogRows } from './catalog';

describe('catalog sync fallback mapping', () => {
  it('preserves search, availability, type, and pagination semantics offline', () => {
    expect(filterOfflineCatalog({ q: 'espresso', availability: 'in-stock' })).toHaveLength(2);
    expect(filterOfflineCatalog({ productType: 'AUDIO', pageSize: 1, page: 2 })).toEqual([
      expect.objectContaining({ id: 'demo-headphones-sand' }),
    ]);
    expect(filterOfflineCatalog({ productType: 'CAMERA', availability: 'in-stock' }))
      .toHaveLength(2);
  });

  it('keeps the pending-page row fallback identity stable across renders', () => {
    const first = resolveCatalogRows(false, []);
    const second = resolveCatalogRows(false, []);

    expect(first).toBe(second);
    expect(first).toEqual([]);
  });
});
