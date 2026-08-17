/** @vitest-environment jsdom */

/**
 * The mobile sticky CTA renders OUTSIDE the current-offer slot, so it can name a
 * different item than the auction module directly above it — which is exactly
 * what it did: `currentProduct` was `visibleProducts[0]`, unrelated to the
 * auctioned product, and BuyerTab held no auction state at all.
 *
 * These are CONSUMER-side guards: AuctionPanel is stubbed so the assertions turn
 * only on whether BuyerTab honours the lifted product identity. The producer
 * side — that the real panel actually publishes that identity — is guarded in
 * auction-recovery.test.tsx; both halves are needed, since either one passing
 * alone leaves the CTA free to name the wrong item.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BuyerTab } from './BuyerTab';
import type { BuyerProduct } from './buyer';

const onChangeCalls = vi.hoisted(() => ({ productId: null as string | null }));

vi.mock('./AuctionPanel', () => ({
  AuctionPanel: ({
    onActiveAuctionProductChange,
  }: {
    onActiveAuctionProductChange?: (productId: string | null) => void;
  }) => {
    onActiveAuctionProductChange?.(onChangeCalls.productId);
    return null;
  },
}));
vi.mock('./ReplayChapters', () => ({ ReplayChapters: () => null }));
vi.mock('./streaming', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./streaming')>();
  return { ...actual, connectViewer: vi.fn(async () => { throw new Error('no stream in this test'); }) };
});
vi.mock('@papercusp/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/sync')>();
  return {
    ...actual,
    useSyncPrincipal: () => 'current-offer-test-buyer',
    useSyncQuery: vi.fn(() => ({ data: [], error: null, invalidate: vi.fn() })),
    useSyncMutate: (_name: string, fallback: (input: unknown) => Promise<unknown>) => fallback,
  };
});

const PRODUCTS: BuyerProduct[] = [
  { id: 'first-in-catalog', title: 'First in catalog', subtitle: 'Edition 1', priceCents: 2_000, availableQty: 3 },
  { id: 'second-in-catalog', title: 'Second in catalog', subtitle: 'Edition 2', priceCents: 2_100, availableQty: 2 },
  { id: 'under-the-hammer', title: 'Under the hammer', subtitle: 'Edition 3', priceCents: 2_200, availableQty: 1 },
];

/** The sticky mobile CTA only — never the whole document, whose other panes also name products. */
function stickyCtaText(container: HTMLElement): string {
  return container.querySelector('.buyer-mobile-action')?.textContent ?? '';
}

describe('BuyerTab current offer follows the auctioned product', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    onChangeCalls.productId = null;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('names the auctioned product in the sticky mobile CTA, not whatever sorts first', async () => {
    onChangeCalls.productId = 'under-the-hammer';
    await act(async () => root?.render(
      <BuyerTab
        eventId="sunday-drop"
        eventTitle="Sunday drop"
        products={PRODUCTS}
        stats={{ viewers: 0, itemsSold: 0, totalRaisedCents: 0 }}
        guideEvents={[]}
      />,
    ));

    const cta = stickyCtaText(container);
    expect(cta).toContain('Under the hammer');
    // The defect: the CTA named the first catalog product while the auction ran
    // on a different one. Asserting the absence is what makes this falsifiable.
    expect(cta).not.toContain('First in catalog');
  });

  it('falls back to catalog order when no auction is running', async () => {
    onChangeCalls.productId = null;
    await act(async () => root?.render(
      <BuyerTab
        eventId="sunday-drop"
        eventTitle="Sunday drop"
        products={PRODUCTS}
        stats={{ viewers: 0, itemsSold: 0, totalRaisedCents: 0 }}
        guideEvents={[]}
      />,
    ));

    // Paired with the test above: without this, the first test would still pass
    // if BuyerTab named the LAST product, or any product, for the wrong reason.
    const cta = stickyCtaText(container);
    expect(cta).toContain('First in catalog');
    expect(cta).not.toContain('Under the hammer');
  });
});
