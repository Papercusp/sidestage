import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BuyerProductRail } from "./BuyerProductRail";
import type { BuyerProduct } from "./buyer";

const PRODUCTS: BuyerProduct[] = [
  {
    id: "espresso-new",
    title: "Barista Pro Espresso Machine",
    subtitle: "BrewHaus · Matte Black",
    priceCents: 49_999,
    compareAtPriceCents: 54_999,
    availableQty: 12,
  },
  {
    id: "espresso-sold",
    title: "Barista Pro Espresso Machine",
    subtitle: "BrewHaus · Cream",
    priceCents: 34_999,
    availableQty: 0,
    badge: "Sold out",
  },
];

describe("BuyerProductRail", () => {
  it("renders visual product cards with price, stock, and contextual hold actions", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail
        products={PRODUCTS}
        selectedProductId="espresso-new"
        sequenceByProductId={{ "espresso-new": 2, "espresso-sold": 3 }}
        currentSequenceNumber={1}
        totalProducts={3}
        onHold={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Upcoming products in sale order"');
    expect(markup).toContain('data-product-id="espresso-new"');
    expect(markup).toContain('data-sequence-number="2"');
    expect(markup).toContain('data-sequence-number="3"');
    expect(markup).toContain('aria-label="Up next, item 2 of 3"');
    expect(markup).toContain('aria-label="After that, item 3 of 3"');
    expect(markup).toContain("Barista Pro Espresso Machine");
    expect(markup).toContain("$499.99");
    expect(markup).toContain("12 available");
    expect(markup).toContain("Held for you");
    expect(markup).toContain("Sold out");
    expect(markup).toContain('aria-label="Open held Barista Pro Espresso Machine"');
    expect(markup).not.toContain('data-rg-screen-grid="true"');
  });

  it("renders the rail empty state without inventing products", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail products={[]} onHold={() => undefined} />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("The drop lineup is not published yet.");
  });

  it("distinguishes the end of a published drop from an unpublished lineup", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail
        products={[]}
        currentSequenceNumber={1}
        totalProducts={1}
        onHold={() => undefined}
      />,
    );

    expect(markup).toContain("That’s the end of this drop.");
  });

  it("labels current and already-shown products when the complete order is open", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail
        products={PRODUCTS}
        sequenceByProductId={{ "espresso-new": 1, "espresso-sold": 2 }}
        currentSequenceNumber={2}
        totalProducts={2}
        ariaLabel="Products in sale order"
        onHold={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Products in sale order"');
    expect(markup).toContain('aria-label="Already shown, item 1 of 2"');
    expect(markup).toContain('aria-label="Live now, item 2 of 2"');
    expect(markup).toContain('aria-current="step"');
  });

  it("keeps a selected held item reopenable when no unreserved stock remains", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail
        products={[PRODUCTS[1]]}
        selectedProductId="espresso-sold"
        onHold={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Open held Barista Pro Espresso Machine"');
    expect(markup).toContain(">Held for you</button>");
    expect(markup).not.toContain('disabled=""');
  });

  it("renders every product still present in the held cart as reopenable", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail
        products={PRODUCTS}
        heldProductIds={PRODUCTS.map((product) => product.id)}
        onHold={() => undefined}
      />,
    );

    expect(markup.match(/>Held for you<\/button>/g)).toHaveLength(2);
  });

  it("shows a swipe-more fade affordance when multiple cards can overflow the viewport", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail products={PRODUCTS} onHold={() => undefined} />,
    );

    expect(markup).toContain('class="buyer-product-rail-wrap"');
    expect(markup).toContain('class="buyer-rail-fade" aria-hidden="true"');
  });

  it("omits the fade affordance for a single card (nothing to swipe to)", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail products={[PRODUCTS[0]]} onHold={() => undefined} />,
    );

    expect(markup).not.toContain("buyer-product-rail-wrap");
    expect(markup).not.toContain("buyer-rail-fade");
  });
});
