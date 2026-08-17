import { useMemo, useState } from 'react';
import { useRestSyncQuery } from '@papercusp/sync';
import { useBuyerCheckout } from './BuyerCheckout';
import { useBuyerIdentity } from './buyer-identity';
import { formatReplayTime } from './ReplayChapters';
import './orders.css';

export type BuyerOrderSource = 'checkout' | 'auction' | 'offer';
export type BuyerOrderStatus = 'pending' | 'paid' | 'failed' | 'accepted' | 'expired' | 'cancelled';
export type BuyerOrderPaymentState =
  | 'payment_required'
  | 'payment_processing'
  | 'paid'
  | 'payment_failed'
  | 'cancelled'
  | 'expired';
export type OrderFilter = 'all' | 'needs-action' | 'in-progress' | 'completed';
export type OrderSort = 'newest' | 'oldest' | 'highest-total';

export interface BuyerOrderCheckoutCapability {
  action: 'checkout' | 'resume';
  orderId: string;
}

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
  evidenceKind?: 'condition';
  evidenceLabel?: string;
}

export interface BuyerOrder {
  id: string;
  source: BuyerOrderSource;
  sourceId: string;
  buyerId: string;
  eventId: string;
  eventTitle: string;
  sellerName?: string;
  status: BuyerOrderStatus;
  paymentState: BuyerOrderPaymentState | null;
  checkoutCapability: BuyerOrderCheckoutCapability | null;
  createdAt: string;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: 'USD';
  items: BuyerOrderItem[];
  sourceSnapshot: Readonly<Record<string, unknown>>;
  videoSnapshots: BuyerOrderVideoSnapshot[];
}

export interface BuyerOrderSummary {
  orderCount: number;
  paidTotalCents: number;
  needsActionCount: number;
  inProgressCount: number;
  eventCount: number;
}

const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

const FILTERS: ReadonlyArray<{ id: OrderFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'needs-action', label: 'Needs action' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'completed', label: 'Completed' },
];

export function formatOrderMoney(cents: number): string {
  return moneyFormatter.format(cents / 100);
}

export function formatOrderDate(createdAt: string): string {
  const value = new Date(createdAt);
  return Number.isNaN(value.getTime()) ? 'Date unavailable' : dateFormatter.format(value);
}

export function orderStatusLabel(
  status: BuyerOrderStatus,
  paymentState: BuyerOrderPaymentState | null = null,
): string {
  if (paymentState === 'payment_required') return 'Payment required';
  if (paymentState === 'payment_processing') return 'Processing';
  if (paymentState === 'payment_failed') return 'Payment failed';
  if (paymentState === 'paid') return 'Paid';
  if (paymentState === 'cancelled') return 'Cancelled';
  if (paymentState === 'expired') return 'Expired';
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
  return 'Buy now';
}

export function orderFilterForStatus(
  status: BuyerOrderStatus,
  paymentState: BuyerOrderPaymentState | null = null,
): Exclude<OrderFilter, 'all'> {
  if (paymentState === 'payment_required' || paymentState === 'payment_failed') return 'needs-action';
  if (paymentState === 'payment_processing') return 'in-progress';
  if (paymentState !== null) return 'completed';
  if (status === 'failed') return 'needs-action';
  if (status === 'pending' || status === 'accepted') return 'in-progress';
  return 'completed';
}

export function summarizeOrders(orders: readonly BuyerOrder[]): BuyerOrderSummary {
  const summary = orders.reduce<BuyerOrderSummary>((result, order) => {
    if (order.paymentState === 'paid' || (order.paymentState === null && order.status === 'paid')) {
      result.paidTotalCents += order.totalCents;
    }
    if (orderFilterForStatus(order.status, order.paymentState) === 'needs-action') result.needsActionCount += 1;
    if (orderFilterForStatus(order.status, order.paymentState) === 'in-progress') result.inProgressCount += 1;
    return result;
  }, {
    orderCount: orders.length,
    paidTotalCents: 0,
    needsActionCount: 0,
    inProgressCount: 0,
    eventCount: new Set(orders.map((order) => order.eventId)).size,
  });
  return summary;
}

function orderTimestamp(order: BuyerOrder): number {
  const timestamp = new Date(order.createdAt).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function filterAndSortOrders(
  orders: readonly BuyerOrder[],
  search: string,
  filter: OrderFilter,
  sort: OrderSort,
): BuyerOrder[] {
  const query = search.trim().toLocaleLowerCase();
  const matches = orders.filter((order) => {
    if (filter !== 'all' && orderFilterForStatus(order.status, order.paymentState) !== filter) return false;
    if (!query) return true;
    const searchable = [
      order.id,
      order.eventTitle,
      order.sellerName,
      orderSourceLabel(order.source),
      orderStatusLabel(order.status, order.paymentState),
      ...order.items.flatMap((item) => [item.title, item.productId]),
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    return searchable.includes(query);
  });

  return matches.sort((left, right) => {
    if (sort === 'highest-total') return right.totalCents - left.totalCents || orderTimestamp(right) - orderTimestamp(left);
    if (sort === 'oldest') return orderTimestamp(left) - orderTimestamp(right);
    return orderTimestamp(right) - orderTimestamp(left);
  });
}

export function orderEventHref(eventId: string): string {
  const params = new URLSearchParams({ tab: 'buyer', event: eventId });
  return `/?${params.toString()}`;
}

function orderActionLabel(order: BuyerOrder): string {
  if (order.status === 'failed') return 'Retry from event';
  if (order.status === 'pending' && order.source === 'checkout') return 'Resume checkout';
  if (order.status === 'pending' && order.source === 'offer') return 'Review offer';
  if (order.status === 'accepted') return 'View accepted offer';
  if (order.status === 'expired' || order.status === 'cancelled') return 'Browse event';
  return 'View live event';
}

function checkoutActionLabel(capability: BuyerOrderCheckoutCapability): string {
  return capability.action === 'resume' ? 'Resume checkout' : 'Checkout';
}

function orderHeadline(order: BuyerOrder): string {
  const firstItem = order.items[0]?.title ?? order.eventTitle;
  const additionalItems = order.items.length - 1;
  return additionalItems > 0 ? `${firstItem} + ${additionalItems} more` : firstItem;
}

function orderKey(order: BuyerOrder): string {
  return `${order.source}:${order.id}`;
}

function OrderMetrics({ orders }: { orders: readonly BuyerOrder[] }) {
  const summary = summarizeOrders(orders);
  return (
    <section className="orders-metrics" aria-label="Order summary">
      <article>
        <span>Orders</span>
        <strong>{summary.orderCount}</strong>
        <small>Across {summary.eventCount} {summary.eventCount === 1 ? 'live event' : 'live events'}</small>
      </article>
      <article>
        <span>Paid total</span>
        <strong>{formatOrderMoney(summary.paidTotalCents)}</strong>
        <small>Completed payments only</small>
      </article>
      <article className={summary.needsActionCount > 0 ? 'is-attention' : undefined}>
        <span>Needs action</span>
        <strong>{summary.needsActionCount}</strong>
        <small>{summary.needsActionCount > 0 ? 'Payment needs another look' : 'Nothing waiting on you'}</small>
      </article>
      <article>
        <span>In progress</span>
        <strong>{summary.inProgressCount}</strong>
        <small>Pending payments and offers</small>
      </article>
    </section>
  );
}

function OrdersEmpty({ buyerId }: { buyerId: string }) {
  return (
    <section className="orders-empty" aria-live="polite">
      <div className="orders-empty-preview" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="eyebrow">Purchase timeline</p>
      <h2>No orders yet</h2>
      <p>Purchases for <strong>{buyerId}</strong> will appear here with their payment status and original live moment.</p>
      <div className="orders-empty-actions">
        <a className="button primary" href="/?tab=buyer">Browse live events</a>
        <details className="orders-buying-guide">
          <summary className="button secondary">How buying works</summary>
          <p>Buy now, win an auction, or accept a private offer. SideStage keeps the resulting order connected to its source event.</p>
        </details>
      </div>
    </section>
  );
}

function StatusBadge({ order }: { order: BuyerOrder }) {
  const visualState = order.paymentState === 'payment_failed'
    ? 'failed'
    : order.paymentState ?? order.status;
  const symbol = visualState === 'failed' ? '!' : visualState === 'paid' || visualState === 'accepted' ? '✓' : visualState === 'expired' || visualState === 'cancelled' ? '×' : '•';
  return (
    <span className={`order-status order-status-${visualState}`}>
      <span aria-hidden="true">{symbol}</span>
      {orderStatusLabel(order.status, order.paymentState)}
    </span>
  );
}

export function OrderDetails({ order }: { order: BuyerOrder }) {
  return (
    <div className="order-detail">
      <section className="order-detail-items" aria-label="Purchased items">
        <p className="order-detail-label">Purchased items</p>
        <div className="order-items">
          {order.items.map((item) => (
            <article className="order-item" key={item.productId}>
              <div className="order-item-thumb">
                {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span aria-hidden="true">{item.title.charAt(0).toUpperCase() || '◇'}</span>}
              </div>
              <div>
                <strong>{item.title}</strong>
                <span>{item.quantity} × {formatOrderMoney(item.unitPriceCents)}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <dl className="order-breakdown">
        <div><dt>Subtotal</dt><dd>{formatOrderMoney(order.subtotalCents)}</dd></div>
        <div><dt>Shipping</dt><dd>{order.shippingCents > 0 ? formatOrderMoney(order.shippingCents) : 'Included'}</dd></div>
        <div><dt>Order total</dt><dd>{formatOrderMoney(order.totalCents)}</dd></div>
        <div><dt>Purchase state</dt><dd>{orderStatusLabel(order.status, order.paymentState)}</dd></div>
      </dl>

      {order.videoSnapshots.length > 0 ? (
        <nav className="order-moments" aria-label="Purchase moments">
          <p className="order-detail-label">From the live</p>
          <div>
            {order.videoSnapshots.map((snapshot) => (
              <a className="order-moment-link" href={orderEventHref(snapshot.eventId)} key={snapshot.id}>
                <span className="order-moment-play" aria-hidden="true">▶</span>
                <span>
                  <strong>Watch purchase moment</strong>
                  <small>
                    {snapshot.productTitle}
                    {snapshot.startMs === undefined ? '' : ` · ${formatReplayTime(snapshot.startMs)}`}
                    {snapshot.evidenceKind === 'condition' ? ` · ${snapshot.evidenceLabel ?? 'Condition evidence'}` : ''}
                  </small>
                </span>
                <span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
        </nav>
      ) : null}
    </div>
  );
}

export function OrderHistory({
  orders,
  buyerId,
  onOpenOrder,
}: {
  orders: readonly BuyerOrder[];
  buyerId: string;
  onOpenOrder?: (orderId: string) => Promise<void>;
}) {
  const [expandedOrderKey, setExpandedOrderKey] = useState(() => orders[0] ? orderKey(orders[0]) : null);

  if (orders.length === 0) return <OrdersEmpty buyerId={buyerId} />;

  return (
    <ol className="orders-list" aria-label={`Orders for ${buyerId}`}>
      {orders.map((order) => {
        const key = orderKey(order);
        const detailId = `order-detail-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        const expanded = expandedOrderKey === key;
        const firstItem = order.items[0];
        return (
          <li className={`order-card${expanded ? ' is-expanded' : ''}`} key={key}>
            <article>
              <header className="order-card-summary-row">
                <div className="order-card-thumb">
                  {firstItem?.imageUrl ? <img src={firstItem.imageUrl} alt="" /> : <span aria-hidden="true">{orderHeadline(order).charAt(0).toUpperCase()}</span>}
                </div>
                <div className="order-card-title">
                  <div className="order-card-meta">
                    <StatusBadge order={order} />
                    <span>Order {order.id}</span>
                  </div>
                  <h2>{orderHeadline(order)}</h2>
                  <p>
                    {order.sellerName ? `${order.sellerName} · ` : ''}{order.eventTitle} · {orderSourceLabel(order.source)} · <time dateTime={order.createdAt}>{formatOrderDate(order.createdAt)}</time>
                  </p>
                </div>
                <div className="order-card-total">
                  <strong>{formatOrderMoney(order.totalCents)}</strong>
                  <small>{order.status === 'paid' ? 'Paid' : 'Order total'}</small>
                </div>
                {order.checkoutCapability ? (
                  <button
                    aria-label={`${checkoutActionLabel(order.checkoutCapability)} order ${order.id}`}
                    className="button primary"
                    type="button"
                    disabled={!onOpenOrder}
                    onClick={() => { if (onOpenOrder) void onOpenOrder(order.checkoutCapability!.orderId); }}
                  >
                    {checkoutActionLabel(order.checkoutCapability)}
                  </button>
                ) : (
                  <a className="button secondary" href={orderEventHref(order.eventId)}>
                    {orderActionLabel(order)}
                  </a>
                )}
                <button
                  className="order-expand-button"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  onClick={() => setExpandedOrderKey(expanded ? null : key)}
                >
                  {expanded ? 'Hide details' : 'Order details'}
                  <span aria-hidden="true">⌄</span>
                </button>
              </header>
              {expanded ? <div id={detailId}><OrderDetails order={order} /></div> : null}
            </article>
          </li>
        );
      })}
    </ol>
  );
}

export function OrdersWorkspace({
  orders,
  buyerId,
  refreshing = false,
  onOpenOrder,
}: {
  orders: readonly BuyerOrder[];
  buyerId: string;
  refreshing?: boolean;
  onOpenOrder?: (orderId: string) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [sort, setSort] = useState<OrderSort>('newest');
  const visibleOrders = useMemo(
    () => filterAndSortOrders(orders, search, filter, sort),
    [filter, orders, search, sort],
  );
  const hasActiveQuery = search.trim().length > 0 || filter !== 'all';

  return (
    <div className="orders-workspace" aria-busy={refreshing}>
      <OrderMetrics orders={orders} />

      {orders.length > 0 ? (
        <section className="orders-toolbar" aria-label="Order controls">
          <label className="orders-search">
            <span className="orders-visually-hidden">Search orders</span>
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search item, event, or order ID"
              aria-label="Search orders"
            />
          </label>
          <div className="orders-filter-list" role="group" aria-label="Filter orders by status">
            {FILTERS.map((item) => (
              <button
                type="button"
                className={filter === item.id ? 'is-active' : undefined}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
                key={item.id}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="orders-sort">
            <span className="orders-visually-hidden">Sort orders</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as OrderSort)} aria-label="Sort orders">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="highest-total">Highest total</option>
            </select>
          </label>
        </section>
      ) : null}

      <p className="orders-live-status" role="status" aria-live="polite">
        {refreshing ? 'Refreshing orders…' : `Showing ${visibleOrders.length} of ${orders.length} orders`}
      </p>

      {visibleOrders.length > 0 ? (
        <OrderHistory orders={visibleOrders} buyerId={buyerId} onOpenOrder={onOpenOrder} />
      ) : hasActiveQuery ? (
        <section className="orders-empty orders-empty-filtered">
          <p className="eyebrow">No matches</p>
          <h2>No orders match those filters</h2>
          <p>Try another item, event, order ID, or purchase state.</p>
          <button
            className="button secondary"
            type="button"
            onClick={() => { setSearch(''); setFilter('all'); }}
          >
            Clear filters
          </button>
        </section>
      ) : (
        <OrdersEmpty buyerId={buyerId} />
      )}
    </div>
  );
}

export function OrdersTab() {
  const { buyerId } = useBuyerIdentity();
  const buyerCheckout = useBuyerCheckout();
  const ordersQuery = useRestSyncQuery<BuyerOrder>({
    queryName: 'orders.byBuyer',
    args: { buyerId },
    staleTime: 0,
  });
  const orders = ordersQuery.data ?? [];
  const loading = ordersQuery.loading;
  const refreshing = ordersQuery.fetching;
  const error = ordersQuery.error;

  return (
    <section className="tab-layout density-roomy orders-page">
      <header className="orders-page-header">
        <div className="orders-page-heading">
          <p className="eyebrow">Purchase timeline</p>
          <h1>Your orders</h1>
          <p className="tab-copy">Everything you bought live, with its current purchase state and the moment that made it yours.</p>
          <p className="orders-buyer">Showing history for <strong>{buyerId}</strong></p>
        </div>
        <div className="orders-head-actions">
          <a className="button primary" href="/?tab=buyer">Continue shopping</a>
        </div>
      </header>

      {error ? (
        <section className="orders-error" role="alert">
          <span className="orders-error-mark" aria-hidden="true">!</span>
          <div>
            <strong>Orders could not be loaded.</strong>
            <span>{error.message}</span>
          </div>
          <button className="button secondary" type="button" onClick={ordersQuery.invalidate}>Try again</button>
        </section>
      ) : loading && orders.length === 0 ? (
        <section className="orders-loading" role="status" aria-live="polite">
          <span className="orders-loading-spinner" aria-hidden="true" />
          <span>Loading orders for {buyerId}…</span>
        </section>
      ) : (
        <OrdersWorkspace
          orders={orders}
          buyerId={buyerId}
          refreshing={refreshing}
          onOpenOrder={buyerCheckout?.openOrder}
        />
      )}
    </section>
  );
}
