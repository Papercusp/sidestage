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
      />,
    );
    expect(markup).toContain('data-rg-screen-grid="true"');
    expect(markup).toContain('On stage');
    expect(markup).toContain('Markdown');
    expect(markup).toContain('Stock');
  });
});
