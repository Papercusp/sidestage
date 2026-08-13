import { describe, expect, it } from 'vitest';

import { LOAD_CORPUS, simulateLoad } from './load-simulator';

describe('load simulator', () => {
  it('creates N clients at M messages per second for the requested duration', () => {
    const result = simulateLoad({ users: 3, messagesPerSecond: 2, durationSeconds: 4 });

    expect(result.clients).toEqual(['test-client-1', 'test-client-2', 'test-client-3']);
    expect(result.totalMessages).toBe(24);
    expect(result.messages.filter((message) => message.clientId === 'test-client-2')).toHaveLength(8);
    expect(result.messages.filter((message) => message.clientId === 'test-client-1').map((message) => message.elapsedMs)).toEqual([
      0, 500, 1000, 1500, 2000, 2500, 3000, 3500,
    ]);
  });

  it('covers the scripted price/shipping/policy/variant/stock/offer/bid corpus', () => {
    const result = simulateLoad({ users: 2, messagesPerSecond: 7, durationSeconds: 1 });

    expect(result.coverage.expectedKinds).toEqual(LOAD_CORPUS.map((entry) => entry.kind));
    expect(result.coverage.observedKinds).toEqual(result.coverage.expectedKinds);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.counts).toEqual({
      price: 2,
      shipping: 2,
      policy: 2,
      variant: 2,
      stock: 2,
      offer: 2,
      bid: 2,
    });
  });

  it('rejects non-positive scenario dimensions', () => {
    expect(() => simulateLoad({ users: 0, messagesPerSecond: 1, durationSeconds: 1 })).toThrow(/users/);
    expect(() => simulateLoad({ users: 1, messagesPerSecond: 1.5, durationSeconds: 1 })).toThrow(/messagesPerSecond/);
    expect(() => simulateLoad({ users: 1, messagesPerSecond: 1, durationSeconds: 0 })).toThrow(/durationSeconds/);
  });

  it('supports a narrow custom corpus while retaining deterministic coverage reporting', () => {
    const result = simulateLoad({
      users: 1,
      messagesPerSecond: 2,
      durationSeconds: 2,
      corpus: [
        { kind: 'stock', prompt: 'How many remain?' },
        { kind: 'bid', prompt: 'Bid now.' },
      ],
    });

    expect(result.coverage).toMatchObject({
      expectedKinds: ['stock', 'bid'],
      observedKinds: ['stock', 'bid'],
      complete: true,
    });
    expect(result.messages.map((message) => message.kind)).toEqual(['stock', 'bid', 'stock', 'bid']);
  });
});
