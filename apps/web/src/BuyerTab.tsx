import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import {
  availableBuyerProducts,
  buildBuyerShareUrl,
  formatBuyerPrice,
  type BuyerProduct,
  type BuyerStats,
} from './buyer';
import { fetchCatalog, OFFLINE_FIXTURE, resolveApiBaseUrl, variantToBuyerProduct } from './catalog';
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

/** A stable per-browser buyer identity, so holds and chat survive reloads. */
function buyerSessionId(): string {
  if (typeof window === 'undefined') return 'buyer-server-render';
  const key = 'sidestage-buyer-id';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = `buyer-${crypto.randomUUID().slice(0, 8)}`;
  window.localStorage.setItem(key, created);
  return created;
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
  // Live stats (P-111 — no dummy data): real presence + paid orders, polled.
  const [liveStats, setLiveStats] = useState<BuyerStats | null>(null);
  useEffect(() => {
    if (statsProp) return;
    let cancelled = false;
    const load = () => {
      fetch(`${resolveApiBaseUrl()}/events/${encodeURIComponent(eventId)}/stats`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as { viewers: number; itemsSold: number; totalRaisedCents: number };
          if (!cancelled) setLiveStats({ viewers: body.viewers, itemsSold: body.itemsSold, totalRaisedCents: body.totalRaisedCents });
        })
        .catch(() => {
          if (!cancelled) setLiveStats({ viewers: 0, itemsSold: 0, totalRaisedCents: 0 });
        });
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [eventId, statsProp]);
  const stats = statsProp ?? liveStats ?? { viewers: 0, itemsSold: 0, totalRaisedCents: 0 };
  // The event's product rail comes from the ONE catalog source (P-102): the
  // API read model when reachable, the shared offline fixture otherwise.
  const [catalogProducts, setCatalogProducts] = useState<readonly BuyerProduct[] | null>(null);
  useEffect(() => {
    if (productsProp) return;
    let cancelled = false;
    fetchCatalog({ availability: 'in-stock', pageSize: 6 })
      .then((page) => {
        if (!cancelled) setCatalogProducts(page.rows.map(variantToBuyerProduct));
      })
      .catch(() => {
        if (!cancelled) setCatalogProducts(OFFLINE_FIXTURE.map(variantToBuyerProduct));
      });
    return () => {
      cancelled = true;
    };
  }, [productsProp]);
  const products = productsProp ?? catalogProducts ?? [];
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
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [holdNotice, setHoldNotice] = useState<string | null>(null);
  const [holdOverrides, setHoldOverrides] = useState<Record<string, number>>({});
  const stream = useStreamSession<ViewerSession>();
  const { streamState, setStreamState, streamError, session, videoRef } = stream;
  const { copyState, copy } = useCopyState();
  const buyerId = useMemo(buyerSessionId, []);

  useEffect(() => {
    return () => stream.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- teardown per room change only
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
    if (product.availableQty <= 0) return;
    try {
      const response = await fetch(`${resolveApiBaseUrl()}/inventory/${encodeURIComponent(product.id)}/hold`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quantity: 1, sourceKind: 'cart', sourceId: buyerId }),
      });
      if (response.status === 409) {
        setHoldNotice(`${product.title} just sold out.`);
        setHoldOverrides((current) => ({ ...current, [product.id]: 0 }));
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = (await response.json()) as { snapshot?: { availableQty: number } };
      setSelectedProductId(product.id);
      setHoldNotice(`${product.title} is held for you.`);
      if (result.snapshot) {
        setHoldOverrides((current) => ({ ...current, [product.id]: result.snapshot!.availableQty }));
      }
    } catch {
      setHoldNotice('The hold could not be placed — check your connection and try again.');
    }
  };

  const liveLabel = streamLabel(streamState);
  const visibleProducts = availableBuyerProducts(products);

  return (
    <section className="buyer-tab density-roomy" id="buyer" aria-labelledby="buyer-title">
      <div className="buyer-heading">
        <div className="buyer-heading-identity">
          <EventThumbnail url={thumbnailUrl} eventName={resolvedTitle} className="buyer-event-thumbnail" />
          <div>
            <p className="eyebrow">Join the room</p>
            <h2 id="buyer-title">{resolvedTitle}</h2>
            <p className="muted">Watch together, ask questions, and keep the good finds moving.</p>
          </div>
        </div>
        <div className="buyer-heading-actions">
          {/* D-019: the "What's on" trigger. It carries the live-room count so
              the guide advertises what is happening without being opened. */}
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
          <span className={`buyer-live-state buyer-live-state-${streamState}`}>
            <span aria-hidden="true" /> {liveLabel}
          </span>
          <button className="button secondary" type="button" onClick={copyShareUrl}>
            {copyState === 'copied' ? 'Link copied' : copyState === 'failed' ? 'Copy failed' : 'Share event'}
          </button>
        </div>
      </div>

      <ChannelGuide
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        events={guideEvents}
        currentEventId={eventId}
        onSelect={selectEvent}
        loading={guideLoading}
        error={guideError}
      />

      <div className="buyer-layout">
        <div className="buyer-main-column">
          <div className="buyer-player-card">
            {/* The thumbnail doubles as the player poster, so the event has a
                face before the stream connects instead of a black rectangle.
                Guarded by the same allow-list as every other render: `poster`
                takes a URL, so an unvetted value does not belong here either. */}
            <video
              ref={videoRef}
              className="buyer-player"
              controls
              playsInline
              poster={isRenderableThumbnailUrl(thumbnailUrl) ? thumbnailUrl : undefined}
              aria-label={`${eventTitle} stream`}
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
          </div>

          <ReplayChapters eventId={eventId} videoRef={videoRef} apiBaseUrl={resolveApiBaseUrl()} />

          <div className="buyer-stats" aria-label="Event stats">
            <div><strong>{stats.viewers}</strong><span>watching</span></div>
            <div><strong>{stats.itemsSold}</strong><span>items sold</span></div>
            <div><strong>{formatBuyerPrice(stats.totalRaisedCents)}</strong><span>raised</span></div>
          </div>

          <AuctionPanel eventId={eventId} products={products} apiBaseUrl={import.meta.env.VITE_API_URL} />

          <div className="buyer-products-heading">
            <div>
              <p className="eyebrow">On stage now</p>
              <h3>Shop the drop</h3>
            </div>
            <span className="muted">{visibleProducts.length} available</span>
          </div>
          {holdNotice ? <p className="buyer-hold-notice" role="status">{holdNotice}</p> : null}
          <div aria-label="Event products">
            <BuyerProductRail
              products={products.map((product) => {
                const liveQty = holdOverrides[product.id];
                return liveQty === undefined ? product : { ...product, availableQty: liveQty };
              })}
              selectedProductId={selectedProductId}
              onHold={reserveProduct}
            />
          </div>
        </div>

        <aside className="buyer-chat-card" aria-label="Event chat">
          {/* The SAME chat the seller console uses (P-103) — the local demo
              chat this replaced never reached the room. */}
          <EventChat
            eventId={eventId}
            role="buyer"
            userId={buyerId}
            displayName="You"
            eventTitle={eventTitle}
            apiBaseUrl={resolveApiBaseUrl()}
          />
          <p className="buyer-share-note">Share this room: <button type="button" onClick={copyShareUrl}>{shareUrl}</button></p>
        </aside>
      </div>
    </section>
  );
}
