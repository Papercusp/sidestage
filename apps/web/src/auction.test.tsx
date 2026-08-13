import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuctionPanel } from './AuctionPanel';
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

describe('AuctionPanel', () => {
  it('renders the synced current price, leader state, and bid action', () => {
    const markup = renderToStaticMarkup(<AuctionPanel eventId="sunday-drop" initialAuction={ACTIVE_AUCTION} products={[{ id: 'stoneware-mug-matte-12oz', title: 'Stoneware mug', subtitle: 'Matte · 12 oz' }]} />);
    expect(markup).toContain('Stoneware mug');
    expect(markup).toContain('$24.00');
    expect(markup).toContain('You’re leading');
    expect(markup).toContain('Place bid');
    expect(markup).toContain('latest accepted bid syncs to every buyer');
  });
});
