import { describe, it, expect } from 'vitest';
import { docFrom } from './typesense-sync.ts';

/**
 * EI-20408260360752667 — the Typesense index carried a `conditions` facet but no
 * colour facet, even though WI-38716 made colour the SideStage variant axis. A
 * colour-only query therefore could not match or facet on the Typesense path and
 * fell through to the SQL `v.slug ILIKE` branch, which by design runs ONLY when
 * the primary tsvector query returns zero rows — so `q=walnut` returned unrelated
 * title matches and never reached the walnut variant.
 *
 * These cover the group-document projection: the SQL that feeds it is exercised
 * by the live resync, not here.
 */

/** One storefront_product row joined to product_catalog, as the sync SELECTs it. */
function row(overrides = {}) {
  return {
    id: 'v1',
    slug: 'demo-desk',
    price_cents: 1000,
    group_id: 'g1',
    condition: 'new',
    qty: 5,
    available_qty: 5,
    group_key: 'g1',
    color: null,
    title: 'Demo Desk',
    description: 'A desk.',
    brand: 'Acme',
    product_type: 'Desks',
    images: [{ url: 'https://img/1.png', isPrimary: true }],
    tiers: null,
    ...overrides,
  };
}

describe('docFrom — colours facet', () => {
  it('collects the SET of distinct colours across the group\'s variants', () => {
    const doc = docFrom([
      row({ id: 'v1', color: 'Walnut' }),
      row({ id: 'v2', color: 'Matte Black' }),
    ]);
    expect(doc.colors).toEqual(['Walnut', 'Matte Black']);
  });

  it('preserves label casing — colours are display values, not codes like conditions', () => {
    const doc = docFrom([row({ color: 'Walnut', condition: 'new' })]);
    // Colour keeps its label casing…
    expect(doc.colors).toEqual(['Walnut']);
    // …while the condition CODE is still upper-cased (regression guard).
    expect(doc.conditions).toEqual(['NEW']);
  });

  it('dedupes repeated colours and trims surrounding whitespace', () => {
    const doc = docFrom([
      row({ id: 'v1', color: 'Walnut' }),
      row({ id: 'v2', color: '  Walnut  ' }),
      row({ id: 'v3', color: 'Oak' }),
    ]);
    expect(doc.colors).toEqual(['Walnut', 'Oak']);
  });

  it('omits `colors` entirely when no variant carries a colour', () => {
    const doc = docFrom([row({ color: null }), row({ id: 'v2', color: '' })]);
    // Not `[]` — the ~1.1M rows predating the colour axis must not each ship an
    // empty array. The field is declared `optional` in COLLECTION_SCHEMA.
    expect(doc.colors).toBeUndefined();
    expect('colors' in doc).toBe(false);
  });

  it('drops null/blank colours but keeps the ones that are set', () => {
    const doc = docFrom([
      row({ id: 'v1', color: null }),
      row({ id: 'v2', color: 'Walnut' }),
      row({ id: 'v3', color: '   ' }),
    ]);
    expect(doc.colors).toEqual(['Walnut']);
  });

  it('leaves the rest of the group document unchanged', () => {
    const doc = docFrom([
      row({ id: 'v1', price_cents: 3000, color: 'Walnut' }),
      row({ id: 'v2', price_cents: 1000, color: 'Oak', condition: 'ref' }),
    ]);
    expect(doc.id).toBe('g1');
    expect(doc.name).toBe('Demo Desk');
    expect(doc.minPriceCents).toBe(1000);
    expect(doc.maxPriceCents).toBe(3000);
    expect(doc.conditions).toEqual(['NEW', 'REF']);
    expect(doc.qty).toBe(10);
  });
});
