import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PricingHistoryContent, pricingHistoryUrl, type PricingHistory } from './PricingHistoryPanel';

describe('seller pricing history', () => {
  it('addresses the active event and product safely', () => {
    expect(pricingHistoryUrl('Sunday drop', 'mug/red', 'https://api.test/')).toBe(
      'https://api.test/events/Sunday%20drop/products/mug%2Fred/pricing-history',
    );
    expect(pricingHistoryUrl('event-1', 'mug')).toBe(
      'http://localhost:3100/events/event-1/products/mug/pricing-history',
    );
  });

  it('renders price, per-buyer offer, and auction outcomes', () => {
    const history: PricingHistory = {
      productId: 'mug',
      prices: [{ priceCents: 2400, soldQty: 5, rejectedQty: 2 }],
      offers: [{ id: 'offer-1', buyerId: 'buyer-a', priceCents: 2200, quantity: 2, outcome: 'accepted' }],
      auctions: [{ id: 'auction-1', priceCents: 2600, quantity: 3, bidderId: 'buyer-b', outcome: 'sold' }],
    };
    const markup = renderToStaticMarkup(<PricingHistoryContent history={history} />);
    expect(markup).toContain('$24.00');
    expect(markup).toContain('5 sold');
    expect(markup).toContain('2 rejected');
    expect(markup).toContain('buyer-a');
    expect(markup).toContain('history-accepted');
    expect(markup).toContain('3 × $26.00');
    expect(markup).toContain('buyer-b');
  });

  it('states honestly when the product has no history', () => {
    const markup = renderToStaticMarkup(<PricingHistoryContent history={{ productId: 'mug', prices: [], offers: [], auctions: [] }} />);
    expect(markup).toContain('No sales, offers, or auctions for this product yet.');
  });
});
