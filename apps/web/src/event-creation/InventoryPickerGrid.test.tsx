import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InventoryPickerGrid, variantAxisLabel } from "./InventoryPickerGrid";
import type { CatalogRow, EventItemDraft } from "./catalog";

const ROWS: CatalogRow[] = [
  {
    id: "espresso-new",
    groupId: "espresso",
    title: "Barista Pro Espresso Machine",
    brand: "BrewHaus",
    productType: "KITCHEN_APPLIANCE",
    sku: "BH-ESP-200-NEW",
    color: "Matte Black",
    condition: "NEW",
    handlingDays: 2,
    priceCents: 49_999,
    availableQty: 12,
  },
  // Deliberately carries NO colour: a Restart-imported row has no colour axis,
  // and the variant cell must fall back to its grade rather than render blank.
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
    expect(markup).toContain("minmax(180px, 2.4fr)");
    expect(markup).toContain("minmax(150px, 1.5fr)");
  });

  it("shows the colour as the variant axis, falling back to the imported grade", () => {
    const markup = renderToStaticMarkup(
      <InventoryPickerGrid
        rows={ROWS}
        selectedRowIds={new Set()}
        drafts={DRAFTS}
        onSelectedRowIdsChange={() => undefined}
        onDraftChange={() => undefined}
      />,
    );

    // The colour is what tells two variants of one product apart, so it — not
    // the resale grade Restart imports — is the variant cell (WI-38716).
    expect(markup).toContain("Matte Black");
    expect(markup).not.toContain("2d handling");
    // A row with no colour axis still has to say something useful.
    expect(markup).toContain("5d handling");
  });

  it("parameterizes intake semantics and allows sold-out variants to be restocked", () => {
    const markup = renderToStaticMarkup(
      <InventoryPickerGrid
        rows={ROWS}
        selectedRowIds={new Set(["espresso-sold"])}
        drafts={{}}
        onSelectedRowIdsChange={() => undefined}
        onDraftChange={() => undefined}
        purpose="inventory"
      />,
    );

    expect(markup).toContain("Unit price");
    expect(markup).toContain("Add qty");
    expect(markup).toContain("0 on hand");
    expect(markup).toContain('value="1"');
    expect(markup).not.toContain("catalog-row-unavailable");
  });
});

describe("variantAxisLabel", () => {
  it("shows normalized color and size axes and falls back to grade and lead time", () => {
    expect(variantAxisLabel(ROWS[0])).toBe("Matte Black");
    expect(variantAxisLabel({ ...ROWS[0], size: "Medium" })).toBe("Matte Black · Medium");
    expect(variantAxisLabel({ ...ROWS[0], color: undefined, size: "Large" })).toBe("Large");
    expect(variantAxisLabel(ROWS[1])).toBe("USED · 5d handling");
    expect(variantAxisLabel({ ...ROWS[1], handlingDays: null })).toBe("USED · —d handling");
  });
});
