import { formatBuyerPrice, type BuyerProduct } from "./buyer";
import "./BuyerProductRail.css";

export interface BuyerProductRailProps {
  products: readonly BuyerProduct[];
  selectedProductId?: string | null;
  heldProductIds?: readonly string[];
  onHold: (product: BuyerProduct) => void | Promise<void>;
}

function ProductCard({
  product,
  selected,
  onHold,
}: {
  product: BuyerProduct;
  selected: boolean;
  onHold: (product: BuyerProduct) => void | Promise<void>;
}) {
  const soldOut = product.availableQty <= 0;
  return (
    <li
      className={`buyer-product-preview${selected ? " is-selected" : ""}${soldOut ? " is-sold-out" : ""}`}
      data-product-id={product.id}
    >
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
  onHold,
}: BuyerProductRailProps) {
  if (products.length === 0) return <div className="buyer-rail-empty">No products are on stage yet.</div>;
  const heldProductIdSet = new Set(heldProductIds);

  return (
    <ul className="buyer-product-rail" aria-label="Coming up">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          selected={selectedProductId === product.id || heldProductIdSet.has(product.id)}
          onHold={onHold}
        />
      ))}
    </ul>
  );
}

export default BuyerProductRail;
