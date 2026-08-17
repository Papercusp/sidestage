import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useSyncMutate, useSyncQuery } from '@papercusp/sync';
import type { BuyerProduct } from './buyer';
import { formatBuyerPrice } from './buyer';
import {
  auctionBidErrorMessage,
  getAuctionGuestSession,
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
  /** Rendered in this same authoritative slot when no auction is active. */
  idleContent?: ReactNode;
  className?: string;
}

type SyncState = 'connecting' | 'live' | 'reconnecting' | 'polling';

interface PlaceBidMutation {
  auctionId: string;
  bid: { displayName?: string; amountCents: number; idempotencyKey: string };
}

interface OptimisticAuctionOverlay {
  requestKey: string;
  auction: BuyerAuction;
  /** Present only while the local-only bid is waiting for the server. */
  optimisticBidId?: string;
}

function requestKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `bid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function activeAuctionFromSyncRows(rows?: readonly BuyerAuction[]): BuyerAuction | null {
  return rows?.[0] ?? null;
}

/** Countdown ring geometry — r=44 inside a 100x100 viewBox. */
const RING_RADIUS = 44;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** How many bids the feed shows before it starts dropping the oldest. */
const FEED_LENGTH = 4;

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The auction's phase, from the two authorities that actually hold it.
 *
 * The CLOCK is authoritative for "bidding is over": `endsAt` is already in
 * hand, so it needs no round-trip and cannot go stale. The SERVER is
 * authoritative only for the OUTCOME — who won, at what price.
 *
 * Splitting them that way is what keeps a dropped stream from ever rendering a
 * live-looking panel past `endsAt`. Deriving closedness from `status` alone
 * left a window where the clock had run out but the snapshot still said
 * 'active', and the panel showed "0:00 left" beside a live bid count and a
 * present-tense "X leads" — a pre-close reading the clock already disproved.
 * The worst case now is 'settling' (over; winner not confirmed yet), which is
 * true rather than merely stale.
 */
export type AuctionPhase = 'live' | 'settling' | 'closed';

export function auctionPhase(status: AuctionStatus | undefined, remaining: number): AuctionPhase {
  if (status === 'closed') return 'closed';
  return remaining > 0 ? 'live' : 'settling';
}

/**
 * The closing call, derived from the real server clock — never invented.
 * Absolute thresholds (not a fraction of the total) because urgency is felt
 * in seconds, and an auction here can be extended by a late bid.
 */
function closingCall(phase: AuctionPhase, remaining: number): 'once' | 'twice' | null {
  if (phase !== 'live') return null;
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
  idleContent,
  className,
}: AuctionPanelProps) {
  const [bidDraft, setBidDraft] = useState('');
  const [bidError, setBidError] = useState<string | null>(null);
  const [bidNotice, setBidNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [viewerBidderId, setViewerBidderId] = useState<string | null>(null);
  const [optimisticAuction, setOptimisticAuction] = useState<OptimisticAuctionOverlay | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const suggestedFor = useRef('');
  const pendingBid = useRef<{ fingerprint: string; key: string } | null>(null);
  const leaderObservation = useRef<{
    auctionId: string;
    viewerBidderId: string;
    leaderBidderId: string | null;
  } | null>(null);

  const auctionQuery = useSyncQuery<BuyerAuction>({
    queryName: 'event.auction.active',
    args: { eventId },
    pollIntervalMs: 2_000,
    staleTime: 0,
  });
  const syncedAuction = activeAuctionFromSyncRows(auctionQuery.data);
  // The sender does not necessarily receive its own sync echo. Keep the local
  // result in front until the named query reaches (or passes) its price; a
  // higher snapshot means another buyer already moved the auction again.
  const optimisticIsAhead = Boolean(
    optimisticAuction
      && syncedAuction
      && syncedAuction.id === optimisticAuction.auction.id
      && syncedAuction.status === 'active'
      && syncedAuction.currentPriceCents < optimisticAuction.auction.currentPriceCents,
  );
  const auction = optimisticIsAhead ? optimisticAuction!.auction : syncedAuction;
  const loading = auctionQuery.loading;
  const syncState: SyncState = auctionQuery.loading
    ? 'connecting'
    : auctionQuery.error
      ? 'reconnecting'
      : auctionQuery.transport === 'POLLING'
        ? 'polling'
        : 'live';

  const placeBidFallback = useCallback(
    async ({ auctionId, bid }: PlaceBidMutation) => placeAuctionBid(auctionId, bid, apiBaseUrl),
    [apiBaseUrl],
  );
  const mutateBid = useSyncMutate<PlaceBidMutation, BuyerAuction>('auction.placeBid', placeBidFallback);

  useEffect(() => {
    if (!optimisticAuction || auctionQuery.data === undefined) return;
    if (
      !syncedAuction
      || syncedAuction.id !== optimisticAuction.auction.id
      || syncedAuction.status !== 'active'
      || syncedAuction.currentPriceCents >= optimisticAuction.auction.currentPriceCents
    ) {
      setOptimisticAuction(null);
    }
  }, [auctionQuery.data, optimisticAuction, syncedAuction]);

  useEffect(() => {
    let active = true;
    void getAuctionGuestSession(apiBaseUrl).then(
      (session) => { if (active) setViewerBidderId(session.bidderId); },
      () => undefined,
    );
    return () => { active = false; };
  }, [apiBaseUrl]);

  useEffect(() => {
    const quoteKey = auction ? `${auction.id}:${auction.currentPriceCents}` : '';
    if (auction && quoteKey !== suggestedFor.current) {
      suggestedFor.current = quoteKey;
      setBidDraft((suggestedBidCents(auction.currentPriceCents) / 100).toFixed(2));
    }
  }, [auction]);

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNowMs(Date.now()), 250);
    return () => globalThis.clearInterval(timer);
  }, []);

  const remaining = auction ? secondsRemaining(auction.endsAt, nowMs) : 0;
  const phase = auctionPhase(auction?.status, remaining);

  // Entering `settling` asks for the outcome we don't have yet — it never
  // re-checks one we do. The 2s `pollIntervalMs` below already carries the
  // result on its own; this only shortens the wait for it.
  useEffect(() => {
    if (!auction || phase !== 'settling') return;
    auctionQuery.invalidate();
  }, [auction, auctionQuery.invalidate, phase]);

  const product = useMemo(() => products.find((candidate) => candidate.id === auction?.productId), [auction?.productId, products]);
  const leadingBid = auction?.bids[0];
  const effectiveBidderId = viewerBidderId ?? auction?.viewerBidderId ?? bidderId;
  const isLeading = leadingBid?.bidderId === effectiveBidderId
    || leadingBid?.id === optimisticAuction?.optimisticBidId;
  const parsedBid = parseBidDollars(bidDraft);
  const canBid = Boolean(auction && phase === 'live' && parsedBid !== null && parsedBid > auction.currentPriceCents && !submitting);

  // The ring is drawn against the auction's OWN duration, which moves when a
  // late bid extends endsAt — so it is recomputed rather than pinned at start.
  const totalSeconds = auction
    ? Math.max(1, Math.round((Date.parse(auction.endsAt) - Date.parse(auction.startedAt)) / 1_000))
    : 1;
  const remainingFraction = Math.min(1, Math.max(0, remaining / totalSeconds));
  const urgency = urgencyOf(remaining);
  const call = closingCall(phase, remaining);
  const isClosed = phase === 'closed';
  const isSettling = phase === 'settling';
  const recentBids = auction ? auction.bids.slice(0, FEED_LENGTH) : [];
  const bidHelp = isClosed
    ? 'This auction is closed. Bidding is unavailable.'
    : isSettling
      ? 'Bidding has ended. The winner is being confirmed from the server.'
      : submitting
        ? 'Your bid is being submitted with a retry-safe request key.'
        : `Bid more than ${formatBuyerPrice(auction?.currentPriceCents ?? 0)}. The latest accepted bid syncs to every buyer.`;

  useEffect(() => {
    // Outbid announcements follow only authoritative snapshots. A rejected
    // optimistic bid must roll back to the prior leader without claiming the
    // viewer was outbid.
    if (!syncedAuction) {
      leaderObservation.current = null;
      return;
    }
    const syncedLeadingBid = syncedAuction.bids[0];
    const current = {
      auctionId: syncedAuction.id,
      viewerBidderId: effectiveBidderId,
      leaderBidderId: syncedLeadingBid?.bidderId ?? null,
    };
    const previous = leaderObservation.current;
    leaderObservation.current = current;
    if (
      phase === 'live'
      && previous?.auctionId === current.auctionId
      && previous.viewerBidderId === current.viewerBidderId
      && previous.leaderBidderId === current.viewerBidderId
      && current.leaderBidderId !== null
      && current.leaderBidderId !== current.viewerBidderId
    ) {
      setBidNotice(`You were outbid. The current bid is ${formatBuyerPrice(syncedAuction.currentPriceCents)}.`);
    }
  }, [effectiveBidderId, phase, syncedAuction]);

  const submitBid = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!auction || !canBid || parsedBid === null) return;
    setSubmitting(true);
    setBidError(null);
    setBidNotice(null);
    const fingerprint = `${auction.id}:${parsedBid}`;
    if (pendingBid.current?.fingerprint !== fingerprint) {
      pendingBid.current = { fingerprint, key: requestKey() };
    }
    const requestKeyForBid = pendingBid.current.key;
    const optimisticBidId = `optimistic-${requestKeyForBid}`;
    setOptimisticAuction({
      requestKey: requestKeyForBid,
      optimisticBidId,
      auction: {
        ...auction,
        currentPriceCents: parsedBid,
        bids: [{
          id: optimisticBidId,
          bidderId: effectiveBidderId,
          displayName,
          amountCents: parsedBid,
          createdAt: new Date().toISOString(),
        }, ...auction.bids],
      },
    });
    try {
      const updated = await mutateBid({
        auctionId: auction.id,
        bid: { displayName, amountCents: parsedBid, idempotencyKey: requestKeyForBid },
      });
      setViewerBidderId(updated.viewerBidderId ?? effectiveBidderId);
      // Replace the fabricated bid with the server-authored snapshot, but keep
      // displaying it until the submitting client's sync query catches up.
      setOptimisticAuction({ requestKey: requestKeyForBid, auction: updated });
      setBidNotice(`Your ${formatBuyerPrice(parsedBid)} bid was accepted and is syncing to the room.`);
      pendingBid.current = null;
      auctionQuery.invalidate();
    } catch (cause) {
      setOptimisticAuction((current) => current?.requestKey === requestKeyForBid ? null : current);
      setBidError(auctionBidErrorMessage(cause));
      auctionQuery.invalidate();
    } finally {
      setSubmitting(false);
    }
  };

  const showIdleContent = Boolean(idleContent && !loading && !auction && !auctionQuery.error);

  return (
    <section
      className={`auction-card${className ? ` ${className}` : ''}`}
      aria-labelledby={showIdleContent ? undefined : 'auction-title'}
      aria-label={showIdleContent ? 'Current offer' : undefined}
      aria-busy={loading}
      data-offer-state={showIdleContent ? 'idle' : phase}
    >
      {showIdleContent ? idleContent : (
        <>
          <div className="auction-card-heading">
        <div>
          <p className="eyebrow">Live auction</p>
          <h3 id="auction-title">{product?.title ?? (auction ? auction.productId : 'Bid from the room')}</h3>
          <p className="muted">{product?.subtitle ?? 'The seller controls which item goes under the hammer.'}</p>
        </div>
        {syncState !== 'polling' ? (
          <span className={`auction-sync auction-sync-${syncState}`} aria-label={`Auction sync ${syncState}`}>
            <span aria-hidden="true" /> {syncState === 'live' ? 'Realtime' : 'Reconnecting'}
          </span>
        ) : null}
          </div>

          {loading ? <p className="auction-empty">Checking the auction stage…</p> : null}
          {!loading && !auction && !auctionQuery.error ? (
            <div className="auction-empty"><strong>No auction is live yet.</strong><span>Stay here—the panel updates as soon as the seller starts one.</span></div>
          ) : null}

          {auction ? (
        <>
          <div className={`auction-stage auction-stage-${urgency}${isClosed ? ' is-closed' : ''}${isSettling ? ' is-settling' : ''}`}>
            {/* The clock is a timer, not a live region: it ticks four times a
                second and would drown every other announcement. */}
            <div
              className="auction-clock"
              role="timer"
              aria-live="off"
              aria-label={
                isClosed
                  ? 'Auction closed'
                  : isSettling
                    ? 'Bidding closed, confirming the result'
                    : `${Math.max(0, Math.ceil(remaining))} seconds left`
              }
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
                {/* "left" would be a lie at 0:00 — bidding has already ended,
                    only the result is outstanding. */}
                <small>{isClosed ? 'closed' : isSettling ? 'closing' : 'left'}</small>
              </span>
            </div>

            <div className="auction-headline" aria-live="polite">
              <span className="auction-price-label">Current bid</span>
              <strong className="auction-price">{formatBuyerPrice(auction.currentPriceCents)}</strong>
              <span className={`auction-call${call ? ` is-${call}` : ''}${isClosed ? ' is-sold' : ''}${isSettling ? ' is-settling' : ''}`}>
                {isClosed
                  ? 'Sold'
                  : isSettling
                    ? 'Confirming'
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
            {isClosed
              ? auction.winnerOrder?.bidderId === effectiveBidderId
                ? 'You won—your item is ready for checkout.'
                : leadingBid ? `${leadingBid.displayName ?? 'A buyer'} won at ${formatBuyerPrice(leadingBid.amountCents)}.` : 'The auction closed without a bid.'
              /* Past tense while settling: bidding is over, so "leads" would
                 invite a bid that can no longer be placed. The winner is not
                 announced until the server confirms it. */
              : isSettling
                ? leadingBid
                  ? `${isLeading ? 'You' : leadingBid.displayName ?? 'A buyer'} had the last bid at ${formatBuyerPrice(leadingBid.amountCents)}—confirming the result.`
                  : 'Bidding closed without a bid.'
                : isLeading && leadingBid
                  ? `You’re leading at ${formatBuyerPrice(leadingBid.amountCents)}.`
                  : leadingBid ? `${leadingBid.displayName ?? 'A buyer'} leads at ${formatBuyerPrice(leadingBid.amountCents)}.` : `Opening bid is ${formatBuyerPrice(auction.startingPriceCents)}.`}
          </div>
          {/* The bid form belongs to the LIVE state only. D-003 makes sold an
              additional STATE of this one module ("transform in place"), not the
              live layout with a stamp added on top — and the approved sold panel
              contains no bid affordance at all. Rendering it after close both
              contradicted that and cost 175px of slot height on mobile, which is
              most of the gap between the measured 813px and the approved 443px.
              Disabled inputs were not enough: a "Your bid / Place bid" form on a
              finished auction still reads as an action the buyer could take. */}
          {!isClosed ? (
          <form className="auction-bid-form" onSubmit={(event) => void submitBid(event)}>
            <label htmlFor={`auction-bid-${auction.id}`}>Your bid</label>
            <div className="auction-bid-row">
              <span aria-hidden="true">$</span>
              <input
                id={`auction-bid-${auction.id}`}
                inputMode="decimal"
                value={bidDraft}
                onChange={(event) => setBidDraft(event.target.value)}
                disabled={phase !== 'live' || submitting}
                aria-describedby={[
                  `auction-bid-help-${auction.id}`,
                  bidNotice ? `auction-bid-notice-${auction.id}` : '',
                  bidError ? `auction-bid-error-${auction.id}` : '',
                ].filter(Boolean).join(' ')}
              />
              <button className="button primary" type="submit" disabled={!canBid}>{submitting ? 'Placing…' : 'Place bid'}</button>
            </div>
            <small id={`auction-bid-help-${auction.id}`}>{bidHelp}</small>
          </form>
          ) : null}
          {bidNotice ? (
            <p id={`auction-bid-notice-${auction.id}`} className="auction-bid-status" role="status">
              {bidNotice}
            </p>
          ) : null}
          {/* Decorative — the leader line above already announces the result.
              The stamp lives inside a bounded visual in normal flow: as a bare
              absolutely-positioned span it centred itself on `.auction-card` and
              covered the bid feed. The approved mockup contains it in a
              `.sold-visual` block instead, so the result never occludes history. */}
          {isClosed && leadingBid ? (
            <div className="auction-sold-visual" aria-hidden="true">
              <span className="auction-stamp">SOLD</span>
            </div>
          ) : null}
        </>
          ) : null}
        </>
      )}
      {auctionQuery.error ? (
        <div className="auction-error" role="alert">
          <span>{auctionQuery.error.message}</span>
          <button className="button small" type="button" onClick={auctionQuery.invalidate}>Try again</button>
        </div>
      ) : null}
      {bidError ? <p id={auction ? `auction-bid-error-${auction.id}` : undefined} className="auction-error" role="alert">{bidError}</p> : null}
    </section>
  );
}
