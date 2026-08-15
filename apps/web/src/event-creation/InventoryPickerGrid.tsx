import { useMemo } from "react";
import { RichGrid, type ColumnDef } from "@papercusp/grid-core";

import {
  draftFromCatalog,
  formatPrice,
  inventoryDraftFromCatalog,
  type CatalogRow,
  type EventItemDraft,
} from "./catalog";

export interface InventoryPickerGridProps {
  rows: readonly CatalogRow[];
  selectedRowIds: ReadonlySet<string>;
  drafts: Readonly<Record<string, EventItemDraft>>;
  onSelectedRowIdsChange: (next: ReadonlySet<string>) => void;
  onDraftChange: (
    row: CatalogRow,
    field: "eventPriceCents" | "quantityLimit",
    value: string,
  ) => void;
  purpose?: "event" | "inventory";
}

/**
 * What tells this variant apart from its siblings. SideStage sells colorways,
 * so colour is the axis; only a Restart-imported row with no colour axis falls
 * back to the resale grade and lead time it was imported with (WI-38716).
 */
export function variantAxisLabel(row: CatalogRow): string {
  const options = [row.color, row.size].filter((value): value is string => Boolean(value));
  if (options.length) return options.join(' · ');
  return `${row.condition} · ${row.handlingDays ?? "—"}d handling`;
}

function ProductCell({ row }: { row: CatalogRow }) {
  return (
    <div className="event-product-cell">
      <img src={row.imageUrl} alt="" loading="lazy" />
      <div>
        <strong>{row.title}</strong>
        <span>{row.brand}</span>
      </div>
    </div>
  );
}

/** RichGrid inventory picker. Filtering and draft state stay with the event setup host. */
export function InventoryPickerGrid({
  rows,
  selectedRowIds,
  drafts,
  onSelectedRowIdsChange,
  onDraftChange,
  purpose = "event",
}: InventoryPickerGridProps) {
  const draftFor = (row: CatalogRow) => {
    return drafts[row.id] ?? (
      purpose === "inventory" ? inventoryDraftFromCatalog(row) : draftFromCatalog(row)
    );
  };
  const columns = useMemo<ColumnDef<CatalogRow>[]>(
    () => [
      {
        key: "product",
        header: "Product",
        headerText: "Product",
        // Preserve a readable product track when the seller dock is narrow.
        // RichGrid owns horizontal overflow, so collapsing this to a bare fr
        // track only makes the text disappear without saving any scroll.
        width: "minmax(180px, 2.4fr)",
        toCopyText: (row) => `${row.title} — ${row.brand}`,
        render: ({ row }) => <ProductCell row={row} />,
      },
      {
        key: "variant",
        header: "Variant",
        headerText: "Variant",
        // Color and size are the decision-making axis for these rows. Keep
        // enough width for both labels on phone-sized dock panes.
        width: "minmax(150px, 1.5fr)",
        toCopyText: (row) => `${row.sku} · ${variantAxisLabel(row)}`,
        render: ({ row }) => (
          <div className="event-variant-cell">
            <strong>{row.sku}</strong>
            <span>{variantAxisLabel(row)}</span>
          </div>
        ),
      },
      {
        key: "price",
        header: purpose === "inventory" ? "Unit price" : "Event price",
        headerText: purpose === "inventory" ? "Unit price" : "Event price",
        width: "minmax(125px, 1fr)",
        align: "right",
        toCopyText: (row) =>
          formatPrice(drafts[row.id]?.eventPriceCents ?? row.priceCents),
        render: ({ row }) => {
          const draft = draftFor(row);
          return (
            <label className="event-number-field">
              <span className="sr-only">{purpose === "inventory" ? "Unit price" : "Event price"} for {row.title}</span>
              <span className="currency-prefix">$</span>
              <input
                aria-label={`${purpose === "inventory" ? "Unit price" : "Event price"} for ${row.title} ${row.sku}`}
                inputMode="decimal"
                value={(draft.eventPriceCents / 100).toFixed(2)}
                onChange={(event) =>
                  onDraftChange(row, "eventPriceCents", event.target.value)
                }
                onClick={(event) => event.stopPropagation()}
              />
            </label>
          );
        },
      },
      {
        key: "quantity",
        header: purpose === "inventory" ? "Qty" : "Event qty",
        headerText: purpose === "inventory" ? "Qty" : "Event qty",
        width: "minmax(120px, .8fr)",
        align: "right",
        toCopyText: (row) => String(draftFor(row).quantityLimit),
        render: ({ row }) => {
          const draft = draftFor(row);
          return (
            <label className="event-number-field quantity-field">
              <span className="sr-only">{purpose === "inventory" ? "Total quantity" : "Event quantity"} for {row.title}</span>
              <input
                aria-label={`${purpose === "inventory" ? "Total quantity" : "Event quantity"} for ${row.title} ${row.sku}`}
                type="number"
                min={purpose === "inventory" ? row.reservedQty ?? 0 : row.availableQty > 0 ? 1 : 0}
                max={purpose === "inventory" ? undefined : row.availableQty}
                step={1}
                value={draft.quantityLimit}
                disabled={purpose === "event" && row.availableQty === 0}
                onChange={(event) =>
                  onDraftChange(row, "quantityLimit", event.target.value)
                }
                onClick={(event) => event.stopPropagation()}
              />
              <span className="quantity-stock">{purpose === "inventory" ? row.availableQty : `/${row.availableQty}`}</span>
            </label>
          );
        },
      },
      ...(purpose === "inventory" ? [{
        key: "reserved",
        header: "Reserved",
        headerText: "Reserved",
        width: "minmax(92px, .65fr)",
        align: "right" as const,
        toCopyText: (row: CatalogRow) => String(row.reservedQty ?? 0),
        render: ({ row }: { row: CatalogRow }) => (
          <span
            className="inventory-reserved-qty"
            aria-label={`${row.reservedQty ?? 0} reserved`}
          >
            {row.reservedQty ?? 0}
          </span>
        ),
      }] : []),
      {
        key: "availability",
        header: purpose === "inventory" ? "Available" : "Stock",
        headerText: purpose === "inventory" ? "Available" : "Stock",
        width: "minmax(82px, .6fr)",
        align: "right",
        toCopyText: (row) => `${row.availableQty} available`,
        render: ({ row }) => (
          <span
            className={`stock-badge ${row.availableQty > 0 ? "in-stock" : "out-of-stock"}`}
          >
            {row.availableQty > 0 ? `${row.availableQty} ready` : "Sold out"}
          </span>
        ),
      },
    ],
    [drafts, onDraftChange, purpose],
  );

  const selectRows = (next: ReadonlySet<string>) => {
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    onSelectedRowIdsChange(
      new Set(
        [...next].filter((id) => purpose === "inventory" || (rowsById.get(id)?.availableQty ?? 0) > 0),
      ),
    );
  };

  return (
    <RichGrid
      className="event-catalog-grid"
      columns={columns}
      rows={[...rows]}
      getRowId={(row) => row.id}
      selectable
      selectedRowIds={selectedRowIds}
      onSelectedRowIdsChange={selectRows}
      onRowClick={(row) => {
        if (purpose === "event" && row.availableQty === 0) return;
        const next = new Set(selectedRowIds);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        selectRows(next);
      }}
      rowProps={({ row }) => ({
        "data-testid": `catalog-row-${row.id}`,
        "aria-label": `${row.title}, ${row.sku}, ${row.availableQty} available`,
        className: purpose === "event" && row.availableQty === 0 ? "catalog-row-unavailable" : undefined,
      })}
      topSlot={
        <div className="event-grid-note">
          <span>
            <strong>Catalog</strong> · select with the row checkboxes
          </span>
          <span>{purpose === "inventory" ? "Unit price and total Qty are editable per variant" : "Offer price and qty are editable per item"}</span>
        </div>
      }
      empty={
        <div className="event-grid-empty">
          No catalog items match those filters.
        </div>
      }
      rowMinHeight={58}
      headerHeight={42}
    />
  );
}

export default InventoryPickerGrid;
