import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventLineupGrid } from './EventLineupGrid';
import type { SellerEventItem } from './api';

const ITEMS: SellerEventItem[] = [{
  eventId: 'drop',
  eventItemId: 'drop:mug',
  productId: 'mug',
  title: 'Aurora mug',
  currentPriceCents: 1_500,
  currentQuantity: 5,
  listedQuantity: 3,
  stageState: 'on-stage',
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
    expect(markup).toContain('Offer buyer for Aurora mug');
  });

  it('offers a picker of buyers actually in the event, never a free-text id', () => {
    const markup = renderToStaticMarkup(
      <EventLineupGrid
        items={ITEMS}
        buyers={[
          { buyerId: 'buyer-a', displayName: 'Ada', source: 'room' },
          { buyerId: 'buyer-z', displayName: 'Zed', source: 'bidder' },
        ]}
        onPush={() => undefined}
        onSwap={() => undefined}
        onMarkdown={() => undefined}
        onStockAdjust={() => undefined}
        onStartAuction={() => undefined}
        onSendOffer={() => undefined}
      />,
    );

    expect(markup).toContain('<select');
    expect(markup).toContain('value="buyer-a"');
    expect(markup).toContain('Zed · bidder');
    expect(markup).toContain('2 in the room');
    // The replaced control: a text input the seller could type any id into.
    expect(markup).not.toContain('placeholder="Buyer ID"');
  });

  it('says the room is empty and refuses to send rather than falling back to free text', () => {
    const markup = renderToStaticMarkup(
      <EventLineupGrid
        items={ITEMS}
        buyers={[]}
        onPush={() => undefined}
        onSwap={() => undefined}
        onMarkdown={() => undefined}
        onStockAdjust={() => undefined}
        onStartAuction={() => undefined}
        onSendOffer={() => undefined}
      />,
    );

    expect(markup).toContain('No buyers in the room');
    expect(markup).toContain('Nobody is in this event yet');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/);
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
