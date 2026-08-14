import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { activeAuctionFromSyncRows, AuctionPanel } from './AuctionPanel';
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
  return renderToStaticMarkup(
    <AuctionPanel eventId="sunday-drop" initialAuction={auction} products={PRODUCTS} bidderId={bidderId} />,
  );
}

describe('AuctionPanel', () => {
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
