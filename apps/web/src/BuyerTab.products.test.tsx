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
    expect(markup).toContain('id="buyer-drop-runway-title">The drop runway');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Drop progress"');
    expect(markup).toContain('aria-valuemax="5"');
    expect(markup).toContain('aria-valuenow="1"');
    expect(markup).toContain('Item 1 of 5 live now');
    expect(markup).toContain(`data-current-product-id="${PRODUCTS[0].id}"`);
    expect(markup).toContain(`Hold ${PRODUCTS[0].title} · $20.00`);
    expect(markup).not.toContain(`data-product-id="${PRODUCTS[0].id}"`);
    for (const [index, product] of PRODUCTS.slice(1, BUYER_PRODUCT_PREVIEW_LIMIT + 1).entries()) {
      expect(markup).toContain(`data-product-id="${product.id}"`);
      expect(markup).toContain(`data-sequence-number="${index + 2}"`);
    }
    expect(markup).toContain('aria-label="Up next, item 2 of 5"');
    expect(markup).toContain('aria-label="After that, item 3 of 5"');
    for (const product of PRODUCTS.slice(BUYER_PRODUCT_PREVIEW_LIMIT + 1)) {
      expect(markup).not.toContain(`data-product-id="${product.id}"`);
    }
  });

  it('starts the runway after the actual live item when earlier products are sold out', () => {
    const shiftedProducts = PRODUCTS.map((product, index) => (
      index === 0 ? { ...product, availableQty: 0 } : product
    ));
    const markup = render(shiftedProducts);

    expect(markup).toContain(`data-current-product-id="${PRODUCTS[1].id}"`);
    expect(markup).toContain('Item 2 of 5 live now');
    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).not.toContain(`data-product-id="${PRODUCTS[0].id}"`);
    expect(markup).not.toContain(`data-product-id="${PRODUCTS[1].id}"`);
    expect(markup).toContain(`data-product-id="${PRODUCTS[2].id}"`);
    expect(markup).toContain('aria-label="Up next, item 3 of 5"');
  });

  it('renders an honest unpublished-lineup state without a fake progress value', () => {
    const markup = render([]);

    expect(markup).toContain('The lineup is waiting to be published');
    expect(markup).toContain('The drop lineup is not published yet.');
    expect(markup).not.toContain('role="progressbar"');
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

  it('keeps the real chat mounted in the accessible room panel and the video transcript-only', () => {
    const markup = render(PRODUCTS);

    expect(markup).toContain('class="buyer-room-tablist" role="tablist"');
    expect(markup).toContain('role="tab" aria-selected="true" aria-controls="buyer-room-panel-chat"');
    expect(markup).toContain('aria-controls="buyer-room-panel-details"');
    expect(markup).toContain('aria-controls="buyer-room-panel-seller"');
    expect(markup).toContain('aria-label="Preview event audience chat"');
    expect(markup).toContain('data-surface="audience-overlay"');
    expect(markup).not.toContain('class="stage-panel event-chat-card"');
    expect(markup).toContain('buyer-video-engagement-overlay');
    expect(markup).toContain('Waiting for captions');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('video-engagement-chat-toggle');
    expect(markup).not.toContain('buyer-mode-switch');
    expect(markup).not.toContain('data-buyer-mode');
    expect(markup.match(/class="auction-card buyer-current-offer-slot"/g)).toHaveLength(1);
    expect(markup).toContain('data-offer-state="idle"');
  });

  it('uses the active guide seller and falls back honestly when the guide has no match', () => {
    const guidedMarkup = renderToStaticMarkup(
      <BuyerTab
        eventId="studio-drop"
        eventTitle="Stale title"
        products={PRODUCTS}
        stats={{ viewers: 12, itemsSold: 4, totalRaisedCents: 9_500 }}
        guideEvents={[{
          eventId: 'studio-drop',
          title: 'Studio drop',
          sellerId: 'studio-27',
          sellerName: 'Studio 27',
          status: 'live',
          startsAt: null,
          endedAt: null,
          viewers: 12,
        }]}
      />,
    );

    expect(guidedMarkup).toContain('Studio drop');
    expect(guidedMarkup).toContain('<strong>Studio 27</strong>');
    expect(guidedMarkup).toContain('@studio-27 · SideStage event host');
    expect(guidedMarkup).toContain('Hosting live');

    const fallbackMarkup = render(PRODUCTS);
    expect(fallbackMarkup).toContain('<strong>SideStage event host</strong>');
    expect(fallbackMarkup).toContain('@event-host · SideStage event host');
    expect(fallbackMarkup).toContain('Event host');
  });

  it('pins the approved responsive stage and non-covering sticky action in page CSS', () => {
    expect(buyerCss).toMatch(/\.buyer-stage-grid\s*\{[^}]*grid-template-columns:/s);
    expect(buyerCss).toMatch(/\.buyer-stage-primary\s*\{[^}]*display:\s*grid;/s);
    expect(buyerCss).toMatch(/\.buyer-mobile-action\s*\{[^}]*position:\s*sticky/s);
    expect(buyerCss).toMatch(/\.buyer-room-tablist button\s*\{[^}]*min-height:\s*2\.6rem/s);
    expect(buyerCss).toContain(".buyer-current-offer-slot[data-offer-state='idle']");
    expect(buyerCss).toMatch(/\.buyer-current-offer-slot\s*\{[^}]*container-type:\s*inline-size;/s);
    expect(buyerCss).toMatch(/\.buyer-current-offer-slot \.auction-bid-form\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
    expect(buyerCss).toMatch(/@container \(max-width: 16rem\) \{[\s\S]*?\.buyer-current-offer-slot \.auction-stage\s*\{[^}]*grid-template-columns:\s*1fr;/s);
    expect(buyerCss).not.toContain('.buyer-mode-switch');
    expect(buyerCss).not.toContain('data-buyer-mode');
    expect(buyerCss).toMatch(/\.buyer-drop-runway\s*\{[^}]*overflow:\s*hidden;/s);
    expect(buyerCss).toMatch(/\.buyer-runway-footer\s*\{[^}]*flex-direction:\s*column;/s);
  });

  it('prevents buyer surfaces from widening the site column beside the mobile guide', () => {
    const max900Start = buyerCss.indexOf('@media (max-width: 900px)');
    const max760Start = buyerCss.indexOf('@media (max-width: 760px)', max900Start);
    const max520Start = buyerCss.indexOf('@media (max-width: 520px)', max760Start);
    const max900Css = buyerCss.slice(max900Start, max760Start);
    const max520Css = buyerCss.slice(max520Start);

    expect(max520Css).toMatch(/\.buyer-account-control\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(max520Css).toMatch(/\.buyer-current-offer\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;[^}]*flex-direction:\s*column;/s);
  });
});
