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
    const checkout = { holdProduct, openHeldItems, heldItemCount: 1, heldProductIds: [PRODUCTS[0].id] };

    await expect(openOrHoldBuyerProduct(PRODUCTS[0], checkout)).resolves.toBe('opened');
    expect(openHeldItems).toHaveBeenCalledOnce();
    expect(holdProduct).not.toHaveBeenCalled();

    await expect(openOrHoldBuyerProduct(PRODUCTS[1], checkout)).resolves.toBe('held');
    expect(holdProduct).toHaveBeenCalledOnce();
    expect(holdProduct).toHaveBeenCalledWith(PRODUCTS[1]);
  });

  it('places a fresh hold after expiry removes the product from the checkout cart', async () => {
    const holdProduct = vi.fn(async () => ({ id: 'cart-1' }) as never);
    const checkout = { holdProduct, openHeldItems: vi.fn(), heldItemCount: 0, heldProductIds: [] };

    await expect(openOrHoldBuyerProduct(PRODUCTS[0], checkout)).resolves.toBe('held');
    expect(holdProduct).toHaveBeenCalledWith(PRODUCTS[0]);
    expect(checkout.openHeldItems).not.toHaveBeenCalled();
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

  it('keeps the real chat mounted in the video overlay and exposes mobile Shop and Chat controls', () => {
    const markup = render(PRODUCTS);

    expect(markup).toContain('aria-label="Buyer mobile view"');
    expect(markup).toContain('aria-pressed="true">Shop');
    expect(markup).toContain('aria-pressed="false">Chat');
    expect(markup).toContain('data-buyer-mode="shop"');
    expect(markup).toContain('aria-label="Preview event audience chat"');
    expect(markup).toContain('data-surface="audience-overlay"');
    expect(markup).not.toContain('class="stage-panel event-chat-card"');
    expect(markup).toContain('buyer-video-engagement-overlay');
    expect(markup).toContain('Waiting for captions');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('buyer-chat-card');
  });

  it('pins the approved responsive stage and non-covering sticky action in page CSS', () => {
    expect(buyerCss).toMatch(/\.buyer-stage-grid\s*\{[^}]*grid-template-columns:/s);
    expect(buyerCss).toMatch(/\.buyer-mobile-action\s*\{[^}]*position:\s*sticky/s);
    expect(buyerCss).toMatch(/\.buyer-mode-switch button\s*\{[^}]*min-height:\s*2\.75rem/s);
    expect(buyerCss).toContain(".buyer-lower-grid[data-buyer-mode='chat'] .buyer-shop-panel");
    expect(buyerCss).not.toContain(".buyer-lower-grid[data-buyer-mode='shop'] .buyer-chat-card");
  });

  it('prevents buyer controls from widening the site column beside the mobile guide', () => {
    const max900Start = buyerCss.indexOf('@media (max-width: 900px)');
    const max760Start = buyerCss.indexOf('@media (max-width: 760px)', max900Start);
    const max520Start = buyerCss.indexOf('@media (max-width: 520px)', max760Start);
    const max900Css = buyerCss.slice(max900Start, max760Start);
    const max520Css = buyerCss.slice(max520Start);

    expect(max900Css).toMatch(/\.buyer-room-actions\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(max520Css).toMatch(/\.buyer-account-control\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(max520Css).toMatch(/\.buyer-current-offer\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;[^}]*flex-direction:\s*column;/s);
  });
});
