import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import {
  availableBuyerProducts,
  buildBuyerShareUrl,
  DEMO_BUYER_CHAT,
  DEMO_BUYER_PRODUCTS,
  DEMO_BUYER_STATS,
  formatBuyerPrice,
  type BuyerChatMessage,
  type BuyerProduct,
  type BuyerStats,
} from './buyer';
import { connectViewer, createEventRoom, type ViewerSession } from './streaming';

export interface BuyerTabProps {
  eventId?: string;
  eventTitle?: string;
  products?: readonly BuyerProduct[];
  chatMessages?: readonly BuyerChatMessage[];
  stats?: BuyerStats;
  mediaBaseUrl?: string;
  origin?: string;
}

type StreamState = 'idle' | 'connecting' | 'live' | 'error';

const DEFAULT_EVENT_ID = 'sunday-drop';
const DEFAULT_EVENT_TITLE = 'Sunday vintage drop';

export function BuyerTab({
  eventId = DEFAULT_EVENT_ID,
  eventTitle = DEFAULT_EVENT_TITLE,
  products = DEMO_BUYER_PRODUCTS,
  chatMessages = DEMO_BUYER_CHAT,
  stats = DEMO_BUYER_STATS,
  mediaBaseUrl,
  origin,
}: BuyerTabProps) {
  const room = useMemo(() => createEventRoom(eventId, origin), [eventId, origin]);
  const shareUrl = useMemo(() => buildBuyerShareUrl(eventId, origin), [eventId, origin]);
  const [messages, setMessages] = useState<BuyerChatMessage[]>(() => [...chatMessages]);
  const [draftMessage, setDraftMessage] = useState('');
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [session, setSession] = useState<ViewerSession | null>(null);
  const sessionRef = useRef<ViewerSession | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setMessages([...chatMessages]);
  }, [chatMessages]);

  useEffect(() => {
    return () => {
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) void current.stop();
    };
  }, [eventId]);

  const connectStream = async () => {
    if (sessionRef.current || streamState === 'connecting') return;
    setStreamState('connecting');
    setStreamError(null);
    try {
      const nextSession = await connectViewer({
        room,
        mediaBaseUrl,
        onTrack: (stream) => {
          if (videoRef.current && videoRef.current.srcObject !== stream) {
            videoRef.current.srcObject = stream;
          }
          setStreamState('live');
          void videoRef.current?.play().catch(() => undefined);
        },
      });
      sessionRef.current = nextSession;
      setSession(nextSession);
      setStreamState('live');
      if (videoRef.current) videoRef.current.srcObject = nextSession.stream;
    } catch (error) {
      setStreamState('error');
      setStreamError(error instanceof Error ? error.message : 'The stream could not be connected.');
    }
  };

  const disconnectStream = () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setStreamState('idle');
    if (videoRef.current) videoRef.current.srcObject = null;
    if (current) void current.stop();
  };

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    globalThis.setTimeout(() => setCopyState('idle'), 1800);
  };

  const submitChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draftMessage.trim();
    if (!body) return;
    setMessages((current) => [
      ...current,
      {
        id: `chat-local-${current.length + 1}`,
        author: 'You',
        body,
        timestamp: 'now',
        accent: 'cyan',
      },
    ]);
    setDraftMessage('');
  };

  const reserveProduct = (product: BuyerProduct) => {
    if (product.availableQty <= 0) return;
    setSelectedProductId(product.id);
    setMessages((current) => [
      ...current,
      {
        id: `chat-product-${product.id}`,
        author: 'SideStage',
        body: `${product.title} is held for you in this demo.`,
        timestamp: 'now',
        accent: 'violet',
      },
    ]);
  };

  const liveLabel = streamState === 'live'
    ? 'Live now'
    : streamState === 'connecting'
      ? 'Connecting…'
      : streamState === 'error'
        ? 'Stream unavailable'
        : 'Preview ready';
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

          <div className="buyer-products-heading">
            <div>
              <p className="eyebrow">On stage now</p>
              <h3>Shop the drop</h3>
            </div>
            <span className="muted">{visibleProducts.length} available</span>
          </div>
          <div className="buyer-products" aria-label="Event products">
            {products.map((product) => {
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
                    <button className="button secondary" type="button" disabled={soldOut} onClick={() => reserveProduct(product)}>
                      {soldOut ? 'Sold out' : selectedProductId === product.id ? 'Held for you' : 'Hold item'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <aside className="buyer-chat-card" aria-label="Event chat">
          <div className="buyer-chat-heading">
            <div><p className="eyebrow">In the room</p><h3>Live chat</h3></div>
            <span className="connection-pill"><span className="connection-dot" /> {stats.viewers} buyers</span>
          </div>
          <div className="buyer-messages" aria-live="polite">
            {messages.map((message) => (
              <div className="buyer-message" key={message.id}>
                <span className={`buyer-avatar ${message.accent ?? 'cyan'}`} aria-hidden="true">{message.author.slice(0, 1)}</span>
                <div><div className="buyer-message-meta"><strong>{message.author}</strong><span>{message.timestamp}</span></div><p>{message.body}</p></div>
              </div>
            ))}
          </div>
          <form className="buyer-chat-form" onSubmit={submitChat}>
            <label className="sr-only" htmlFor="buyer-message">Message the room</label>
            <input id="buyer-message" value={draftMessage} onChange={(event) => setDraftMessage(event.target.value)} placeholder="Say something…" maxLength={240} />
            <button className="button primary" type="submit" disabled={!draftMessage.trim()}>Send</button>
          </form>
          <p className="buyer-share-note">Share this room: <button type="button" onClick={copyShareUrl}>{shareUrl}</button></p>
        </aside>
      </div>
    </section>
  );
}
