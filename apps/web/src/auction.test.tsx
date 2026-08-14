import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext } from '@papercusp/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeAuctionFromSyncRows, auctionPhase, AuctionPanel } from './AuctionPanel';
import { activeAuctionUrl, auctionStreamUrl, parseAuctionEvent, parseBidDollars, secondsRemaining, suggestedBidCents, type BuyerAuction } from './auction';

const ACTIVE_AUCTION: BuyerAuction = {
  id: 'auction-1', eventId: 'sunday-drop', eventItemId: 'item-1', productId: 'stoneware-mug-matte-12oz', quantity: 1,
  startingPriceCents: 2_000, currentPriceCents: 2_400, status: 'active', startedAt: '2026-08-13T12:00:00.000Z',
  endsAt: '2099-08-13T12:01:00.000Z',
  bids: [{ id: 'bid-1', bidderId: 'buyer-demo', displayName: 'You', amountCents: 2_400, createdAt: '2026-08-13T12:00:10.000Z' }],
};

describe('buyer auction model', () => {
  it('derives encoded REST and realtime endpoints', () => {
    expect(activeAuctionUrl('Sunday drop','https://sidestage.example/')).toBe('https://sidestage.example/auctions/events/Sunday%20drop/active');
    expect(auctionStreamUrl('Sunday drop','https://sidestage.example/')).toBe('https://sidestage.example/auctions/events/Sunday%20drop/stream');
  });
  it('validates dollar input and chooses a material next bid', () => {
    expect(parseBidDollars('24.50')).toBe(2_450);
    expect(parseBidDollars('24.999')).toBeNull();
    expect(suggestedBidCents(2_400)).toBe(2_600);
    expect(suggestedBidCents(900)).toBe(1_000);
  });
  it('parses realtime snapshots and clamps the countdown', () => {
    expect(parseAuctionEvent(JSON.stringify({ name: 'event.auction.active', args: { eventId: 'sunday-drop' }, auction: ACTIVE_AUCTION, tsMs: 1 }))).toMatchObject({ id: 'auction-1', currentPriceCents: 2_400 });
    expect(parseAuctionEvent('{bad-json')).toBeUndefined();
    expect(secondsRemaining('2026-08-13T12:00:05.000Z',Date.parse('2026-08-13T12:00:00.100Z'))).toBe(5);
  });
});

const PRODUCTS = [{ id: 'stoneware-mug-matte-12oz', title: 'Stoneware mug', subtitle: 'Matte · 12 oz' }];
const auctionCss = readFileSync(new URL('./auction.css', import.meta.url), 'utf8');

afterEach(() => vi.unstubAllGlobals());

/** An auction ending `ms` from now, with `bids` newest/highest first. */
function auctionEndingIn(ms: number, overrides: Partial<BuyerAuction> = {}): BuyerAuction {
  return {
    ...ACTIVE_AUCTION,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + ms).toISOString(),
    ...overrides,
  };
}

function render(auction: BuyerAuction, bidderId?: string): string {
  const useDataImpl = vi.fn().mockReturnValue({
    data: [auction],
    loading: false,
    fetching: false,
    transport: 'SSE',
    invalidate: vi.fn(),
    error: null,
  });
  return renderToStaticMarkup(
    <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
      <AuctionPanel eventId="sunday-drop" products={PRODUCTS} bidderId={bidderId} />
    </SyncContext.Provider>,
  );
}

/**
 * These three read the exact elements whose WORDING was the defect, rather
 * than asserting over the whole document. A bare `not.toContain('bids')`
 * cannot do this job: the feed legitimately renders "Bids" and an aria-label
 * of "Recent bids", so a whole-document assertion passes or fails for reasons
 * that have nothing to do with the closing call.
 */
function callBadge(markup: string): string {
  return /<span class="auction-call[^"]*">([^<]*)<\/span>/.exec(markup)?.[1] ?? '';
}
function leaderLine(markup: string): string {
  return /<div class="auction-leader[^"]*">([^<]*)<\/div>/.exec(markup)?.[1] ?? '';
}
/** The clock's own `<small>` — the only one rendered without attributes. */
function clockLabel(markup: string): string {
  return /<small>([^<]*)<\/small>/.exec(markup)?.[1] ?? '';
}

describe('AuctionPanel', () => {
  it('can shrink inside the narrow mobile column beside the persistent channel guide', () => {
    expect(auctionCss).toMatch(/\.auction-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*min-width:\s*0/);
    expect(auctionCss).toMatch(/\.auction-card\s*>\s*\*\s*\{[^}]*min-width:\s*0/);
  });

  it('maps the event.auction.active named-query rows into the existing view shape', () => {
    expect(activeAuctionFromSyncRows([ACTIVE_AUCTION])).toBe(ACTIVE_AUCTION);
    expect(activeAuctionFromSyncRows([])).toBeNull();
  });

  it('renders the synced current price, leader state, and bid action', () => {
    const markup = render(ACTIVE_AUCTION);
    expect(markup).toContain('Stoneware mug');
    expect(markup).toContain('$24.00');
    expect(markup).toContain('You’re leading');
    expect(markup).toContain('Place bid');
    expect(markup).toContain('latest accepted bid syncs to every buyer');
  });

  it('uses the named query as its only read authority and scopes retry to query errors', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const invalidate = vi.fn();
    const useDataImpl = vi.fn().mockReturnValue({
      data: [ACTIVE_AUCTION],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate,
      error: null,
    });
    const liveMarkup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <AuctionPanel eventId="sunday-drop" products={PRODUCTS} />
      </SyncContext.Provider>,
    );

    expect(useDataImpl).toHaveBeenCalledWith({
      queryName: 'event.auction.active',
      args: { eventId: 'sunday-drop' },
      pollIntervalMs: 2_000,
      staleTime: 0,
    });
    expect(liveMarkup).not.toContain('Try again');
    expect(fetchMock).not.toHaveBeenCalled();

    useDataImpl.mockReturnValue({
      data: [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate,
      error: new Error('auction sync unavailable'),
    });
    const errorMarkup = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <AuctionPanel eventId="sunday-drop" products={PRODUCTS} />
      </SyncContext.Provider>,
    );
    expect(errorMarkup).toContain('auction sync unavailable');
    expect(errorMarkup).toContain('Try again');
    expect(errorMarkup).not.toContain('Refresh auction');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The bid array was always in hand; the panel used to render bids[0] and drop
  // the rest. Guard the whole feed so that regression cannot come back quietly.
  it('shows every recent bid in the feed, not just the leader', () => {
    const markup = render(auctionEndingIn(90_000, {
      currentPriceCents: 3_000,
      bids: [
        { id: 'b3', bidderId: 'dana_r', displayName: 'dana_r', amountCents: 3_000, createdAt: '2026-08-13T12:00:30.000Z' },
        { id: 'b2', bidderId: 'tovah', displayName: 'tovah', amountCents: 2_800, createdAt: '2026-08-13T12:00:20.000Z' },
        { id: 'b1', bidderId: 'kchen', displayName: 'kchen', amountCents: 2_600, createdAt: '2026-08-13T12:00:10.000Z' },
      ],
    }));
    expect(markup).toContain('dana_r');
    expect(markup).toContain('tovah');
    expect(markup).toContain('kchen');
    expect(markup).toContain('$28.00');
    expect(markup).toContain('$26.00');
    expect(markup).toContain('auction-feed-row is-leading');
  });

  it('draws a countdown ring that drains with the real clock', () => {
    const wideOpen = render(auctionEndingIn(60_000, { startedAt: new Date(Date.now()).toISOString() }));
    expect(wideOpen).toContain('auction-ring-arc');
    // Full ring at the start: nothing of the circumference is hidden.
    expect(wideOpen).toMatch(/stroke-dashoffset="0\.00"/);

    // Half elapsed => roughly half the circumference (276.46) is hidden.
    const halfway = render(auctionEndingIn(30_000, { startedAt: new Date(Date.now() - 30_000).toISOString() }));
    const offset = Number(/stroke-dashoffset="([\d.]+)"/.exec(halfway)?.[1]);
    expect(offset).toBeGreaterThan(120);
    expect(offset).toBeLessThan(160);
  });

  it('escalates the ring as time runs out', () => {
    expect(render(auctionEndingIn(120_000))).toContain('auction-stage auction-stage-calm');
    expect(render(auctionEndingIn(20_000))).toContain('auction-stage auction-stage-soon');
    expect(render(auctionEndingIn(6_000))).toContain('auction-stage auction-stage-critical');
  });

  it('stages the close: going once, going twice, then sold', () => {
    expect(render(auctionEndingIn(90_000))).not.toContain('Going once');
    expect(render(auctionEndingIn(4_500))).toContain('Going once');
    expect(render(auctionEndingIn(2_000))).toContain('Going twice');

    const closed = render(auctionEndingIn(-5_000, { status: 'closed' }), 'someone-else');
    expect(closed).toContain('auction-stamp');
    expect(closed).toContain('SOLD');
    expect(closed).toContain('auction-feed-row is-won');
    expect(closed).toContain('won at');
  });

  // WI-38726. When the stream drops, the snapshot in hand still says
  // `status:'active'` after `endsAt` has passed — so the panel used to keep
  // rendering a PRE-CLOSE reading it could already disprove from its own
  // clock: "0:00 left", the live bid count, and a present-tense "X leads".
  // Phase is now derived from the clock (authoritative for "bidding is over",
  // no round-trip) with the server authoritative only for the OUTCOME.
  describe('the settling window — bidding over, outcome not in yet', () => {
    const settling = (overrides: Partial<BuyerAuction> = {}) => auctionEndingIn(-5_000, overrides);

    it('derives the phase from the clock, not from the server status alone', () => {
      expect(auctionPhase('active', 30)).toBe('live');
      expect(auctionPhase('active', 0)).toBe('settling');
      expect(auctionPhase('closed', 0)).toBe('closed');
      // A confirmed close outranks the clock, so a slow local clock cannot
      // reopen an auction the server has already settled.
      expect(auctionPhase('closed', 30)).toBe('closed');
    });

    it('never shows a live bid count or a present-tense leader past endsAt', () => {
      const markup = render(settling());
      expect(callBadge(markup)).toBe('Confirming');
      expect(leaderLine(markup)).toContain('had the last bid');
      expect(leaderLine(markup)).not.toContain('leads');
      expect(leaderLine(markup)).not.toContain('leading');
    });

    it('marks the clock as closing rather than counting time left', () => {
      const markup = render(settling());
      expect(clockLabel(markup)).toBe('closing');
      expect(markup).toContain('aria-label="Bidding closed, confirming the result"');
      expect(markup).toContain('is-settling');
    });

    it('announces no winner and stamps no SOLD before the server confirms one', () => {
      const markup = render(settling());
      expect(markup).not.toContain('auction-stamp');
      expect(markup).not.toContain('SOLD');
      expect(leaderLine(markup)).not.toContain('won');
      // The feed's top row stays merely leading — it is not a win yet.
      expect(markup).toContain('auction-feed-row is-leading');
      expect(markup).not.toContain('is-won');
    });

    it('refuses a bid once the clock has run out', () => {
      const markup = render(settling());
      expect(/<input[^>]*disabled=""/.test(markup)).toBe(true);
      expect(/<button[^>]*disabled=""/.test(markup)).toBe(true);
    });

    it('still reports a bidless close honestly', () => {
      expect(leaderLine(render(settling({ bids: [] })))).toBe('Bidding closed without a bid.');
    });
  });

  it('keeps bidding, sync and accessibility intact alongside the new presentation', () => {
    const markup = render(auctionEndingIn(90_000));
    expect(markup).toContain('aria-busy');
    expect(markup).toContain('role="timer"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Place bid');
    // The old three-up metrics row is gone, replaced by the stage.
    expect(markup).not.toContain('auction-metrics');
  });
});
