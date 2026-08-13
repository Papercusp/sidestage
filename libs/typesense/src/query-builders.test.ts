import { describe, it, expect } from 'vitest';
import { collectionNameForRegion, buildFilterBy, capPriceCents } from './client';

/** T2.8 — pure Typesense query builders: collection naming, filter_by, price cap. */

describe('collectionNameForRegion', () => {
  it('uses the base collection for US / empty / default', () => {
    const base = collectionNameForRegion('US');
    expect(collectionNameForRegion()).toBe(base);
    expect(collectionNameForRegion('')).toBe(base);
    expect(collectionNameForRegion('us')).toBe(base);
  });

  it('suffixes a lowercased region for non-US (case-insensitive input)', () => {
    const base = collectionNameForRegion('US');
    expect(collectionNameForRegion('FR')).toBe(`${base}_fr`);
    expect(collectionNameForRegion('fr')).toBe(`${base}_fr`);
    expect(collectionNameForRegion('CA')).toBe(`${base}_ca`);
  });
});

describe('buildFilterBy', () => {
  it('always gates on active:true', () => {
    expect(buildFilterBy({})).toEqual(['active:true']);
  });

  it('adds a single category and backtick-quotes a category array', () => {
    expect(buildFilterBy({ category: 'laptops' })).toContain('category:laptops');
    expect(buildFilterBy({ categories: ['Gaming Laptops', 'Desktops'] })).toContain('category:[`Gaming Laptops`,`Desktops`]');
  });

  it('joins conditions as array-contains-any', () => {
    expect(buildFilterBy({ conditions: ['NEW', 'REF'] })).toContain('conditions:[NEW,REF]');
  });

  it('adds price bounds, omitting a non-finite max', () => {
    expect(buildFilterBy({ priceMinCents: 1000, priceMaxCents: 5000 })).toEqual(
      expect.arrayContaining(['priceCents:>=1000', 'priceCents:<=5000']),
    );
    const infMax = buildFilterBy({ priceMinCents: 1000, priceMaxCents: Infinity });
    expect(infMax).toContain('priceCents:>=1000');
    expect(infMax.some((f) => f.startsWith('priceCents:<='))).toBe(false);
  });

  it('adds qty:>0 only when inStockOnly is set', () => {
    expect(buildFilterBy({ inStockOnly: true })).toContain('qty:>0');
    expect(buildFilterBy({ inStockOnly: false })).not.toContain('qty:>0');
  });

  it('combines all clauses', () => {
    expect(
      buildFilterBy({ category: 'laptops', conditions: ['NEW'], priceMinCents: 500, priceMaxCents: 2000, inStockOnly: true }),
    ).toEqual(['active:true', 'category:laptops', 'conditions:[NEW]', 'priceCents:>=500', 'priceCents:<=2000', 'qty:>0']);
  });
});

describe('capPriceCents', () => {
  it('passes finite values through and caps Infinity at 1e12', () => {
    expect(capPriceCents(5000)).toBe(5000);
    expect(capPriceCents(0)).toBe(0);
    expect(capPriceCents(Infinity)).toBe(1_000_000_000_000);
    expect(capPriceCents(Number.POSITIVE_INFINITY)).toBe(1_000_000_000_000);
  });
});
