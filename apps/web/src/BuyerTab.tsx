import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';

import {
  availableBuyerProducts,
  buildBuyerShareUrl,
  formatBuyerPrice,
  type BuyerProduct,
  type BuyerStats,
} from './buyer';
import { type CatalogPage, OFFLINE_FIXTURE, resolveApiBaseUrl, variantToBuyerProduct } from './catalog';
import { EventChat } from './EventChat';
import { DEFAULT_EVENT_ID, DEFAULT_EVENT_TITLE } from './event-identity';
import { streamLabel, useCopyState, useStreamSession } from './hooks';
import { AuctionPanel } from './AuctionPanel';
import { BuyerProductRail } from './BuyerProductRail';
import { connectViewer, createEventRoom, type ViewerSession } from './streaming';
import { EventThumbnail } from './event-creation/EventThumbnail';
import { isRenderableThumbnailUrl } from './event-creation/thumbnail';
import { fetchEventGuide, fetchEventThumbnailUrl, type GuideEvent } from './events/api';
import { ChannelGuide } from './events/ChannelGuide';
import { ReplayChapters } from './ReplayChapters';
import { DemoIdentityControl } from './BuyerIdentityControl';
import { type BuyerCheckoutActions, useBuyerCheckout } from './BuyerCheckout';
import { useDemoIdentity } from './buyer-identity';
import { VideoChatOverlay } from './VideoChatOverlay';
import './BuyerTab.css';

export interface BuyerTabProps {
  eventId?: string;
  eventTitle?: string;
  products?: readonly BuyerProduct[];
  stats?: BuyerStats;
  mediaBaseUrl?: string;
  origin?: string;
  /** Supplied by tests/embeds; otherwise read from the event config. */
  thumbnailUrl?: string;
  /**
   * Switch the active event (P-118 / D-019). The buyer tab owns the Channel
   * Guide, but not which event the app is showing — that lives above it so the
   * URL and every other surface stay in step.
   */
  onEventChange?: (eventId: string) => void;
  /** Supplied by tests; otherwise fetched from GET /events. */
  guideEvents?: readonly GuideEvent[];
}

const EMPTY_BUYER_STATS: BuyerStats = { viewers: 0, itemsSold: 0, totalRaisedCents: 0 };
export const BUYER_PRODUCT_PREVIEW_LIMIT = 3;
type BuyerMode = 'shop' | 'chat';

export function buyerStatsFromSyncRows(rows?: readonly BuyerStats[]): BuyerStats | null {
  return rows?.[0] ?? null;
}

export function buyerProductsFromSyncRows(
  rows: readonly CatalogPage[] | undefined,
  offline: boolean,
): BuyerProduct[] {
  const variants = offline ? OFFLINE_FIXTURE : rows?.[0]?.rows ?? [];
  return variants.map(variantToBuyerProduct);
}

export async function openOrHoldBuyerProduct(
  product: BuyerProduct,
  checkout: BuyerCheckoutActions,
): Promise<'opened' | 'held'> {
  if (checkout.heldProductIds.includes(product.id)) {
    checkout.openHeldItems();
    return 'opened';
  }
  await checkout.holdProduct(product);
  return 'held';
}

export function BuyerTab({
  eventId = DEFAULT_EVENT_ID,
  eventTitle = DEFAULT_EVENT_TITLE,
  products: productsProp,
  stats: statsProp,
  mediaBaseUrl,
  origin,
  thumbnailUrl: thumbnailUrlProp,
  onEventChange,
  guideEvents: guideEventsProp,
}: BuyerTabProps) {
  /* ── Channel Guide (P-118 / D-019) ──────────────────────────────────────
     The directory is loaded ONCE for the tab, not per drawer-open: the button
     shows a live-room count, so the data has to exist before the buyer opens
     anything. It is refreshed on event switch so viewer counts and the
     live/ended split do not go stale while the drawer sits closed. */
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideEvents, setGuideEvents] = useState<readonly GuideEvent[]>(guideEventsProp ?? []);
  const [guideLoading, setGuideLoading] = useState(!guideEventsProp);
  const [guideError, setGuideError] = useState<string | null>(null);

  useEffect(() => {
    if (guideEventsProp) return;
    let cancelled = false;
    setGuideLoading(true);
    fetchEventGuide()
      .then((list) => {
        if (cancelled) return;
        setGuideEvents(list);
        setGuideError(null);
      })
      .catch(() => {
        // Say we could not ask, rather than rendering an empty guide that
        // claims nothing is on.
        if (!cancelled) setGuideError('Could not load the event guide.');
      })
      .finally(() => {
        if (!cancelled) setGuideLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guideEventsProp, eventId]);

  const liveEventCount = useMemo(
    () => guideEvents.filter((event) => event.status === 'live').length,
    [guideEvents],
  );

  // The guide is the authority on an event's title once loaded: an event
  // reached from the guide has no config fetch behind it yet, and falling back
  // to the caller's title would label every room "Sunday vintage drop".
  const activeGuideEvent = useMemo(
    () => guideEvents.find((event) => event.eventId === eventId) ?? null,
    [guideEvents, eventId],
  );
  const resolvedTitle = activeGuideEvent?.title ?? eventTitle;

  const selectEvent = (nextEventId: string) => {
    setGuideOpen(false);
    if (nextEventId !== eventId) onEventChange?.(nextEventId);
  };
  // Live stats (P-111 — no dummy data): real presence + paid orders through
  // the app-wide sync transport, with polling retained as its fallback mode.
  const statsQuery = useSyncQuery<BuyerStats>({
    queryName: 'event.stats',
    args: { eventId },
    enabled: !statsProp,
    pollIntervalMs: 15_000,
  });
  const stats = statsProp ?? buyerStatsFromSyncRows(statsQuery.data) ?? EMPTY_BUYER_STATS;
  // The event's product rail comes from the ONE catalog source (P-102): the
  // API read model when reachable, the shared offline fixture otherwise.
  const catalogQuery = useSyncQuery<CatalogPage>({
    queryName: 'catalog.page',
    args: { availability: 'in-stock', pageSize: 6 },
    enabled: !productsProp,
    pollIntervalMs: 10_000,
  });
  const catalogProducts = useMemo(
    () => buyerProductsFromSyncRows(catalogQuery.data, Boolean(catalogQuery.error)),
    [catalogQuery.data, catalogQuery.error],
  );
  const products = productsProp ?? catalogProducts;
  // The event thumbnail (P-014). Read once per event — it changes only when the
  // seller re-uploads, so it does not share the stats poll.
  const [fetchedThumbnailUrl, setFetchedThumbnailUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (thumbnailUrlProp) return;
    let cancelled = false;
    void fetchEventThumbnailUrl(eventId).then((url) => {
      if (!cancelled) setFetchedThumbnailUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [eventId, thumbnailUrlProp]);
  const thumbnailUrl = thumbnailUrlProp ?? fetchedThumbnailUrl;
  const room = useMemo(() => createEventRoom(eventId, origin), [eventId, origin]);
  const shareUrl = useMemo(() => buildBuyerShareUrl(eventId, origin), [eventId, origin]);
  const [holdNotice, setHoldNotice] = useState<string | null>(null);
  const [holdOverrides, setHoldOverrides] = useState<Record<string, number>>({});
  const [showAllProducts, setShowAllProducts] = useState(false);
  const [buyerMode, setBuyerMode] = useState<BuyerMode>('shop');
  const stream = useStreamSession<ViewerSession>();
  const { streamState, setStreamState, streamError, session, videoRef } = stream;
  const { copyState, copy } = useCopyState();
  // D-013: this is deliberately an auth-free demo identity. Every buyer-side
  // action consumes the same persisted id, and the Orders tab imports the same
  // hook rather than inventing a second notion of "current user".
  const { userId, impersonate } = useDemoIdentity('buyer');
  const buyerCheckout = useBuyerCheckout();
  const heldProductIds = buyerCheckout?.heldProductIds ?? [];
  const heldProductIdSet = useMemo(() => new Set(heldProductIds), [heldProductIds]);

  useEffect(() => {
    return () => stream.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- teardown per room change only
  }, [eventId]);

  useEffect(() => {
    setShowAllProducts(false);
    setBuyerMode('shop');
  }, [eventId]);

  const connectStream = () =>
    stream.start(
      () =>
        connectViewer({
          room,
          mediaBaseUrl,
          onTrack: (mediaStream) => {
            if (videoRef.current && videoRef.current.srcObject !== mediaStream) {
              videoRef.current.srcObject = mediaStream;
            }
            setStreamState('live');
            void videoRef.current?.play().catch(() => undefined);
          },
        }),
      {
        attach: (viewer) => viewer.stream,
        fallbackError: 'The stream could not be connected.',
      },
    );

  const disconnectStream = () => stream.stop();

  const copyShareUrl = () => void copy(shareUrl);

  /** A real reservation (P-103): the hold hits inventory and decrements availableQty. */
  const reserveProduct = async (product: BuyerProduct) => {
    if (product.availableQty <= 0 && !heldProductIdSet.has(product.id)) return;
    try {
      if (!buyerCheckout) throw new Error('Buyer checkout is unavailable');
      const outcome = await openOrHoldBuyerProduct(product, buyerCheckout);
      if (outcome === 'opened') return;
      setHoldNotice(`${product.title} is held for you.`);
      setHoldOverrides((current) => ({
        ...current,
        [product.id]: Math.max(0, (current[product.id] ?? product.availableQty) - 1),
      }));
      catalogQuery.invalidate?.();
    } catch (error) {
      if (error instanceof Error && /insufficient available quantity/i.test(error.message)) {
        setHoldNotice(`${product.title} just sold out.`);
        setHoldOverrides((current) => ({ ...current, [product.id]: 0 }));
        catalogQuery.invalidate?.();
        return;
      }
      setHoldNotice('The hold could not be placed — check your connection and try again.');
    }
  };

  const liveLabel = streamLabel(streamState);
  const productsWithLiveQuantity = useMemo(() => products.map((product) => {
    const liveQty = heldProductIdSet.has(product.id) ? holdOverrides[product.id] : undefined;
    return liveQty === undefined ? product : { ...product, availableQty: liveQty };
  }), [heldProductIdSet, holdOverrides, products]);
  const visibleProducts = availableBuyerProducts(productsWithLiveQuantity);
  const currentProduct = visibleProducts[0] ?? productsWithLiveQuantity[0] ?? null;
  const upcomingProducts = currentProduct
    ? productsWithLiveQuantity.filter((product) => product.id !== currentProduct.id)
    : productsWithLiveQuantity;
  const displayedProducts = showAllProducts
    ? productsWithLiveQuantity
    : upcomingProducts.slice(0, BUYER_PRODUCT_PREVIEW_LIMIT);

  return (
    <section className="buyer-tab density-roomy" id="buyer" aria-labelledby="buyer-title">
      <header className="buyer-room-header">
        <div className="buyer-room-title">
          <EventThumbnail url={thumbnailUrl} eventName={resolvedTitle} className="buyer-event-thumbnail" />
          <div>
            <div className="buyer-room-status-line">
              <span className={`buyer-live-state buyer-live-state-${streamState}`}>
                <span aria-hidden="true" /> {liveLabel}
              </span>
              <span>{stats.viewers} watching</span>
            </div>
            <h2 id="buyer-title">{resolvedTitle}</h2>
            <div className="buyer-room-meta" aria-label="Event stats">
              <span><strong>{stats.itemsSold}</strong> items sold</span>
              <span><strong>{formatBuyerPrice(stats.totalRaisedCents)}</strong> raised</span>
              <span>Hosted live on SideStage</span>
            </div>
          </div>
        </div>
        <div className="buyer-room-actions">
          <button
            className="whats-on-button"
            type="button"
            onClick={() => setGuideOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={guideOpen}
          >
            What&rsquo;s on
            {liveEventCount > 0 ? <span className="whats-on-count">{liveEventCount}</span> : null}
          </button>
          <button className="button secondary" type="button" onClick={copyShareUrl}>
            {copyState === 'copied' ? 'Link copied' : copyState === 'failed' ? 'Copy failed' : 'Share room'}
          </button>
          {buyerCheckout ? (
            <button className="button secondary buyer-held-items-button" type="button" onClick={buyerCheckout.openHeldItems}>
              Held items <span aria-label={`${buyerCheckout.heldItemCount} held items`}>{buyerCheckout.heldItemCount}</span>
            </button>
          ) : null}
          <div className="buyer-account-control">
            <DemoIdentityControl
              userId={userId}
              onImpersonate={impersonate}
              inputId="buyer-demo-user-id"
            />
          </div>
        </div>
      </header>

      <ChannelGuide
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        events={guideEvents}
        currentEventId={eventId}
        onSelect={selectEvent}
        loading={guideLoading}
        error={guideError}
      />

      <section className="buyer-stage-grid" aria-label="Live video and current offer">
        <div className="buyer-player-card">
          <video
            ref={videoRef}
            className="buyer-player"
            controls
            playsInline
            poster={isRenderableThumbnailUrl(thumbnailUrl) ? thumbnailUrl : undefined}
            aria-label={`${resolvedTitle} stream`}
          />
          <div className="buyer-player-overlay">
            <span className="live-badge">{room.eventId}</span>
            <p>{streamState === 'error' ? streamError : 'The seller stream appears here when the room is live.'}</p>
            {session ? (
              <button className="button secondary" type="button" onClick={disconnectStream}>Disconnect</button>
            ) : (
              <button className="button primary" type="button" onClick={() => void connectStream()} disabled={streamState === 'connecting'}>
                {streamState === 'connecting' ? 'Connecting…' : 'Connect to stream'}
              </button>
            )}
          </div>
          <VideoChatOverlay
            className="buyer-video-chat-overlay"
            open={buyerMode === 'chat'}
            onOpenChange={(open) => setBuyerMode(open ? 'chat' : 'shop')}
          >
            <div aria-label="Event chat">
              <EventChat
                eventId={eventId}
                role="buyer"
                userId={userId}
                displayName={userId}
                eventTitle={resolvedTitle}
                apiBaseUrl={resolveApiBaseUrl()}
              />
              <p className="buyer-share-note">
                Share this room: <button type="button" onClick={copyShareUrl}>{shareUrl}</button>
              </p>
            </div>
          </VideoChatOverlay>
        </div>

        <article
          className="buyer-current-offer"
          aria-labelledby="buyer-current-offer-title"
          data-current-product-id={currentProduct?.id}
        >
          <div className="buyer-current-offer-heading">
            <div>
              <p className="eyebrow">Now selling</p>
              <h3 id="buyer-current-offer-title">{currentProduct?.title ?? 'The next item is almost ready'}</h3>
            </div>
            {currentProduct ? (
              <span className={`buyer-offer-stock${currentProduct.availableQty <= 0 ? ' is-sold-out' : ''}`} role="status" aria-live="polite">
                {currentProduct.availableQty > 0 ? `${currentProduct.availableQty} left` : 'Sold out'}
              </span>
            ) : null}
          </div>
          <div className="buyer-current-offer-art">
            {currentProduct?.imageUrl ? (
              <img src={currentProduct.imageUrl} alt={currentProduct.title} width="640" height="480" />
            ) : (
              <span aria-hidden="true">{currentProduct?.title.slice(0, 1) ?? 'S'}</span>
            )}
          </div>
          {currentProduct ? (
            <>
              <div className="buyer-current-offer-price">
                <strong>{formatBuyerPrice(currentProduct.priceCents)}</strong>
                {currentProduct.compareAtPriceCents ? <del>{formatBuyerPrice(currentProduct.compareAtPriceCents)}</del> : null}
              </div>
              <p>{currentProduct.subtitle}</p>
              <button
                className="button primary buyer-current-offer-action"
                type="button"
                disabled={currentProduct.availableQty <= 0 && !heldProductIdSet.has(currentProduct.id)}
                onClick={() => void reserveProduct(currentProduct)}
              >
                {heldProductIdSet.has(currentProduct.id)
                  ? 'Held for you'
                  : currentProduct.availableQty <= 0
                    ? 'Sold out'
                    : `Hold ${currentProduct.title} · ${formatBuyerPrice(currentProduct.priceCents)}`}
              </button>
              <div className="buyer-current-offer-trust">
                <span>2-minute hold</span><span>Secure checkout</span><span>Easy returns</span>
              </div>
            </>
          ) : (
            <p className="muted">Stay in the room—the offer updates when the seller brings an item on stage.</p>
          )}
        </article>
      </section>

      <div className="buyer-mode-switch" role="group" aria-label="Buyer mobile view">
        <button type="button" aria-pressed={buyerMode === 'shop'} onClick={() => setBuyerMode('shop')}>Shop</button>
        <button type="button" aria-pressed={buyerMode === 'chat'} onClick={() => setBuyerMode('chat')}>Chat</button>
      </div>

      <div className="buyer-lower-grid" data-buyer-mode={buyerMode}>
        <div className="buyer-shop-panel">
          <ReplayChapters eventId={eventId} videoRef={videoRef} apiBaseUrl={resolveApiBaseUrl()} />

          <AuctionPanel
            eventId={eventId}
            products={products}
            bidderId={userId}
            displayName={userId}
            apiBaseUrl={import.meta.env.VITE_API_URL}
          />

          <div className="buyer-products-heading">
            <div>
              <p className="eyebrow">Coming up</p>
              <h3>Next in the drop</h3>
            </div>
            <div className="buyer-products-heading-actions">
              <span className="muted">{visibleProducts.length} available</span>
              {upcomingProducts.length > BUYER_PRODUCT_PREVIEW_LIMIT ? (
                <button
                  className="button secondary buyer-products-toggle"
                  type="button"
                  aria-controls="buyer-event-products"
                  aria-expanded={showAllProducts}
                  onClick={() => setShowAllProducts((current) => !current)}
                >
                  {showAllProducts
                    ? `Show next ${BUYER_PRODUCT_PREVIEW_LIMIT}`
                    : `View all ${productsWithLiveQuantity.length} items`}
                </button>
              ) : null}
            </div>
          </div>
          {holdNotice && heldProductIds.length > 0 ? <p className="buyer-hold-notice" role="status">{holdNotice}</p> : null}
          <div id="buyer-event-products" className="buyer-products-shell" aria-label="Event products">
            <BuyerProductRail
              products={displayedProducts}
              heldProductIds={heldProductIds}
              onHold={reserveProduct}
            />
          </div>
        </div>

      </div>

      {currentProduct ? (
        <div className="buyer-mobile-action" aria-label="Current offer">
          <div><strong>{currentProduct.title}</strong><span>{formatBuyerPrice(currentProduct.priceCents)} · {currentProduct.availableQty} left</span></div>
          <button
            className="button primary"
            type="button"
            disabled={currentProduct.availableQty <= 0 && !heldProductIdSet.has(currentProduct.id)}
            onClick={() => void reserveProduct(currentProduct)}
          >
            {heldProductIdSet.has(currentProduct.id) ? 'Held for you' : 'Hold item'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
