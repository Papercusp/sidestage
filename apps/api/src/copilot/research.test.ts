import { describe, expect, it } from 'vitest';

import {
  mergeResearchIntoGroundingContext,
  ParallelResearchFallback,
} from './research';
import type { GroundingContext } from './copilot.types';

const request = {
  eventId: 'event-1',
  query: 'What is the battery life?',
  limit: 4,
  requiredProperties: ['batteryHours'],
};

describe('ParallelResearchFallback', () => {
  it('starts web retrieval before an insufficient catalog search resolves', async () => {
    let releaseCatalog!: () => void;
    let webStarted = false;
    const catalogResult = new Promise<{ products: [] }>((resolve) => {
      releaseCatalog = () => resolve({ products: [] });
    });
    const fallback = new ParallelResearchFallback(
      {
        supportsProperties: () => false,
        search: async () => catalogResult,
      },
      {
        search: async () => {
          webStarted = true;
          return [{ findingId: 'f-1', title: 'Battery life', snippet: 'Up to 30 hours.' }];
        },
      },
    );

    const resultPromise = fallback.retrieve(request);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(webStarted).toBe(true);
    releaseCatalog();
    await expect(resultPromise).resolves.toMatchObject({
      usedWebFallback: true,
      webFindings: [{ findingId: 'f-1' }],
    });
  });

  it('does not call web retrieval when the catalog supports the requested properties', async () => {
    let webCalls = 0;
    const fallback = new ParallelResearchFallback(
      {
        supportsProperties: () => true,
        search: async () => ({ products: [{ productId: 'p-1', title: 'Headphones', priceCents: 2000, attributes: {} }] }),
      },
      {
        search: async () => {
          webCalls += 1;
          return [];
        },
      },
    );

    await expect(fallback.retrieve(request)).resolves.toMatchObject({ usedWebFallback: false });
    expect(webCalls).toBe(0);
  });
});

describe('mergeResearchIntoGroundingContext', () => {
  it('adds research products/findings and deduplicates sources', () => {
    const context: GroundingContext = {
      eventItems: [],
      catalogProducts: [],
      policy: {
        automationLevel: 'suggest',
        allowAutoActions: false,
        priceFloorCentsByProduct: {},
        maxMarkdownPercent: 20,
        blockedActionKinds: [],
        tone: 'concise',
      },
      sources: [],
    };

    const merged = mergeResearchIntoGroundingContext(context, {
      catalogProducts: [{ productId: 'p-1', title: 'Headphones', priceCents: 2000, attributes: {} }],
      webFindings: [{ findingId: 'f-1', title: 'Battery life', snippet: '30 hours.' }],
      usedWebFallback: true,
    });
    const mergedAgain = mergeResearchIntoGroundingContext(merged, {
      catalogProducts: [{ productId: 'p-1', title: 'Headphones', priceCents: 2000, attributes: {} }],
      webFindings: [{ findingId: 'f-1', title: 'Battery life', snippet: '30 hours.' }],
      usedWebFallback: true,
    });

    expect(mergedAgain.catalogProducts).toHaveLength(1);
    expect(mergedAgain.webFindings).toHaveLength(1);
    expect(mergedAgain.sources).toEqual([
      { id: 'catalog-product:p-1', kind: 'catalog-product', label: 'Headphones catalog record' },
      { id: 'web-research:f-1', kind: 'web-research', label: 'Battery life' },
    ]);
  });
});
