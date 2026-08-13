import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BuyerProductRail } from "./BuyerProductRail";
import type { BuyerProduct } from "./buyer";

const PRODUCTS: BuyerProduct[] = [
  {
    id: "espresso-new",
    title: "Barista Pro Espresso Machine",
    subtitle: "BrewHaus · NEW",
    priceCents: 49_999,
    compareAtPriceCents: 54_999,
    availableQty: 12,
  },
  {
    id: "espresso-sold",
    title: "Barista Pro Espresso Machine",
    subtitle: "BrewHaus · REFURBISHED",
    priceCents: 34_999,
    availableQty: 0,
    badge: "Sold out",
  },
];

describe("BuyerProductRail", () => {
  it("renders product, price, stock, and hold cells through the shared RichGrid contract", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail
        products={PRODUCTS}
        selectedProductId="espresso-new"
        onHold={() => undefined}
      />,
    );

    expect(markup).toContain('data-rg-screen-grid="true"');
    expect(markup).toContain('data-product-id="espresso-new"');
    expect(markup).toContain("Barista Pro Espresso Machine");
    expect(markup).toContain("$499.99");
    expect(markup).toContain("12 ready");
    expect(markup).toContain("Held for you");
    expect(markup).toContain("Sold out");
  });

  it("renders the rail empty state without inventing products", () => {
    const markup = renderToStaticMarkup(
      <BuyerProductRail products={[]} onHold={() => undefined} />,
    );
    expect(markup).toContain("No products are on stage yet.");
  });
});
