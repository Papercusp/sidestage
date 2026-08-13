import { useMemo } from "react";
import { RichGrid, type ColumnDef } from "@papercusp/grid-core";

import { formatBuyerPrice, type BuyerProduct } from "./buyer";
import "./BuyerProductRail.css";

export interface BuyerProductRailProps {
  products: readonly BuyerProduct[];
  selectedProductId?: string | null;
  onHold: (product: BuyerProduct) => void | Promise<void>;
}

function ProductCell({ product }: { product: BuyerProduct }) {
  return (
    <div className="buyer-rail-product">
      <div className="buyer-rail-art" aria-hidden="true">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt="" loading="lazy" />
        ) : (
          <span>{product.title.slice(0, 1)}</span>
        )}
        {product.badge ? (
          <span className="buyer-product-badge">{product.badge}</span>
        ) : null}
      </div>
      <div className="buyer-rail-copy">
        <strong>{product.title}</strong>
        <span>{product.subtitle}</span>
      </div>
    </div>
  );
}

/** RichGrid-backed product rail. Data loading and inventory holds stay with the host. */
export function BuyerProductRail({
  products,
  selectedProductId = null,
  onHold,
}: BuyerProductRailProps) {
  const columns = useMemo<ColumnDef<BuyerProduct>[]>(
    () => [
      {
        key: "product",
        header: "Product",
        headerText: "Product",
        width: 2.5,
        toCopyText: (product) => `${product.title} — ${product.subtitle}`,
        render: ({ row }) => <ProductCell product={row} />,
      },
      {
        key: "price",
        header: "Price",
        headerText: "Price",
        width: "minmax(110px, .85fr)",
        align: "right",
        toCopyText: (product) => formatBuyerPrice(product.priceCents),
        render: ({ row }) => (
          <div className="buyer-rail-price">
            <strong>{formatBuyerPrice(row.priceCents)}</strong>
            {row.compareAtPriceCents ? (
              <del>{formatBuyerPrice(row.compareAtPriceCents)}</del>
            ) : null}
          </div>
        ),
      },
      {
        key: "availability",
        header: "Availability",
        headerText: "Availability",
        width: "minmax(105px, .75fr)",
        align: "right",
        toCopyText: (product) =>
          product.availableQty > 0
            ? `${product.availableQty} available`
            : "Sold out",
        render: ({ row }) => (
          <span
            className={`buyer-rail-stock ${row.availableQty > 0 ? "available" : "sold-out"}`}
          >
            {row.availableQty > 0 ? `${row.availableQty} ready` : "Sold out"}
          </span>
        ),
      },
      {
        key: "action",
        header: "Hold",
        headerText: "Hold",
        width: "minmax(110px, .8fr)",
        align: "right",
        toCopyText: (product) =>
          product.availableQty > 0 ? "Hold item" : "Sold out",
        render: ({ row }) => {
          const soldOut = row.availableQty <= 0;
          return (
            <button
              className="button secondary buyer-rail-action"
              type="button"
              disabled={soldOut}
              onClick={(event) => {
                event.stopPropagation();
                void onHold(row);
              }}
            >
              {soldOut
                ? "Sold out"
                : selectedProductId === row.id
                  ? "Held for you"
                  : "Hold item"}
            </button>
          );
        },
      },
    ],
    [onHold, selectedProductId],
  );

  return (
    <RichGrid
      className="buyer-product-rail"
      columns={columns}
      rows={[...products]}
      getRowId={(product) => product.id}
      rowProps={({ row }) => ({
        "data-product-id": row.id,
        "aria-label": `${row.title}, ${formatBuyerPrice(row.priceCents)}, ${row.availableQty} available`,
        className:
          row.availableQty <= 0 ? "buyer-rail-row-sold-out" : undefined,
      })}
      getRowBg={(_product, _rowIndex, selected) =>
        selected ? "rgba(98, 216, 255, .1)" : "rgba(7, 17, 34, .3)"
      }
      selectedRowIds={
        selectedProductId ? new Set([selectedProductId]) : new Set()
      }
      empty={
        <div className="buyer-rail-empty">No products are on stage yet.</div>
      }
      rowMinHeight={78}
      headerHeight={40}
    />
  );
}

export default BuyerProductRail;
