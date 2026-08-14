import { useCallback, useEffect, useState } from 'react';
import { useBuyerIdentity } from './buyer-identity';
import { resolveApiBaseUrl } from './catalog';
import { formatReplayTime } from './ReplayChapters';
import './orders.css';

export type BuyerOrderSource = 'checkout' | 'auction' | 'offer';
export type BuyerOrderStatus = 'pending' | 'paid' | 'failed' | 'accepted' | 'expired' | 'cancelled';

export interface BuyerOrderItem {
  productId: string;
  title: string;
  quantity: number;
  unitPriceCents: number;
  imageUrl?: string;
}

export interface BuyerOrderVideoSnapshot {
  id: string;
  eventId: string;
  eventTitle: string;
  sellerName?: string;
  productId: string;
  productTitle: string;
  thumbnailUrl?: string;
  startMs?: number;
  endMs?: number;
  previewText?: string;
}

export interface BuyerOrder {
  id: string;
  source: BuyerOrderSource;
  buyerId: string;
  eventId: string;
  eventTitle: string;
  sellerName?: string;
  status: BuyerOrderStatus;
  createdAt: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: 'USD';
  items: BuyerOrderItem[];
  videoSnapshots: BuyerOrderVideoSnapshot[];
}

interface BuyerOrdersResponse {
  orders?: BuyerOrder[];
  message?: string;
}

const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export function formatOrderMoney(cents: number): string {
  return moneyFormatter.format(cents / 100);
}

export function formatOrderDate(createdAt: string): string {
  const value = new Date(createdAt);
  return Number.isNaN(value.getTime()) ? 'Date unavailable' : dateFormatter.format(value);
}

export function orderStatusLabel(status: BuyerOrderStatus): string {
  if (status === 'paid') return 'Paid';
  if (status === 'accepted') return 'Offer accepted';
  if (status === 'failed') return 'Payment failed';
  if (status === 'expired') return 'Offer expired';
  if (status === 'cancelled') return 'Cancelled';
  return 'Pending';
}

export function orderSourceLabel(source: BuyerOrderSource): string {
  if (source === 'auction') return 'Auction win';
  if (source === 'offer') return 'Private offer';
  return 'Checkout';
}

export async function fetchBuyerOrders(
  buyerId: string,
  apiBaseUrl?: string,
  signal?: AbortSignal,
): Promise<BuyerOrder[]> {
  const params = new URLSearchParams({ buyerId });
  const response = await fetch(`${resolveApiBaseUrl(apiBaseUrl)}/checkout/orders?${params.toString()}`, { signal });
  const payload = await response.json().catch(() => ({})) as BuyerOrdersResponse;
  if (!response.ok) throw new Error(payload.message ?? `Orders request failed: HTTP ${response.status}`);
  return Array.isArray(payload.orders) ? payload.orders : [];
}

function SnapshotTile({ snapshot }: { snapshot: BuyerOrderVideoSnapshot }) {
  return (
    <article className="order-snapshot">
      <div className="order-snapshot-media">
        {snapshot.thumbnailUrl ? <img src={snapshot.thumbnailUrl} alt="" /> : <span aria-hidden="true">▶</span>}
        <span className="order-snapshot-time">
          {snapshot.startMs === undefined ? 'Event replay' : formatReplayTime(snapshot.startMs)}
        </span>
      </div>
      <div className="order-snapshot-copy">
        <strong>{snapshot.productTitle}</strong>
        <span>{snapshot.eventTitle}</span>
        {snapshot.previewText ? <p>{snapshot.previewText}</p> : <p>Your product moment from this event.</p>}
      </div>
    </article>
  );
}

export function OrderHistory({ orders, buyerId }: { orders: readonly BuyerOrder[]; buyerId: string }) {
  if (orders.length === 0) {
    return (
      <section className="orders-empty" aria-live="polite">
        <span aria-hidden="true">◎</span>
        <h2>No orders for {buyerId}</h2>
        <p>Buy from a live, win an auction, or accept a private offer and it will show up here.</p>
      </section>
    );
  }

  return (
    <ol className="orders-list" aria-label={`Orders for ${buyerId}`}>
      {orders.map((order) => (
        <li className="order-card" key={`${order.source}:${order.id}`}>
          <article>
            <header className="order-card-header">
              <div>
                <div className="order-card-kicker">
                  <span>{orderSourceLabel(order.source)}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={order.createdAt}>{formatOrderDate(order.createdAt)}</time>
                </div>
                <h2>{order.eventTitle}</h2>
                {order.sellerName ? <p>{order.sellerName}</p> : null}
              </div>
              <div className="order-card-summary">
                <span className={`order-status order-status-${order.status}`}>{orderStatusLabel(order.status)}</span>
                <strong>{formatOrderMoney(order.totalCents)}</strong>
              </div>
            </header>

            <div className="order-items">
              {order.items.map((item) => (
                <div className="order-item" key={item.productId}>
                  <div className="order-item-thumb">
                    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span aria-hidden="true">◇</span>}
                  </div>
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.quantity} × {formatOrderMoney(item.unitPriceCents)}</span>
                  </div>
                </div>
              ))}
            </div>

            {order.videoSnapshots.length > 0 ? (
              <section className="order-video-section" aria-label="Video snapshots">
                <div className="order-video-heading">
                  <div>
                    <p className="eyebrow">From the live</p>
                    <h3>Your product moments</h3>
                  </div>
                  <span>{order.videoSnapshots.length} {order.videoSnapshots.length === 1 ? 'snapshot' : 'snapshots'}</span>
                </div>
                <div className="order-snapshot-grid">
                  {order.videoSnapshots.map((snapshot) => <SnapshotTile snapshot={snapshot} key={snapshot.id} />)}
                </div>
              </section>
            ) : null}

            <footer className="order-card-footer">
              <span>Order {order.id}</span>
              {order.shippingCents > 0 ? <span>Includes {formatOrderMoney(order.shippingCents)} shipping</span> : null}
            </footer>
          </article>
        </li>
      ))}
    </ol>
  );
}

export function OrdersTab({ apiBaseUrl }: { apiBaseUrl?: string }) {
  const { buyerId } = useBuyerIdentity();
  const [orders, setOrders] = useState<BuyerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void fetchBuyerOrders(buyerId, apiBaseUrl, controller.signal)
      .then((result) => setOrders(result))
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : 'Unable to load orders');
        setOrders([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [apiBaseUrl, buyerId, refreshKey]);

  return (
    <section className="tab-layout density-roomy orders-page">
      <header className="orders-page-header">
        <div>
          <p className="eyebrow">Buyer history</p>
          <h1>My orders</h1>
          <p className="tab-copy">Every checkout, auction win, and private offer for this demo identity—plus the live moments behind each purchase.</p>
        </div>
        <div className="orders-identity">
          <span>Showing orders for</span>
          <strong>{buyerId}</strong>
          <button className="button secondary" type="button" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error ? (
        <section className="orders-error" role="alert">
          <strong>Orders could not be loaded.</strong>
          <span>{error}</span>
          <button className="button secondary" type="button" onClick={refresh}>Try again</button>
        </section>
      ) : loading ? (
        <p className="orders-loading" role="status">Gathering orders for {buyerId}…</p>
      ) : (
        <OrderHistory orders={orders} buyerId={buyerId} />
      )}
    </section>
  );
}
