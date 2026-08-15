import { formatBuyerPrice, type BuyerProduct } from "./buyer";
import "./BuyerProductRail.css";

export interface BuyerProductRailProps {
  products: readonly BuyerProduct[];
  selectedProductId?: string | null;
  heldProductIds?: readonly string[];
  sequenceByProductId?: Readonly<Record<string, number>>;
  currentSequenceNumber?: number;
  totalProducts?: number;
  ariaLabel?: string;
  onHold: (product: BuyerProduct) => void | Promise<void>;
}

function runwayPositionLabel(sequenceNumber: number, currentSequenceNumber: number): string {
  if (sequenceNumber < currentSequenceNumber) return "Already shown";
  if (sequenceNumber === currentSequenceNumber) return "Live now";
  if (sequenceNumber === currentSequenceNumber + 1) return "Up next";
  if (sequenceNumber === currentSequenceNumber + 2) return "After that";
  return "Later";
}

function ProductCard({
  product,
  selected,
  sequenceNumber,
  currentSequenceNumber,
  totalProducts,
  onHold,
}: {
  product: BuyerProduct;
  selected: boolean;
  sequenceNumber: number;
  currentSequenceNumber: number;
  totalProducts: number;
  onHold: (product: BuyerProduct) => void | Promise<void>;
}) {
  const soldOut = product.availableQty <= 0;
  const positionLabel = runwayPositionLabel(sequenceNumber, currentSequenceNumber);
  const isNext = sequenceNumber === currentSequenceNumber + 1;
  const isCurrent = sequenceNumber === currentSequenceNumber;
  return (
    <li
      className={`buyer-product-preview${selected ? " is-selected" : ""}${soldOut ? " is-sold-out" : ""}${isNext ? " is-next" : ""}${isCurrent ? " is-current" : ""}`}
      data-product-id={product.id}
      data-sequence-number={sequenceNumber}
      aria-label={`${positionLabel}, item ${sequenceNumber} of ${totalProducts}`}
      aria-current={isCurrent ? "step" : undefined}
    >
      <span className="buyer-runway-step" aria-hidden="true">{sequenceNumber}</span>
      <div className="buyer-rail-art" aria-hidden="true">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt="" width="480" height="360" loading="lazy" />
        ) : (
          <span>{product.title.slice(0, 1)}</span>
        )}
        {product.badge ? (
          <span className="buyer-product-badge">{product.badge}</span>
        ) : null}
      </div>
      <div className="buyer-rail-copy">
        <span className={`buyer-runway-position${isNext ? " is-next" : ""}${isCurrent ? " is-current" : ""}`}>
          {positionLabel}
        </span>
        <div className="buyer-rail-meta">
          <span className={`buyer-rail-stock ${soldOut ? "sold-out" : "available"}`}>
            {soldOut ? "Sold out" : `${product.availableQty} available`}
          </span>
        </div>
        <h4>{product.title}</h4>
        <p>{product.subtitle}</p>
        <div className="buyer-rail-footer">
          <div className="buyer-rail-price">
            <strong>{formatBuyerPrice(product.priceCents)}</strong>
            {product.compareAtPriceCents ? <del>{formatBuyerPrice(product.compareAtPriceCents)}</del> : null}
          </div>
          <button
            className="button secondary buyer-rail-action"
            type="button"
            disabled={soldOut && !selected}
            aria-label={selected
              ? `Open held ${product.title}`
              : soldOut
                ? `${product.title} is sold out`
                : `Hold ${product.title}`}
            onClick={() => void onHold(product)}
          >
            {selected ? "Held for you" : soldOut ? "Sold out" : "Hold item"}
          </button>
        </div>
      </div>
    </li>
  );
}

export function BuyerProductRail({
  products,
  selectedProductId = null,
  heldProductIds = [],
  sequenceByProductId,
  currentSequenceNumber = 0,
  totalProducts = products.length,
  ariaLabel = "Upcoming products in sale order",
  onHold,
}: BuyerProductRailProps) {
  if (products.length === 0) {
    return (
      <div className="buyer-rail-empty" role="status">
        {totalProducts > 0 ? "That’s the end of this drop." : "The drop lineup is not published yet."}
      </div>
    );
  }
  const heldProductIdSet = new Set(heldProductIds);

  return (
    <ul className="buyer-product-rail" aria-label={ariaLabel}>
      {products.map((product, index) => (
        <ProductCard
          key={product.id}
          product={product}
          selected={selectedProductId === product.id || heldProductIdSet.has(product.id)}
          sequenceNumber={sequenceByProductId?.[product.id] ?? index + 1}
          currentSequenceNumber={currentSequenceNumber}
          totalProducts={Math.max(totalProducts, products.length)}
          onHold={onHold}
        />
      ))}
    </ul>
  );
}

export default BuyerProductRail;
