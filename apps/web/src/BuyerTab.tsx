import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import {
  availableBuyerProducts,
  buildBuyerShareUrl,
  DEMO_BUYER_STATS,
  formatBuyerPrice,
  type BuyerProduct,
  type BuyerStats,
} from './buyer';
import { fetchCatalog, OFFLINE_FIXTURE, resolveApiBaseUrl, variantToBuyerProduct } from './catalog';
import { EventChat } from './EventChat';
import { DEFAULT_EVENT_ID, DEFAULT_EVENT_TITLE } from './event-identity';
import { streamLabel, useCopyState, useStreamSession } from './hooks';
import { AuctionPanel } from './AuctionPanel';
import { connectViewer, createEventRoom, type ViewerSession } from './streaming';

export interface BuyerTabProps {
  eventId?: string;
  eventTitle?: string;
  products?: readonly BuyerProduct[];
  stats?: BuyerStats;
  mediaBaseUrl?: string;
  origin?: string;
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
  stats = DEMO_BUYER_STATS,
  mediaBaseUrl,
  origin,
}: BuyerTabProps) {
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
    <section className="buyer-tab" id="buyer" aria-labelledby="buyer-title">
      <div className="buyer-heading">
        <div>
          <p className="eyebrow">Join the room</p>
          <h2 id="buyer-title">{eventTitle}</h2>
          <p className="muted">Watch together, ask questions, and keep the good finds moving.</p>
        </div>
        <div className="buyer-heading-actions">
          <span className={`buyer-live-state buyer-live-state-${streamState}`}>
            <span aria-hidden="true" /> {liveLabel}
          </span>
          <button className="button secondary" type="button" onClick={copyShareUrl}>
            {copyState === 'copied' ? 'Link copied' : copyState === 'failed' ? 'Copy failed' : 'Share event'}
          </button>
        </div>
      </div>

      <div className="buyer-layout">
        <div className="buyer-main-column">
          <div className="buyer-player-card">
            <video ref={videoRef} className="buyer-player" controls playsInline aria-label={`${eventTitle} stream`} />
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
          <div className="buyer-products" aria-label="Event products">
            {products.map((rawProduct) => {
              const liveQty = holdOverrides[rawProduct.id];
              const product = liveQty === undefined ? rawProduct : { ...rawProduct, availableQty: liveQty };
              const soldOut = product.availableQty <= 0;
              return (
                <article className={`buyer-product-card${selectedProductId === product.id ? ' selected' : ''}`} key={product.id}>
                  <div className="buyer-product-art" aria-hidden="true">
                    {product.imageUrl ? <img src={product.imageUrl} alt="" /> : <span>{product.title.slice(0, 1)}</span>}
                    {product.badge ? <span className="buyer-product-badge">{product.badge}</span> : null}
                  </div>
                  <div className="buyer-product-copy">
                    <div>
                      <h4>{product.title}</h4>
                      <p className="muted">{product.subtitle}</p>
                    </div>
                    <div className="buyer-price-row">
                      <strong>{formatBuyerPrice(product.priceCents)}</strong>
                      {product.compareAtPriceCents ? <del>{formatBuyerPrice(product.compareAtPriceCents)}</del> : null}
                    </div>
                    <button className="button secondary" type="button" disabled={soldOut} onClick={() => void reserveProduct(product)}>
                      {soldOut ? 'Sold out' : selectedProductId === product.id ? 'Held for you' : 'Hold item'}
                    </button>
                  </div>
                </article>
              );
            })}
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
