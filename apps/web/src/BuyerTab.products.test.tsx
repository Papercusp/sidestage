import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BUYER_PRODUCT_PREVIEW_LIMIT, BuyerTab } from './BuyerTab';
import type { BuyerProduct } from './buyer';

const PRODUCTS: BuyerProduct[] = Array.from({ length: 5 }, (_, index) => ({
  id: `product-${index + 1}`,
  title: `Drop product ${index + 1}`,
  subtitle: `Edition ${index + 1}`,
  priceCents: 2_000 + index * 100,
  availableQty: index === 4 ? 0 : index + 1,
}));

function render(products: readonly BuyerProduct[]): string {
  return renderToStaticMarkup(
    <BuyerTab
      eventId="preview-event"
      eventTitle="Preview event"
      products={products}
      stats={{ viewers: 12, itemsSold: 4, totalRaisedCents: 9_500 }}
      guideEvents={[]}
    />,
  );
}

describe('BuyerTab product preview', () => {
  it('shows only the next three products before the catalog is expanded', () => {
    const markup = render(PRODUCTS);

    expect(BUYER_PRODUCT_PREVIEW_LIMIT).toBe(3);
    for (const product of PRODUCTS.slice(0, BUYER_PRODUCT_PREVIEW_LIMIT)) {
      expect(markup).toContain(`data-product-id="${product.id}"`);
    }
    for (const product of PRODUCTS.slice(BUYER_PRODUCT_PREVIEW_LIMIT)) {
      expect(markup).not.toContain(`data-product-id="${product.id}"`);
    }
  });

  it('offers the complete catalog in one accessible action', () => {
    const markup = render(PRODUCTS);

    expect(markup).toContain('aria-controls="buyer-event-products"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('View all 5 items');
    expect(markup).toContain('4 available');
  });

  it('does not add a redundant catalog toggle when every item is already visible', () => {
    const markup = render(PRODUCTS.slice(0, BUYER_PRODUCT_PREVIEW_LIMIT));

    expect(markup).not.toContain('aria-controls="buyer-event-products"');
    expect(markup).not.toContain('View all');
  });
});
