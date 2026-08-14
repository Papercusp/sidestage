import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BUYER_PRODUCT_PREVIEW_LIMIT, BuyerTab, openOrHoldBuyerProduct } from './BuyerTab';
import type { BuyerProduct } from './buyer';

const PRODUCTS: BuyerProduct[] = Array.from({ length: 5 }, (_, index) => ({
  id: `product-${index + 1}`,
  title: `Drop product ${index + 1}`,
  subtitle: `Edition ${index + 1}`,
  priceCents: 2_000 + index * 100,
  availableQty: index === 4 ? 0 : index + 1,
}));
const buyerCss = readFileSync(new URL('./BuyerTab.css', import.meta.url), 'utf8');

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
  it('reopens an already-held product without creating another cart hold', async () => {
    const holdProduct = vi.fn(async () => ({ id: 'cart-1' }) as never);
    const openHeldItems = vi.fn();
    const checkout = { holdProduct, openHeldItems, heldItemCount: 1 };

    await expect(openOrHoldBuyerProduct(PRODUCTS[0], PRODUCTS[0].id, checkout)).resolves.toBe('opened');
    expect(openHeldItems).toHaveBeenCalledOnce();
    expect(holdProduct).not.toHaveBeenCalled();

    await expect(openOrHoldBuyerProduct(PRODUCTS[1], PRODUCTS[0].id, checkout)).resolves.toBe('held');
    expect(holdProduct).toHaveBeenCalledOnce();
    expect(holdProduct).toHaveBeenCalledWith(PRODUCTS[1]);
  });

  it('keeps the current offer above the fold and previews the next three products', () => {
    const markup = render(PRODUCTS);

    expect(BUYER_PRODUCT_PREVIEW_LIMIT).toBe(3);
    expect(markup).toContain(`data-current-product-id="${PRODUCTS[0].id}"`);
    expect(markup).toContain(`Hold ${PRODUCTS[0].title} · $20.00`);
    expect(markup).not.toContain(`data-product-id="${PRODUCTS[0].id}"`);
    for (const product of PRODUCTS.slice(1, BUYER_PRODUCT_PREVIEW_LIMIT + 1)) {
      expect(markup).toContain(`data-product-id="${product.id}"`);
    }
    for (const product of PRODUCTS.slice(BUYER_PRODUCT_PREVIEW_LIMIT + 1)) {
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
    const markup = render(PRODUCTS.slice(0, BUYER_PRODUCT_PREVIEW_LIMIT + 1));

    expect(markup).not.toContain('aria-controls="buyer-event-products"');
    expect(markup).not.toContain('View all');
  });

  it('exposes mobile Shop and Chat modes without removing either desktop surface', () => {
    const markup = render(PRODUCTS);

    expect(markup).toContain('aria-label="Buyer mobile view"');
    expect(markup).toContain('aria-pressed="true">Shop');
    expect(markup).toContain('aria-pressed="false">Chat');
    expect(markup).toContain('data-buyer-mode="shop"');
    expect(markup).toContain('aria-label="Event chat"');
  });

  it('pins the approved responsive stage and non-covering sticky action in page CSS', () => {
    expect(buyerCss).toMatch(/\.buyer-stage-grid\s*\{[^}]*grid-template-columns:/s);
    expect(buyerCss).toMatch(/\.buyer-mobile-action\s*\{[^}]*position:\s*sticky/s);
    expect(buyerCss).toMatch(/\.buyer-mode-switch button\s*\{[^}]*min-height:\s*2\.75rem/s);
    expect(buyerCss).toContain(".buyer-lower-grid[data-buyer-mode='chat'] .buyer-shop-panel");
  });
});
