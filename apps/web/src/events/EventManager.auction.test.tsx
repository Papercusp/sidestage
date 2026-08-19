/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext } from '@papercusp/sync';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventManager, type SellerOwnedEvent } from './EventManager';
import { type SellerAuction, type SellerEventItem } from './api';

const ITEMS: SellerEventItem[] = [{
  eventId: 'sunday-drop',
  eventItemId: 'sunday-drop:mug',
  productId: 'mug',
  title: 'Aurora mug',
  currentPriceCents: 2_000,
  currentQuantity: 4,
  listedQuantity: 2,
  stageState: 'on-stage',
  attributes: { brand: 'Northstar', sku: 'MUG-1' },
}];

const EVENTS: SellerOwnedEvent[] = [{
  eventId: 'sunday-drop',
  title: 'Sunday drop',
  sellerId: 'seller-1',
  sellerName: 'Host',
  status: 'live',
  startsAt: '2026-08-14T12:00:00.000Z',
  endedAt: null,
}];

const LIVE_AUCTION: SellerAuction = {
  id: 'auction-1',
  eventId: 'sunday-drop',
  eventItemId: 'sunday-drop:mug',
  productId: 'mug',
  quantity: 1,
  startingPriceCents: 2_000,
  currentPriceCents: 2_700,
  status: 'active',
  startedAt: '2026-08-14T12:00:00.000Z',
  endsAt: '2099-08-14T12:01:00.000Z',
};

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, '', '/?tab=seller&studio=event-manager&manager=events&event=sunday-drop');
});

function renderManager(auction: SellerAuction): { markup: string; useDataImpl: ReturnType<typeof vi.fn> } {
  const useDataImpl = vi.fn((options: { queryName: string }) => ({
    data: options.queryName === 'event.auction.active' ? [auction] : [],
    loading: false,
    fetching: false,
    transport: 'SSE',
    invalidate: vi.fn(),
    error: null,
  }));
  const markup = renderToStaticMarkup(
    <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
      <EventManager
        actorId="seller-1"
        eventId="sunday-drop"
        initialItems={ITEMS}
        initialEvents={EVENTS}
      />
    </SyncContext.Provider>,
  );
  return { markup, useDataImpl };
}

describe('EventManager auction recovery', () => {
  it('reads the authoritative current auction and permits principal-authorized close', () => {
    const { markup, useDataImpl } = renderManager(LIVE_AUCTION);

    expect(useDataImpl).toHaveBeenCalledWith({
      queryName: 'event.auction.active',
      args: { eventId: 'sunday-drop' },
      enabled: true,
      pollIntervalMs: 2_000,
      staleTime: 0,
    });
    expect(markup).toContain('Live auction');
    expect(markup).toContain('Current bid $27.00');
    expect(markup).toMatch(/<button class="button secondary" type="button">Close auction<\/button>/);
  });

  /*
   * WHERE THE no-second-auction GUARDRAIL IS PROVEN NOW.
   *
   * This pair used to assert a disabled `Start auction` button here, against
   * the flat lineup grid. Under direction C that control moved into the
   * per-slot commerce drawer, which is CLOSED by default, so it no longer
   * renders in this container's static markup at all.
   *
   * The guardrail itself did not move or weaken: EventManager still computes
   * `auctionWritesEnabled` / `auctionWriteDisabledReason` from the live auction
   * and hands them to the timeline. The button-level proof — disabled, with the
   * reason shown and no credential prompt — now lives in LineupTimeline.test.tsx
   * ('disables Start auction with the reason while another auction is live',
   * plus its enabled-state falsifier), where the button actually exists.
   *
   * What stays HERE is what this container owns: that a live auction is read
   * from the authoritative query and is closable.
   */
  it('prevents a second concurrent auction without showing a credential prompt', () => {
    const { markup } = renderManager(LIVE_AUCTION);

    expect(markup).toMatch(/<button class="button secondary" type="button">Close auction<\/button>/);
    // The commerce drawer is closed, so no start-auction affordance is offered
    // from the collapsed timeline in the first place.
    expect(markup).not.toContain('Start auction');
    expect(markup).not.toContain('Seller credential');
    expect(markup).not.toContain('Unlock auction writes');
  });

  it('recovers the closed winner result after refresh and permits the next auction', () => {
    const closed: SellerAuction = {
      ...LIVE_AUCTION,
      status: 'closed',
      closedAt: '2026-08-14T12:01:00.000Z',
      winnerOrder: {
        bidderId: 'guest-winner',
        quantity: 1,
        unitPriceCents: 2_700,
        totalCents: 2_700,
        status: 'pending',
      },
    };
    const { markup } = renderManager(closed);

    expect(markup).toContain('Closed result');
    expect(markup).toContain('Winner guest-winner · $27.00 each · recovered from the server');
    expect(markup).not.toContain('Close auction');
    expect(markup).not.toContain('Close the current auction before starting another');
  });
});
