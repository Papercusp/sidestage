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

  it('degrades to catalog-only when the web provider fails, instead of rejecting the round', async () => {
    const fallback = new ParallelResearchFallback(
      {
        supportsProperties: () => false,
        search: async () => ({ products: [{ productId: 'p-1', title: 'Headphones', priceCents: 2000, attributes: {} }] }),
      },
      { search: async () => { throw new Error('web provider down'); } },
    );

    const result = await fallback.retrieve(request);

    // Research is an enrichment: a dead web provider must cost us the FINDINGS,
    // never the reply.
    expect(result.catalogProducts).toHaveLength(1);
    expect(result.webFindings).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.degraded).toEqual([
      { provider: 'web', reason: 'provider-failed', detail: 'web provider down' },
    ]);
  });

  it('degrades to web-only when the catalog provider fails', async () => {
    const fallback = new ParallelResearchFallback(
      {
        supportsProperties: () => false,
        search: async () => { throw new Error('catalog down'); },
      },
      { search: async () => [{ findingId: 'f-1', title: 'Battery life', snippet: '30 hours.' }] },
    );

    const result = await fallback.retrieve(request);

    expect(result.catalogProducts).toEqual([]);
    expect(result.webFindings).toHaveLength(1);
    expect(result.degraded).toEqual([
      { provider: 'catalog', reason: 'provider-failed', detail: 'catalog down' },
    ]);
  });

  it('falls back to the web when the capability probe itself throws', async () => {
    // An unanswerable probe must NOT be read as "the catalog covers it".
    let webCalls = 0;
    const fallback = new ParallelResearchFallback(
      {
        supportsProperties: () => { throw new Error('probe exploded'); },
        search: async () => ({ products: [] }),
      },
      {
        search: async () => {
          webCalls += 1;
          return [{ findingId: 'f-1', title: 'Battery life', snippet: '30 hours.' }];
        },
      },
    );

    const result = await fallback.retrieve(request);

    expect(webCalls).toBe(1);
    expect(result.usedWebFallback).toBe(true);
    expect(result.degraded).toContainEqual(
      { provider: 'catalog', reason: 'provider-failed', detail: 'probe exploded' },
    );
  });

  it('enforces the shared deadline and reports which provider it dropped', async () => {
    const fallback = new ParallelResearchFallback(
      {
        supportsProperties: () => false,
        search: async () => ({ products: [{ productId: 'p-1', title: 'Headphones', priceCents: 2000, attributes: {} }] }),
      },
      // Never resolves. Without a deadline this hangs the seller's reply forever.
      { search: () => new Promise(() => {}) },
      { deadlineMs: 10 },
    );

    const result = await fallback.retrieve(request);

    expect(result.catalogProducts).toHaveLength(1);
    expect(result.webFindings).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.degraded).toEqual([
      expect.objectContaining({ provider: 'web', reason: 'deadline-exceeded' }),
    ]);
  });

  it('discards a finding that arrives after the deadline', async () => {
    let resolveLate!: (findings: readonly { findingId: string; title: string; snippet: string }[]) => void;
    const fallback = new ParallelResearchFallback(
      {
        supportsProperties: () => false,
        search: async () => ({ products: [] }),
      },
      { search: () => new Promise((resolve) => { resolveLate = resolve; }) },
      { deadlineMs: 10 },
    );

    const result = await fallback.retrieve(request);
    // The provider comes back AFTER the round closed.
    resolveLate([{ findingId: 'f-late', title: 'Too late', snippet: 'Arrived after the budget.' }]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A late finding must never reach a reply that was already composed without it.
    expect(result.webFindings).toEqual([]);
    expect(result.degraded).toEqual([
      expect.objectContaining({ provider: 'web', reason: 'deadline-exceeded' }),
    ]);
  });

  it('hands every provider the same signal and aborts it when the round closes', async () => {
    const seen: AbortSignal[] = [];
    const fallback = new ParallelResearchFallback(
      {
        supportsProperties: () => false,
        search: async (scoped) => {
          seen.push(scoped.signal!);
          return { products: [] };
        },
      },
      {
        search: async (scoped) => {
          seen.push(scoped.signal!);
          return [];
        },
      },
    );

    await fallback.retrieve(request);

    expect(seen).toHaveLength(2);
    // SHARED, not one budget each.
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]!.aborted).toBe(true);
  });

  it('propagates a caller cancellation to the providers', async () => {
    const controller = new AbortController();
    const fallback = new ParallelResearchFallback(
      {
        supportsProperties: () => false,
        search: () => new Promise(() => {}),
      },
      { search: () => new Promise(() => {}) },
    );

    const pending = fallback.retrieve({ ...request, signal: controller.signal });
    controller.abort(new Error('seller navigated away'));
    const result = await pending;

    expect(result.incomplete).toBe(true);
    expect(result.degraded.map((entry) => entry.reason)).toEqual(['cancelled', 'cancelled']);
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
      incomplete: false,
      degraded: [],
    });
    const mergedAgain = mergeResearchIntoGroundingContext(merged, {
      catalogProducts: [{ productId: 'p-1', title: 'Headphones', priceCents: 2000, attributes: {} }],
      webFindings: [{ findingId: 'f-1', title: 'Battery life', snippet: '30 hours.' }],
      usedWebFallback: true,
      incomplete: false,
      degraded: [],
    });

    expect(mergedAgain.catalogProducts).toHaveLength(1);
    expect(mergedAgain.webFindings).toHaveLength(1);
    expect(mergedAgain.sources).toEqual([
      { id: 'catalog-product:p-1', kind: 'catalog-product', label: 'Headphones catalog record' },
      { id: 'web-research:f-1', kind: 'web-research', label: 'Battery life' },
    ]);
  });
});
