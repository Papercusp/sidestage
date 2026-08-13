import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InventoryPickerGrid } from "./InventoryPickerGrid";
import type { CatalogRow, EventItemDraft } from "./catalog";

const ROWS: CatalogRow[] = [
  {
    id: "espresso-new",
    groupId: "espresso",
    title: "Barista Pro Espresso Machine",
    brand: "BrewHaus",
    productType: "KITCHEN_APPLIANCE",
    sku: "BH-ESP-200-NEW",
    condition: "NEW",
    handlingDays: 2,
    priceCents: 49_999,
    availableQty: 12,
  },
  {
    id: "espresso-sold",
    groupId: "espresso",
    title: "Barista Pro Espresso Machine",
    brand: "BrewHaus",
    productType: "KITCHEN_APPLIANCE",
    sku: "BH-ESP-200-SOLD",
    condition: "USED",
    handlingDays: 5,
    priceCents: 29_999,
    availableQty: 0,
  },
];

const DRAFTS: Record<string, EventItemDraft> = {
  'espresso-new': {
    catalogId: 'espresso-new',
    groupId: 'espresso',
    title: 'Barista Pro Espresso Machine',
    sku: 'BH-ESP-200-NEW',
    eventPriceCents: 47_500,
    quantityLimit: 3,
    availableQty: 12,
  },
};

describe("InventoryPickerGrid", () => {
  it("renders editable event offer cells and unavailable-row semantics through RichGrid", () => {
    const markup = renderToStaticMarkup(
      <InventoryPickerGrid
        rows={ROWS}
        selectedRowIds={new Set(["espresso-new"])}
        drafts={DRAFTS}
        onSelectedRowIdsChange={() => undefined}
        onDraftChange={() => undefined}
      />,
    );

    expect(markup).toContain('data-rg-screen-grid="true"');
    expect(markup).toContain('data-testid="catalog-row-espresso-new"');
    expect(markup).toContain('value="475.00"');
    expect(markup).toContain('value="3"');
    expect(markup).toContain("12 ready");
    expect(markup).toContain("catalog-row-unavailable");
    expect(markup).toContain("Sold out");
  });
});
