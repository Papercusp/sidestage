import { describe, expect, it } from 'vitest';
import { OFFLINE_FIXTURE, filterOfflineCatalog, resolveCatalogRows, variantToBuyerProduct } from './catalog';

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

/**
 * The offline mirror of the API's DEMO_CATALOG_FIXTURE. It is rendered when the
 * API is unreachable, which is exactly when nobody is watching — so the colour
 * axis has to hold here too, or the offline shop silently reverts to listing
 * each product twice under one label (WI-38716).
 */
describe('the offline demo fixture sells on a COLOUR axis', () => {
  it('gives every offline variant a colour', () => {
    expect(OFFLINE_FIXTURE.filter((variant) => !variant.color).map((v) => v.id)).toEqual([]);
  });

  it('distinguishes the variants within a product group by colour alone', () => {
    const groups = new Map<string, typeof OFFLINE_FIXTURE[number][]>();
    for (const variant of OFFLINE_FIXTURE) {
      const key = variant.groupId ?? variant.id;
      groups.set(key, [...(groups.get(key) ?? []), variant]);
    }

    expect(groups.size).toBeGreaterThan(1);
    for (const [groupId, variants] of groups) {
      expect(new Set(variants.map((v) => v.color)).size, `${groupId} repeats a colour`)
        .toBe(variants.length);
      expect(new Set(variants.map((v) => v.condition)).size, `${groupId} varies condition`).toBe(1);
      expect(new Set(variants.map((v) => v.handlingDays)).size, `${groupId} varies handling`).toBe(1);
    }
  });

  it('puts the colour in the buyer subtitle, and the grade only when there is none', () => {
    const [espresso] = OFFLINE_FIXTURE;
    expect(variantToBuyerProduct(espresso).subtitle).toBe('BrewHaus · Matte Black');
    // An imported row with no colour axis still needs a subtitle.
    expect(variantToBuyerProduct({ ...espresso, color: undefined }).subtitle)
      .toBe('BrewHaus · NEW');
  });
});
