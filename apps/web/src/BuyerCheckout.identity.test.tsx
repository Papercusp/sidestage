/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuyerCart } from './buyer-checkout-api';
import { buyerCartStorageKey } from './buyer-checkout-api';

const identity = vi.hoisted(() => ({ buyerId: 'buyer-a' }));
const staleQuery = vi.hoisted(() => ({
  rows: [{
    id: 'cart-a',
    currency: 'USD',
    items: [{ productId: 'held-a', title: 'Buyer A item', priceCents: 2_500, quantity: 1 }],
    subtotalCents: 2_500,
    updatedAt: '2026-08-15T00:00:00.000Z',
  }],
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: staleQuery.rows,
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  }),
  useSyncMutate: (_path: string, fallback: (args: unknown) => unknown) => fallback,
}));

vi.mock('./buyer-identity', () => ({
  useBuyerIdentity: () => ({ buyerId: identity.buyerId, impersonate: vi.fn() }),
}));

import { BuyerCheckoutProvider, useBuyerCheckout } from './BuyerCheckout';

let container: HTMLDivElement;
let root: Root;
let originalLocalStorage: PropertyDescriptor | undefined;

function memoryStorage(): Storage {
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

function CheckoutProbe() {
  const checkout = useBuyerCheckout();
  return (
    <output data-cart-id={checkout?.cartId ?? ''} data-held-count={checkout?.heldItemCount ?? -1}>
      {checkout?.heldProductIds.join(',')}
    </output>
  );
}

function renderProvider() {
  root.render(
    <BuyerCheckoutProvider eventId="event-live" showScout={false}>
      <CheckoutProbe />
    </BuyerCheckoutProvider>,
  );
}

beforeEach(() => {
  identity.buyerId = 'buyer-a';
  staleQuery.rows = [{
    id: 'cart-a',
    currency: 'USD',
    items: [{ productId: 'held-a', title: 'Buyer A item', priceCents: 2_500, quantity: 1 }],
    subtotalCents: 2_500,
    updatedAt: '2026-08-15T00:00:00.000Z',
  }] satisfies BuyerCart[];
  originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: memoryStorage(),
  });
  window.localStorage.setItem(buyerCartStorageKey('buyer-a'), 'cart-a');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalLocalStorage) Object.defineProperty(window, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(window, 'localStorage');
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('BuyerCheckoutProvider principal boundary', () => {
  it('drops the previous buyer cart synchronously when the next buyer has no cart id', async () => {
    await act(async () => renderProvider());
    expect(container.querySelector('output')).toMatchObject({
      dataset: { cartId: 'cart-a', heldCount: '1' },
      textContent: 'held-a',
    });

    identity.buyerId = 'buyer-b';
    await act(async () => renderProvider());

    // The query double deliberately keeps returning buyer A's last payload,
    // matching the adapter behavior that exposed this production leak. The
    // principal-keyed provider must still render a clean buyer B boundary.
    expect(container.querySelector('output')).toMatchObject({
      dataset: { cartId: '', heldCount: '0' },
      textContent: '',
    });
  });
});
