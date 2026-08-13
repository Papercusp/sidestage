import { useMemo } from "react";
import { RichGrid, type ColumnDef } from "@papercusp/grid-core";

import {
  draftFromCatalog,
  formatPrice,
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
}: InventoryPickerGridProps) {
  const columns = useMemo<ColumnDef<CatalogRow>[]>(
    () => [
      {
        key: "product",
        header: "Product",
        headerText: "Product",
        width: 2.4,
        toCopyText: (row) => `${row.title} — ${row.brand}`,
        render: ({ row }) => <ProductCell row={row} />,
      },
      {
        key: "variant",
        header: "Variant",
        headerText: "Variant",
        width: 1.5,
        toCopyText: (row) => `${row.sku} · ${row.condition}`,
        render: ({ row }) => (
          <div className="event-variant-cell">
            <strong>{row.sku}</strong>
            <span>
              {row.condition} · {row.handlingDays ?? "—"}d handling
            </span>
          </div>
        ),
      },
      {
        key: "price",
        header: "Event price",
        headerText: "Event price",
        width: "minmax(125px, 1fr)",
        align: "right",
        toCopyText: (row) =>
          formatPrice(drafts[row.id]?.eventPriceCents ?? row.priceCents),
        render: ({ row }) => {
          const draft = drafts[row.id] ?? draftFromCatalog(row);
          return (
            <label className="event-number-field">
              <span className="sr-only">Event price for {row.title}</span>
              <span className="currency-prefix">$</span>
              <input
                aria-label={`Event price for ${row.title} ${row.sku}`}
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
        header: "Event qty",
        headerText: "Event qty",
        width: "minmax(120px, .8fr)",
        align: "right",
        toCopyText: (row) => String(drafts[row.id]?.quantityLimit ?? 1),
        render: ({ row }) => {
          const draft = drafts[row.id] ?? draftFromCatalog(row);
          return (
            <label className="event-number-field quantity-field">
              <span className="sr-only">Event quantity for {row.title}</span>
              <input
                aria-label={`Event quantity for ${row.title} ${row.sku}`}
                type="number"
                min={row.availableQty > 0 ? 1 : 0}
                max={row.availableQty}
                step={1}
                value={draft.quantityLimit}
                disabled={row.availableQty === 0}
                onChange={(event) =>
                  onDraftChange(row, "quantityLimit", event.target.value)
                }
                onClick={(event) => event.stopPropagation()}
              />
              <span className="quantity-stock">/{row.availableQty}</span>
            </label>
          );
        },
      },
      {
        key: "availability",
        header: "Stock",
        headerText: "Stock",
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
    [drafts, onDraftChange],
  );

  const selectRows = (next: ReadonlySet<string>) => {
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    onSelectedRowIdsChange(
      new Set(
        [...next].filter((id) => (rowsById.get(id)?.availableQty ?? 0) > 0),
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
        if (row.availableQty === 0) return;
        const next = new Set(selectedRowIds);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        selectRows(next);
      }}
      rowProps={({ row }) => ({
        "data-testid": `catalog-row-${row.id}`,
        "aria-label": `${row.title}, ${row.sku}, ${row.availableQty} available`,
        className:
          row.availableQty === 0 ? "catalog-row-unavailable" : undefined,
      })}
      topSlot={
        <div className="event-grid-note">
          <span>
            <strong>Catalog</strong> · select with the row checkboxes
          </span>
          <span>Offer price and qty are editable per item</span>
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
