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

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
          <div className="auction-metrics" aria-live="polite">
            <div><span>Current bid</span><strong>{formatBuyerPrice(auction.currentPriceCents)}</strong></div>
            <div><span>Time left</span><strong>{auction.status === 'active' ? formatCountdown(remaining) : 'Closed'}</strong></div>
            <div><span>Bids</span><strong>{auction.bids.length}</strong></div>
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
        </>
      ) : null}
      {error ? <p className="auction-error" role="alert">{error}</p> : null}
    </section>
  );
}
