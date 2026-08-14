import type { CatalogProduct } from '../seller-products';
import { PricingHistoryPanel } from './PricingHistoryPanel';

export interface OnDeckPanelProps {
  /** The product currently staged, or null when the seller has not picked one. */
  selectedProduct: CatalogProduct | null;
  eventId: string;
  apiBaseUrl?: string;
}

/**
 * The seller on-deck section (P-008).
 *
 * Extracted verbatim from SellerTab's inline `stage-panel` on-deck section so
 * it can be mounted as a standalone dock panel (P-009). Purely presentational:
 * the staged product arrives as a prop.
 */
export function OnDeckPanel({ selectedProduct, eventId, apiBaseUrl }: OnDeckPanelProps) {
  return (
    <section className="stage-panel" aria-labelledby="on-deck-title">
      <div className="panel-kicker">On deck <span className="panel-status">1 slot</span></div>
      {selectedProduct ? (
        <>
          <div className="on-deck-product">
            <div className={`mini-product-mark tone-${selectedProduct.tone}`}>{selectedProduct.glyph}</div>
            <div><h3 id="on-deck-title">{selectedProduct.name}</h3><p>{selectedProduct.price} · {selectedProduct.stockLabel}</p></div>
          </div>
          <PricingHistoryPanel eventId={eventId} productId={selectedProduct.id} apiBaseUrl={apiBaseUrl} />
        </>
      ) : (
        <div className="empty-state"><span className="empty-state-icon">＋</span><h3 id="on-deck-title">Choose a product</h3><p>Use the Buyer tab to place the first item on stage.</p></div>
      )}
    </section>
  );
}

export default OnDeckPanel;
