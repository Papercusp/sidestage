/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SyncProvider } from '@papercusp/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_IDENTITY_STORAGE_KEY } from './buyer-identity';
import { OrdersTab, type BuyerOrder } from './OrdersTab';

type FakeListener = (event: { data: string; lastEventId?: string; type: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Set<FakeListener>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    const callback = typeof listener === 'function'
      ? listener as unknown as FakeListener
      : listener.handleEvent.bind(listener) as unknown as FakeListener;
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data = '') {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data, type });
    }
  }

  static latest(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error('Expected SyncProvider to open an EventSource');
    return source;
  }
}

const initialOrder: BuyerOrder = {
  id: 'order-live',
  source: 'checkout',
  buyerId: 'buyer-placeholder',
  eventId: 'event-live',
  eventTitle: 'Live sync studio',
  sellerName: 'SideStage Supply',
  status: 'pending',
  createdAt: '2026-08-14T14:00:00.000Z',
  subtotalCents: 3200,
  shippingCents: 0,
  totalCents: 3200,
  currency: 'USD',
  items: [{ productId: 'initial-item', title: 'Pending studio order', quantity: 1, unitPriceCents: 3200 }],
  videoSnapshots: [],
};

const writerFamilies = [
  { label: 'checkout creation and payment', slug: 'checkout-payment', source: 'checkout' as const },
  { label: 'auction winner settlement', slug: 'auction-winner', source: 'auction' as const },
  { label: 'targeted-offer action', slug: 'targeted-offer', source: 'offer' as const },
];

let container: HTMLDivElement;
let root: Root | null;
let originalLocalStorage: PropertyDescriptor | undefined;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

async function waitFor(assertion: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Timed out waiting for live Orders state');
}

beforeEach(() => {
  FakeEventSource.instances = [];
  originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: createMemoryStorage(),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container.remove();
  window.localStorage.clear();
  if (originalLocalStorage) Object.defineProperty(window, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(window, 'localStorage');
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('OrdersTab live sync', () => {
  it.each(writerFamilies)(
    'replaces the visible buyer order after a same-buyer invalidation from $label',
    async ({ label, slug, source }) => {
      const buyerId = `buyer-${slug}`;
      const endpoint = `http://sync.test/${slug}`;
      const updatedTitle = `${label} completed order`;
      window.localStorage.setItem(DEMO_IDENTITY_STORAGE_KEY, buyerId);

      const responses: BuyerOrder[][] = [
        [{ ...initialOrder, buyerId }],
        [{
          ...initialOrder,
          buyerId,
          source,
          status: 'paid',
          items: [{ productId: `${slug}-item`, title: updatedTitle, quantity: 1, unitPriceCents: 3200 }],
        }],
      ];
      let responseIndex = 0;
      const requestBodies: unknown[] = [];
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        const rows = responses[Math.min(responseIndex, responses.length - 1)];
        responseIndex += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ rows, version: String(responseIndex) }] }),
        } as Response;
      });
      vi.stubGlobal('fetch', fetchMock);

      await act(async () => {
        root?.render(
          <SyncProvider
            syncType="SSE"
            restEndpoint={endpoint}
            endpointOverride={`${endpoint}/sse`}
            pollIntervalMs={60_000}
          >
            <OrdersTab />
          </SyncProvider>,
        );
      });

      await waitFor(() => {
        expect(container.textContent).toContain('Pending studio order');
        expect(FakeEventSource.latest().url).toBe(`${endpoint}/sse`);
      });

      await act(async () => {
        FakeEventSource.latest().emit('invalidate', JSON.stringify({
          name: 'orders.byBuyer',
          args: { buyerId },
          provenance: slug,
        }));
      });

      await waitFor(() => {
        expect(container.textContent).toContain(updatedTitle);
        expect(container.textContent).not.toContain('Pending studio order');
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        `${endpoint}/rest-query-batch`,
        `${endpoint}/rest-query-batch`,
      ]);
      expect(requestBodies).toEqual([
        { queries: [{ name: 'orders.byBuyer', args: { buyerId } }] },
        { queries: [{ name: 'orders.byBuyer', args: { buyerId } }] },
      ]);
    },
  );
});
