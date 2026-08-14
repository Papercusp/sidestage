/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SyncContext } from '@papercusp/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuctionPanel } from './AuctionPanel';
import type { BuyerAuction } from './auction';

const LEADING_AUCTION: BuyerAuction = {
  id: 'auction-1',
  eventId: 'sunday-drop',
  eventItemId: 'item-1',
  productId: 'mug',
  quantity: 1,
  startingPriceCents: 2_000,
  currentPriceCents: 2_400,
  status: 'active',
  startedAt: '2026-08-14T12:00:00.000Z',
  endsAt: '2099-08-14T12:01:00.000Z',
  bids: [{
    id: 'bid-viewer',
    bidderId: 'guest_viewer',
    displayName: 'You',
    amountCents: 2_400,
    createdAt: '2026-08-14T12:00:10.000Z',
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('AuctionPanel recovery announcements', () => {
  it('announces when an authoritative snapshot replaces the viewer as leader', async () => {
    let auction = LEADING_AUCTION;
    const invalidate = vi.fn();
    const useDataImpl = vi.fn(() => ({
      data: [auction],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate,
      error: null,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bidderId: 'guest_viewer', expiresAt: '2099-01-01T00:00:00.000Z' }),
    }));
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const renderPanel = () => (
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <AuctionPanel
          eventId="sunday-drop"
          products={[{ id: 'mug', title: 'Aurora mug', subtitle: 'Matte' }]}
          bidderId="guest_viewer"
          apiBaseUrl="https://outbid.sidestage.example"
        />
      </SyncContext.Provider>
    );

    try {
      await act(async () => {
        root.render(renderPanel());
        await Promise.resolve();
      });
      expect(container.textContent).toContain('You’re leading');

      auction = {
        ...auction,
        currentPriceCents: 2_700,
        bids: [{
          id: 'bid-other',
          bidderId: 'guest_other',
          displayName: 'Maya',
          amountCents: 2_700,
          createdAt: '2026-08-14T12:00:20.000Z',
        }, ...auction.bids],
      };
      await act(async () => {
        root.render(renderPanel());
        await Promise.resolve();
      });

      const status = container.querySelector('[role="status"]');
      expect(status?.textContent).toBe('You were outbid. The current bid is $27.00.');
      expect(container.textContent).toContain('Maya leads at $27.00');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('surfaces a bid conflict and invalidates the snapshot before inviting a retry', async () => {
    const invalidate = vi.fn();
    const useDataImpl = vi.fn(() => ({
      data: [LEADING_AUCTION],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate,
      error: null,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auctions/access/guest')) {
        return {
          ok: true,
          json: async () => ({ bidderId: 'guest_viewer', expiresAt: '2099-01-01T00:00:00.000Z' }),
        } as Response;
      }
      return {
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ message: 'Bid must be greater than the current price' }),
      } as Response;
    }));
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
            <AuctionPanel
              eventId="sunday-drop"
              bidderId="guest_viewer"
              apiBaseUrl="https://conflict.sidestage.example"
            />
          </SyncContext.Provider>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect((container.querySelector('input') as HTMLInputElement).value).toBe('26.00');
      await act(async () => {
        container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelector('[role="alert"]')?.textContent)
        .toContain('current price is refreshing');
      expect(invalidate).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
