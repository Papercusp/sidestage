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
        onHold={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Coming up"');
    expect(markup).toContain('data-product-id="espresso-new"');
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
    expect(markup).toContain("No products are on stage yet.");
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
});
