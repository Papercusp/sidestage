import { describe, expect, it } from 'vitest';

import { GroundedCopilotPipeline } from './copilot.pipeline';
import { ParallelResearchFallback } from './research';
import { CatalogResearchAdapter, UnconfiguredWebResearchSource } from './research.providers';
import type { CatalogPage, CatalogSource, CatalogVariant } from '../catalog/catalog.types';
import type { GroundingContext } from './copilot.types';

function variant(overrides: Partial<CatalogVariant> = {}): CatalogVariant {
  return {
    id: 'v-1',
    groupId: null,
    title: 'Blue mug',
    brand: 'Potter',
    productType: 'mug',
    sku: 'MUG-1',
    color: 'blue',
    condition: null,
    handlingDays: 2,
    priceCents: 1500,
    qty: 6,
    reservedQty: 2,
    availableQty: 4,
    description: 'A ceramic mug.',
    weight: { value: 400, unit: 'g' },
    dimensions: { length: 12, width: 9, height: { value: 10, unit: 'cm' } },
    ...overrides,
  };
}

function catalogWith(rows: CatalogVariant[], onSearch?: () => void): CatalogSource {
  return {
    search: async (): Promise<CatalogPage> => {
      onSearch?.();
      return { rows, page: 1, pageSize: rows.length, total: rows.length, totalIsFloor: false };
    },
    searchOwned: async (): Promise<CatalogPage> => ({
      rows: [], page: 1, pageSize: 0, total: 0, totalIsFloor: false,
    }),
    productTypes: async () => ['mug'],
    variant: async () => rows[0],
  };
}

const context: GroundingContext = {
  eventItems: [],
  catalogProducts: [],
  policy: {
    automationLevel: 'suggest',
    allowAutoActions: false,
    priceFloorCentsByProduct: {},
    maxMarkdownPercent: 20,
    blockedActionKinds: [],
    tone: 'warm',
  },
  sources: [{ id: 'catalog-product:v-1', kind: 'catalog-product', label: 'Blue mug catalog record' }],
};

describe('CatalogResearchAdapter', () => {
  it('reports properties the catalog genuinely projects as supported', () => {
    const adapter = new CatalogResearchAdapter(catalogWith([variant()]));

    expect(adapter.supportsProperties(['color'])).toBe(true);
    expect(adapter.supportsProperties(['color', 'priceCents', 'availableQty'])).toBe(true);
  });

  it('reports a property the catalog does not hold as unsupported', () => {
    const adapter = new CatalogResearchAdapter(catalogWith([variant()]));

    // The whole point of the probe: nothing in the catalog answers this.
    expect(adapter.supportsProperties(['batteryHours'])).toBe(false);
    // One uncovered property in an otherwise-covered ask still fails the probe,
    // because the reply would be missing exactly that fact.
    expect(adapter.supportsProperties(['color', 'batteryHours'])).toBe(false);
  });

  it('treats seller spellings of one property as the same property', () => {
    const adapter = new CatalogResearchAdapter(catalogWith([variant()]));

    expect(adapter.supportsProperties(['Product Type'])).toBe(true);
    expect(adapter.supportsProperties(['product-type'])).toBe(true);
    expect(adapter.supportsProperties(['product_type'])).toBe(true);
  });

  it('projects catalog rows into grounding products with their attributes', async () => {
    const adapter = new CatalogResearchAdapter(catalogWith([variant()]));

    const result = await adapter.search({ eventId: 'e-1', query: 'mug', limit: 5 });

    expect(result.products).toEqual([
      {
        productId: 'v-1',
        title: 'Blue mug',
        priceCents: 1500,
        description: 'A ceramic mug.',
        attributes: {
          brand: 'Potter',
          productType: 'mug',
          sku: 'MUG-1',
          qty: 6,
          availableQty: 4,
          reservedQty: 2,
          color: 'blue',
          handlingDays: 2,
          weight: 400,
          length: 12,
          width: 9,
          height: 10,
        },
      },
    ]);
  });
});

describe('UnconfiguredWebResearchSource', () => {
  it('rejects rather than returning an empty result set', async () => {
    // Returning [] would be indistinguishable from "we looked and the web knew
    // nothing", which is what would let an unresearched claim look grounded.
    await expect(new UnconfiguredWebResearchSource().search({
      eventId: 'e-1', query: 'battery life', limit: 5,
    })).rejects.toThrow(/not configured/i);
  });
});

describe('production research wiring', () => {
  const fallbackFor = (catalog: CatalogSource) => new ParallelResearchFallback(
    new CatalogResearchAdapter(catalog),
    new UnconfiguredWebResearchSource(),
  );

  it('marks the round incomplete when the catalog cannot cover the properties', async () => {
    const result = await fallbackFor(catalogWith([variant()])).retrieve({
      eventId: 'e-1',
      query: 'battery life',
      limit: 5,
      requiredProperties: ['batteryHours'],
    });

    expect(result.usedWebFallback).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(result.degraded).toEqual([
      { provider: 'web', reason: 'provider-failed', detail: expect.stringMatching(/not configured/i) },
    ]);
  });

  it('blocks the draft when a property question could not be researched', async () => {
    const pipeline = new GroundedCopilotPipeline({
      retriever: { retrieve: async () => context },
      researchFallback: fallbackFor(catalogWith([variant()])),
      model: {
        // A model that answers confidently anyway — the case the gate exists
        // for. Nothing about this draft looks wrong on its own.
        generate: async () => ({ reply: 'It lasts about 30 hours.', citations: ['catalog-product:v-1'] }),
      },
    });

    const response = await pipeline.respond({
      eventId: 'e-1',
      message: 'What is the battery life?',
      requiredProperties: ['batteryHours'],
    });

    expect(response.grounding).toBe('insufficient-context');
    expect(response.reply).not.toContain('30 hours');
    expect(response.researchIncomplete).toEqual({
      requiredProperties: ['batteryHours'],
      degraded: [
        { provider: 'web', reason: 'provider-failed', detail: expect.stringMatching(/not configured/i) },
      ],
    });
  });

  it('still sends when the catalog itself covers the asked-for properties', async () => {
    // Calibration for the test above: if this one also blocked, the gate would
    // be refusing everything rather than refusing the UNVERIFIED case.
    let webWouldHaveRun = false;
    const catalog = catalogWith([variant()], () => { webWouldHaveRun = false; });
    const pipeline = new GroundedCopilotPipeline({
      retriever: { retrieve: async () => context },
      researchFallback: fallbackFor(catalog),
      model: {
        generate: async () => ({ reply: 'It is blue.', citations: ['catalog-product:v-1'] }),
      },
    });

    const response = await pipeline.respond({
      eventId: 'e-1',
      // "color", not "colour": citation relevance matches the question's tokens
      // against the source's own attribute names, so the spelling the catalog
      // stores is the spelling that grounds.
      message: 'What color is it?',
      requiredProperties: ['color'],
    });

    expect(response.grounding).toBe('grounded');
    expect(response.reply).toBe('It is blue.');
    expect(response.researchIncomplete).toBeUndefined();
    expect(webWouldHaveRun).toBe(false);
  });
});
