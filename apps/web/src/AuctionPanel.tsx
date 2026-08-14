import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { BuyerProduct } from './buyer';
import { formatBuyerPrice } from './buyer';
import {
  auctionStreamUrl,
  fetchActiveAuction,
  parseAuctionEvent,
  parseBidDollars,
  placeAuctionBid,
  secondsRemaining,
  suggestedBidCents,
  type AuctionStatus,
  type BuyerAuction,
} from './auction';
import './auction.css';

export interface AuctionPanelProps {
  eventId: string;
  products?: readonly Pick<BuyerProduct, 'id' | 'title' | 'subtitle'>[];
  bidderId?: string;
  displayName?: string;
  apiBaseUrl?: string;
  initialAuction?: BuyerAuction | null;
}

type SyncState = 'connecting' | 'live' | 'reconnecting' | 'polling';

/** Countdown ring geometry — r=44 inside a 100x100 viewBox. */
const RING_RADIUS = 44;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** How many bids the feed shows before it starts dropping the oldest. */
const FEED_LENGTH = 4;

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The closing call, derived from the real server clock — never invented.
 * Absolute thresholds (not a fraction of the total) because urgency is felt
 * in seconds, and an auction here can be extended by a late bid.
 */
function closingCall(status: AuctionStatus | undefined, remaining: number): 'once' | 'twice' | null {
  if (status !== 'active' || remaining <= 0) return null;
  if (remaining <= 2) return 'twice';
  if (remaining <= 5) return 'once';
  return null;
}

function urgencyOf(remaining: number): 'calm' | 'soon' | 'critical' {
  if (remaining <= 10) return 'critical';
  if (remaining <= 30) return 'soon';
  return 'calm';
}

export function AuctionPanel({
  eventId,
  products = [],
  bidderId = 'buyer-demo',
  displayName = 'You',
  apiBaseUrl,
  initialAuction,
}: AuctionPanelProps) {
  const [auction, setAuction] = useState<BuyerAuction | null>(initialAuction ?? null);
  const [loading, setLoading] = useState(initialAuction === undefined);
  const [syncState, setSyncState] = useState<SyncState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [bidDraft, setBidDraft] = useState(() => initialAuction ? (suggestedBidCents(initialAuction.currentPriceCents) / 100).toFixed(2) : '');
  const [submitting, setSubmitting] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const next = await fetchActiveAuction(eventId, apiBaseUrl);
      setAuction(next);
      setError(null);
      if (next) setBidDraft((suggestedBidCents(next.currentPriceCents) / 100).toFixed(2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The live auction could not be refreshed.');
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, eventId]);

  useEffect(() => {
    void refresh();
    if (typeof EventSource === 'undefined') {
      setSyncState('polling');
      const poll = globalThis.setInterval(() => void refresh(), 2_000);
      return () => globalThis.clearInterval(poll);
    }
    const source = new EventSource(auctionStreamUrl(eventId, apiBaseUrl));
    source.onopen = () => setSyncState('live');
    source.onerror = () => setSyncState('reconnecting');
    const onAuction = (event: Event) => {
      const next = parseAuctionEvent((event as MessageEvent<string>).data);
      if (next === undefined) return void refresh();
      setAuction(next);
      setLoading(false);
      setError(null);
      if (next) setBidDraft((suggestedBidCents(next.currentPriceCents) / 100).toFixed(2));
    };
    source.addEventListener('auction', onAuction);
    return () => {
      source.removeEventListener('auction', onAuction);
      source.close();
    };
  }, [apiBaseUrl, eventId, refresh]);

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 250);
    return () => globalThis.clearInterval(timer);
  }, []);

  const remaining = auction ? secondsRemaining(auction.endsAt, nowMs) : 0;
  useEffect(() => {
    if (auction?.status === 'active' && remaining === 0) void refresh();
  }, [auction?.id, auction?.status, refresh, remaining]);

  const product = useMemo(() => products.find((candidate) => candidate.id === auction?.productId), [auction?.productId, products]);
  const leadingBid = auction?.bids[0];
  const isLeading = leadingBid?.bidderId === bidderId;
  const parsedBid = parseBidDollars(bidDraft);
  const canBid = Boolean(auction && auction.status === 'active' && remaining > 0 && parsedBid !== null && parsedBid > auction.currentPriceCents && !submitting);

  // The ring is drawn against the auction's OWN duration, which moves when a
  // late bid extends endsAt — so it is recomputed rather than pinned at start.
  const totalSeconds = auction
    ? Math.max(1, Math.round((Date.parse(auction.endsAt) - Date.parse(auction.startedAt)) / 1_000))
    : 1;
  const remainingFraction = Math.min(1, Math.max(0, remaining / totalSeconds));
  const urgency = urgencyOf(remaining);
  const call = closingCall(auction?.status, remaining);
  const isClosed = auction?.status === 'closed';
  const recentBids = auction ? auction.bids.slice(0, FEED_LENGTH) : [];

  const submitBid = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!auction || !canBid || parsedBid === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const next = await placeAuctionBid(auction.id, { bidderId, displayName, amountCents: parsedBid }, apiBaseUrl);
      setAuction(next);
      setBidDraft((suggestedBidCents(next.currentPriceCents) / 100).toFixed(2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your bid could not be placed.');
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="auction-card" aria-labelledby="auction-title" aria-busy={loading}>
      <div className="auction-card-heading">
        <div>
          <p className="eyebrow">Live auction</p>
          <h3 id="auction-title">{product?.title ?? (auction ? auction.productId : 'Bid from the room')}</h3>
          <p className="muted">{product?.subtitle ?? 'The seller controls which item goes under the hammer.'}</p>
        </div>
        <span className={`auction-sync auction-sync-${syncState}`} aria-label={`Auction sync ${syncState}`}>
          <span aria-hidden="true" /> {syncState === 'live' ? 'Realtime' : syncState === 'polling' ? 'Polling' : 'Reconnecting'}
        </span>
      </div>

      {loading ? <p className="auction-empty">Checking the auction stage…</p> : null}
      {!loading && !auction ? (
        <div className="auction-empty"><strong>No auction is live yet.</strong><span>Stay here—the panel updates as soon as the seller starts one.</span></div>
      ) : null}

      {auction ? (
        <>
          <div className={`auction-stage auction-stage-${urgency}${isClosed ? ' is-closed' : ''}`}>
            {/* The clock is a timer, not a live region: it ticks four times a
                second and would drown every other announcement. */}
            <div
              className="auction-clock"
              role="timer"
              aria-live="off"
              aria-label={isClosed ? 'Auction closed' : `${Math.max(0, Math.ceil(remaining))} seconds left`}
            >
              <svg className="auction-ring" viewBox="0 0 100 100" aria-hidden="true">
                <circle className="auction-ring-track" cx="50" cy="50" r={RING_RADIUS} />
                <circle
                  className="auction-ring-arc"
                  cx="50"
                  cy="50"
                  r={RING_RADIUS}
                  strokeDasharray={RING_CIRCUMFERENCE.toFixed(2)}
                  strokeDashoffset={(RING_CIRCUMFERENCE * (1 - remainingFraction)).toFixed(2)}
                />
              </svg>
              <span className="auction-clock-face" aria-hidden="true">
                <strong>{isClosed ? '—' : formatCountdown(remaining)}</strong>
                <small>{isClosed ? 'closed' : 'left'}</small>
              </span>
            </div>

            <div className="auction-headline" aria-live="polite">
              <span className="auction-price-label">Current bid</span>
              <strong className="auction-price">{formatBuyerPrice(auction.currentPriceCents)}</strong>
              <span className={`auction-call${call ? ` is-${call}` : ''}${isClosed ? ' is-sold' : ''}`}>
                {isClosed
                  ? 'Sold'
                  : call === 'twice'
                    ? 'Going twice'
                    : call === 'once'
                      ? 'Going once'
                      : `${auction.bids.length} ${auction.bids.length === 1 ? 'bid' : 'bids'}`}
              </span>
            </div>

            {/* Every bid here was already in hand — the panel used to render
                bids[0] and discard the rest. */}
            <div className="auction-feed" aria-label="Recent bids">
              <span className="auction-feed-label">Bids</span>
              {recentBids.length === 0 ? (
                <p className="auction-feed-empty">No bids yet</p>
              ) : (
                <ol className="auction-feed-list">
                  {recentBids.map((entry, index) => (
                    <li
                      key={entry.id}
                      className={`auction-feed-row${index === 0 ? (isClosed ? ' is-won' : ' is-leading') : ''}`}
                    >
                      <span className="auction-feed-who">{entry.displayName ?? entry.bidderId}</span>
                      <b>{formatBuyerPrice(entry.amountCents)}</b>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
          <div className={`auction-leader${isLeading ? ' is-you' : ''}`}>
            {auction.status === 'closed'
              ? auction.winnerOrder?.bidderId === bidderId
                ? 'You won—your item is ready for checkout.'
                : leadingBid ? `${leadingBid.displayName ?? 'A buyer'} won at ${formatBuyerPrice(leadingBid.amountCents)}.` : 'The auction closed without a bid.'
              : isLeading
                ? `You’re leading at ${formatBuyerPrice(leadingBid.amountCents)}.`
                : leadingBid ? `${leadingBid.displayName ?? 'A buyer'} leads at ${formatBuyerPrice(leadingBid.amountCents)}.` : `Opening bid is ${formatBuyerPrice(auction.startingPriceCents)}.`}
          </div>
          <form className="auction-bid-form" onSubmit={(event) => void submitBid(event)}>
            <label htmlFor={`auction-bid-${auction.id}`}>Your bid</label>
            <div className="auction-bid-row">
              <span aria-hidden="true">$</span>
              <input
                id={`auction-bid-${auction.id}`}
                inputMode="decimal"
                value={bidDraft}
                onChange={(event) => setBidDraft(event.target.value)}
                disabled={auction.status !== 'active' || remaining === 0 || submitting}
                aria-describedby={`auction-bid-help-${auction.id}`}
              />
              <button className="button primary" type="submit" disabled={!canBid}>{submitting ? 'Placing…' : 'Place bid'}</button>
            </div>
            <small id={`auction-bid-help-${auction.id}`}>Bid more than {formatBuyerPrice(auction.currentPriceCents)}. The latest accepted bid syncs to every buyer.</small>
          </form>
          {/* Decorative — the leader line above already announces the result. */}
          {isClosed && leadingBid ? <span className="auction-stamp" aria-hidden="true">SOLD</span> : null}
        </>
      ) : null}
      {error ? <p className="auction-error" role="alert">{error}</p> : null}
    </section>
  );
}
