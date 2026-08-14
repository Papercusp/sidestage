import { useEffect, useState } from 'react';

export interface PricingHistory {
  productId: string;
  prices: Array<{ priceCents: number; soldQty: number; rejectedQty: number }>;
  offers: Array<{
    id: string;
    buyerId: string;
    priceCents: number;
    quantity: number;
    outcome: 'pending' | 'accepted' | 'rejected';
  }>;
  auctions: Array<{
    id: string;
    priceCents: number;
    quantity: number;
    outcome: 'active' | 'sold' | 'no-sale';
    bidderId?: string;
  }>;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function pricingHistoryUrl(eventId: string, productId: string, apiBaseUrl = 'http://localhost:3100'): string {
  const base = apiBaseUrl.replace(/\/$/, '');
  return `${base}/events/${encodeURIComponent(eventId)}/products/${encodeURIComponent(productId)}/pricing-history`;
}

export function PricingHistoryContent({ history }: { history: PricingHistory }) {
  const empty = history.prices.length === 0 && history.offers.length === 0 && history.auctions.length === 0;
  if (empty) return <p className="pricing-history-empty">No sales, offers, or auctions for this product yet.</p>;
  return (
    <div className="pricing-history-sections">
      {history.prices.length > 0 ? (
        <section aria-labelledby="pricing-sales-title">
          <h4 id="pricing-sales-title">Sales by price</h4>
          <ul>{history.prices.map((row) => (
            <li key={row.priceCents}><strong>{money(row.priceCents)}</strong><span>{row.soldQty} sold</span><span>{row.rejectedQty} rejected</span></li>
          ))}</ul>
        </section>
      ) : null}
      {history.offers.length > 0 ? (
        <section aria-labelledby="pricing-offers-title">
          <h4 id="pricing-offers-title">Buyer offers</h4>
          <ul>{history.offers.map((offer) => (
            <li key={offer.id}><strong>{offer.buyerId}</strong><span>{offer.quantity} × {money(offer.priceCents)}</span><span className={`history-outcome history-${offer.outcome}`}>{offer.outcome}</span></li>
          ))}</ul>
        </section>
      ) : null}
      {history.auctions.length > 0 ? (
        <section aria-labelledby="pricing-auctions-title">
          <h4 id="pricing-auctions-title">Auction outcomes</h4>
          <ul>{history.auctions.map((auction) => (
            <li key={auction.id}><strong>{auction.quantity} × {money(auction.priceCents)}</strong><span>{auction.bidderId ?? 'No winner'}</span><span className={`history-outcome history-${auction.outcome}`}>{auction.outcome}</span></li>
          ))}</ul>
        </section>
      ) : null}
    </div>
  );
}

export function PricingHistoryPanel({ eventId, productId, apiBaseUrl }: { eventId: string; productId: string; apiBaseUrl?: string }) {
  const [history, setHistory] = useState<PricingHistory | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setError(false);
    fetch(pricingHistoryUrl(eventId, productId, apiBaseUrl))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Pricing history failed (${response.status})`);
        return response.json() as Promise<PricingHistory>;
      })
      .then((next) => { if (!cancelled) setHistory(next); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [apiBaseUrl, eventId, productId]);

  return (
    <section className="pricing-history" aria-labelledby="pricing-history-title" aria-busy={!history && !error}>
      <div className="pricing-history-heading"><h3 id="pricing-history-title">Pricing history</h3><span>Active product</span></div>
      {error ? <p className="pricing-history-error" role="alert">Pricing history could not be loaded.</p> : null}
      {!history && !error ? <p className="pricing-history-empty">Loading product outcomes…</p> : null}
      {history ? <PricingHistoryContent history={history} /> : null}
    </section>
  );
}
