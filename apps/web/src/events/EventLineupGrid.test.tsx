import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventLineupGrid } from './EventLineupGrid';
import type { SellerEventItem } from './api';

const ITEMS: SellerEventItem[] = [{
  eventId: 'drop',
  eventItemId: 'drop:mug',
  productId: 'mug',
  title: 'Aurora mug',
  priceCents: 1_500,
  availableQty: 5,
  quantity: 3,
  onStage: true,
  attributes: { brand: 'Northstar', sku: 'MUG-1' },
}];

describe('EventLineupGrid', () => {
  it('renders guarded listing actions through the shared grid', () => {
    const markup = renderToStaticMarkup(
      <EventLineupGrid
        items={ITEMS}
        onPush={() => undefined}
        onSwap={() => undefined}
        onMarkdown={() => undefined}
        onStockAdjust={() => undefined}
        onStartAuction={() => undefined}
        onSendOffer={() => undefined}
      />,
    );
    expect(markup).toContain('data-rg-screen-grid="true"');
    expect(markup).toContain('On stage');
    expect(markup).toContain('Markdown');
    expect(markup).toContain('Stock');
    expect(markup).toContain('Auction starting price for Aurora mug');
    expect(markup).toContain('Auction quantity for Aurora mug');
    expect(markup).toContain('Start auction');
    expect(markup).toContain('Offer price for Aurora mug');
    expect(markup).toContain('Offer quantity for Aurora mug');
    expect(markup).toContain('Offer buyer ID for Aurora mug');
  });

  it('keeps auction start visibly disabled until the seller write boundary is available', () => {
    const markup = renderToStaticMarkup(
      <EventLineupGrid
        items={ITEMS}
        auctionWritesEnabled={false}
        auctionWriteDisabledReason="Close the current auction before starting another"
        onPush={() => undefined}
        onSwap={() => undefined}
        onMarkdown={() => undefined}
        onStockAdjust={() => undefined}
        onStartAuction={() => undefined}
        onSendOffer={() => undefined}
      />,
    );

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*title="Close the current auction before starting another"[^>]*>Start auction<\/button>/);
  });
});
