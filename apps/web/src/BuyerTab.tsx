import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRestSyncQuery, useSyncQuery } from '@papercusp/sync';

import {
  availableBuyerProducts,
  formatBuyerPrice,
  type BuyerProduct,
  type BuyerStats,
} from './buyer';
import {
  resolveApiBaseUrl,
} from './catalog';
import { DEFAULT_EVENT_ID, DEFAULT_EVENT_TITLE } from './event-identity';
import { streamLabel, useStreamSession } from './hooks';
import { AuctionPanel } from './AuctionPanel';
import { BuyerProductRail } from './BuyerProductRail';
import { BuyerRoomContext, type BuyerRoomSeller } from './BuyerRoomContext';
import { connectViewer, createEventRoom, type ViewerSession } from './streaming';
import {
  isPublisherNotReady,
  publisherRetryDelayMs,
  PUBLISHER_ABSENT_MESSAGE,
  WAITING_FOR_PUBLISHER_MESSAGE,
} from './buyer-stream-recovery';
import { EventThumbnail } from './event-creation/EventThumbnail';
import type { GuideEvent } from './events/api';
import { type BuyerCheckoutActions, useBuyerCheckout } from './BuyerCheckout';
import { useDemoIdentity } from './buyer-identity';
import {
  nextTranscriptErrorState,
  remoteTranscriptPresentation,
  type EventTranscriptMoment,
} from './buyer-transcript-presentation';
import './BuyerTab.css';

const LazyVideoEngagementOverlay = lazy(() => import('./VideoEngagementOverlay')
  .then((module) => ({ default: module.VideoEngagementOverlay })));
const LazyEventChat = lazy(() => import('./EventChat')
  .then((module) => ({ default: module.EventChat })));

function DeferredBuyerEventChat({
  eventId,
  userId,
  eventTitle,
  apiBaseUrl,
}: {
  eventId: string;
  userId: string;
  eventTitle: string;
  apiBaseUrl: string;
}) {
  const [ready, setReady] = useState(false);
  const boundaryRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (ready || typeof IntersectionObserver === 'undefined') return undefined;
    const boundary = boundaryRef.current;
    if (!boundary) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.75)) {
        setReady(true);
      }
    }, { threshold: 0.75 });
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [ready]);

  const placeholder = (
    <section
      ref={boundaryRef}
      className="event-chat-audience buyer-chat-deferred"
      aria-label={`${eventTitle} audience chat`}
    >
      <button
        className="button secondary small"
        type="button"
        disabled={ready}
        onClick={() => setReady(true)}
      >
        {ready ? 'Loading live chat…' : 'Load live chat'}
      </button>
    </section>
  );

  if (!ready) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <LazyEventChat
        eventId={eventId}
        role="buyer"
        userId={userId}
        displayName={userId}
        eventTitle={eventTitle}
        surface="audience-overlay"
        apiBaseUrl={apiBaseUrl}
      />
    </Suspense>
  );
}

/**
 * How many times a stream that DIED after working may re-arm the publisher wait
 * (WI-39747). Each re-entry is itself bounded, so this only caps how many
 * separate losses are recovered from: enough for genuine network blips, few
 * enough that a room whose publisher drops instantly and forever terminates in
 * the honest "nobody is on camera" message instead of an endless spinner.
 */
const MAX_LOSS_RECONNECTS = 3;

export interface BuyerTabProps {
  eventId?: string;
  eventTitle?: string;
  products?: readonly BuyerProduct[];
  stats?: BuyerStats;
  mediaBaseUrl?: string;
  origin?: string;
  /** Supplied by tests/embeds; otherwise read from the event config. */
  thumbnailUrl?: string;
  /** Supplied by the shared app shell/tests; standalone embeds fetch GET /events. */
  guideEvents?: readonly GuideEvent[];
  /** Legacy embed option; Watch never falls back to demo products. */
  allowDemoData?: boolean;
}

const EMPTY_BUYER_STATS: BuyerStats = { viewers: 0, itemsSold: 0, totalRaisedCents: 0 };
const EMPTY_HOLD_OVERRIDES: Readonly<Record<string, number>> = Object.freeze({});
export const BUYER_PRODUCT_PREVIEW_LIMIT = 3;
export const BUYER_STREAM_CONNECTED_MESSAGE = 'Seller camera connected.';

/**
 * Keep the pre-connection paragraph stable from the first React commit through
 * the publisher retry window. Lighthouse records a text replacement as a new
 * LCP candidate; the old idle copy therefore turned a fast initial player into
 * a 3.2s LCP as soon as the live-room query switched it to "Waiting…".
 */
export function buyerStreamOverlayMessage({
  connected,
  waitingForPublisher,
  streamState,
  streamError,
}: {
  connected: boolean;
  waitingForPublisher: boolean;
  streamState: string;
  streamError: string | null;
}): string {
  if (connected) return BUYER_STREAM_CONNECTED_MESSAGE;
  if (waitingForPublisher || streamState !== 'error') return WAITING_FOR_PUBLISHER_MESSAGE;
  return streamError ?? 'The stream could not be connected.';
}

export interface BuyerLineupItem {
  eventId: string;
  eventItemId: string;
  productId: string;
  title: string;
  description?: string;
  referencePriceCents: number;
  currentPriceCents: number;
  listedQuantity: number;
  currentQuantity: number;
  position: number;
  stageState: 'queued' | 'on-stage' | 'completed';
  attributes: Record<string, string | number | boolean>;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export function buyerStatsFromSyncRows(rows?: readonly BuyerStats[]): BuyerStats | null {
  return rows?.[0] ?? null;
}

export function lineupItemToBuyerProduct(item: BuyerLineupItem): BuyerProduct {
  return {
    id: item.productId,
    eventId: item.eventId,
    eventItemId: item.eventItemId,
    title: item.title,
    subtitle: item.description ?? 'Available in this event',
    ...(item.description ? { description: item.description } : {}),
    priceCents: item.currentPriceCents,
    ...(item.referencePriceCents > item.currentPriceCents
      ? { compareAtPriceCents: item.referencePriceCents }
      : {}),
    availableQty: item.currentQuantity,
    ...(item.stageState === 'on-stage' ? { badge: 'Live now' } : {}),
  };
}

export function lineupItemsForEvent(
  rows: readonly BuyerLineupItem[] | undefined,
  eventId: string,
): BuyerLineupItem[] {
  return (rows ?? [])
    .filter((item) => item.eventId === eventId)
    .sort((left, right) => (
      left.position - right.position || left.eventItemId.localeCompare(right.eventItemId)
    ));
}

export function buyerProductsFromLineupRows(
  rows: readonly BuyerLineupItem[] | undefined,
  eventId: string,
): BuyerProduct[] {
  return lineupItemsForEvent(rows, eventId).map(lineupItemToBuyerProduct);
}

function isUnknownEventLineupError(error: Error | null): boolean {
  return Boolean(error && /unknown event/i.test(error.message));
}

export async function openOrHoldBuyerProduct(
  product: BuyerProduct,
  checkout: Pick<BuyerCheckoutActions, 'heldProductIds' | 'openHeldItems' | 'holdProduct'>,
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
  guideEvents: guideEventsProp,
}: BuyerTabProps) {
  /* The app shell owns the persistent guide. Standalone renders still read the
     same directory so the active room title and thumbnail stay authoritative. */
  // REST-pinned on purpose: events.guide has no Zero leaf — its rows carry
  // SERVER-COMPUTED viewers/playbackUrl that ZQL cannot derive (see
  // UNSYNCED_QUERY_REASONS in libs/zero), so a transport-following
  // useSyncQuery would serve rows missing both on the WEBSOCKETS rung.
  const guideQuery = useRestSyncQuery<GuideEvent>({
    queryName: 'events.guide',
    args: {},
    enabled: guideEventsProp === undefined,
    pollIntervalMs: 15_000,
  });
  const guideEvents = guideEventsProp ?? guideQuery.data ?? [];
  // The guide is the authority on an event's title once loaded: an event
  // reached from the guide has no config fetch behind it yet, and falling back
  // to the caller's title would label every room "Sunday vintage drop".
  const activeGuideEvent = useMemo(
    () => guideEvents.find((event) => event.eventId === eventId) ?? null,
    [guideEvents, eventId],
  );
  const resolvedTitle = activeGuideEvent?.title ?? eventTitle;

  // Live stats (P-111 — no dummy data): real presence + paid orders through
  // the app-wide sync transport, with polling retained as its fallback mode.
  const statsQuery = useRestSyncQuery<BuyerStats>({
    queryName: 'event.stats',
    args: { eventId },
    enabled: !statsProp,
    pollIntervalMs: 15_000,
  });
  const stats = statsProp ?? buyerStatsFromSyncRows(statsQuery.data) ?? EMPTY_BUYER_STATS;
  const transcriptQuery = useSyncQuery<EventTranscriptMoment>({
    queryName: 'event.chat.transcript',
    args: { eventId },
    pollIntervalMs: 5_000,
  });
  // A single failed poll (resolver hiccup, transient network blip) should not
  // flip an otherwise-healthy room into a scary "transcript unavailable"
  // alert — EI-20538641531453022. Only surface the error once it repeats on
  // a second consecutive poll; any success resets it immediately.
  const [confirmedTranscriptError, setConfirmedTranscriptError] = useState<Error | null>(null);
  const transcriptErrorStreakRef = useRef(0);
  useEffect(() => {
    const next = nextTranscriptErrorState(transcriptErrorStreakRef.current, transcriptQuery.error);
    transcriptErrorStreakRef.current = next.streak;
    setConfirmedTranscriptError(next.confirmed);
  }, [transcriptQuery.error]);
  // NOTE: the transcript presentation is built further down, after
  // `useStreamSession` — it needs that hook's `streamState` to decide whether
  // the captions it holds may call themselves live (WI-39839).
  // D-001/D-002: Watch is an event-lineup surface, never a global catalog
  // browse surface. This query is registered on both REST and Zero, so it must
  // follow the active sync transport to receive seller stage changes without
  // waiting for the polling fallback interval.
  const lineupQuery = useSyncQuery<BuyerLineupItem>({
    queryName: 'event.lineup.items',
    args: { eventId },
    enabled: !productsProp,
    pollIntervalMs: 10_000,
    staleTime: 0,
  });
  // Polling intentionally retains placeholder data across args-key changes.
  // Filter by the selected event before adapting so the old room's lineup can
  // never flash in the new one while its request is in flight.
  const lineupItems = useMemo(
    () => lineupItemsForEvent(lineupQuery.data, eventId),
    [eventId, lineupQuery.data],
  );
  const lineupProducts = useMemo(
    () => lineupItems.map(lineupItemToBuyerProduct),
    [lineupItems],
  );
  const lineupLoading = productsProp === undefined && (lineupQuery.loading || lineupQuery.fetching);
  const lineupError = productsProp === undefined ? lineupQuery.error : null;
  const lineupState = productsProp !== undefined
    ? 'override'
    : lineupError
      ? isUnknownEventLineupError(lineupError) ? 'unpublished' : 'error'
      : lineupLoading
        ? 'loading'
        : lineupProducts.length === 0 ? 'empty' : 'ready';
  const products = productsProp ?? (lineupState === 'ready' ? lineupProducts : []);
  // The current room is one row in the same live guide, so its thumbnail and
  // title advance atomically when a seller republishes event config.
  const thumbnailUrl = thumbnailUrlProp ?? activeGuideEvent?.thumbnailUrl;
  const room = useMemo(() => createEventRoom(eventId, origin), [eventId, origin]);
  const [holdNoticeState, setHoldNoticeState] = useState({ eventId, value: null as string | null });
  const holdNotice = holdNoticeState.eventId === eventId ? holdNoticeState.value : null;
  /** True while the room is live but no seller is publishing to it yet. */
  const [waitingForPublisher, setWaitingForPublisher] = useState(false);
  const [holdOverridesState, setHoldOverridesState] = useState({
    eventId,
    value: EMPTY_HOLD_OVERRIDES as Record<string, number>,
  });
  const holdOverrides = holdOverridesState.eventId === eventId
    ? holdOverridesState.value
    : EMPTY_HOLD_OVERRIDES;
  const [showAllProductsState, setShowAllProductsState] = useState({ eventId, value: false });
  const showAllProducts = showAllProductsState.eventId === eventId && showAllProductsState.value;
  // Which product the live auction is on. Lifted out of AuctionPanel (it owns
  // the `event.auction.active` query) because the mobile sticky CTA renders
  // OUTSIDE that slot and must name the same item as the module above it.
  // Derived server state, not user-meaningful — so useState, not nuqs.
  const [auctionSelection, setAuctionSelection] = useState({ eventId, productId: null as string | null });
  const auctionedProductId = auctionSelection.eventId === eventId ? auctionSelection.productId : null;
  const handleActiveAuctionProductChange = useCallback((productId: string | null) => {
    setAuctionSelection((current) => (
      current.eventId === eventId && current.productId === productId
        ? current
        : { eventId, productId }
    ));
  }, [eventId]);
  const stream = useStreamSession<ViewerSession>();
  const {
    streamState,
    setStreamState,
    streamError,
    setStreamError,
    session,
    videoRef,
    start: startStream,
    stop: stopStream,
  } = stream;
  const transcript = useMemo(
    () => remoteTranscriptPresentation(transcriptQuery.data ?? [], {
      videoLive: streamState === 'live',
      error: confirmedTranscriptError,
      loading: transcriptQuery.loading,
    }),
    [transcriptQuery.data, confirmedTranscriptError, transcriptQuery.loading, streamState],
  );
  const selectedRoomRef = useRef(room);
  selectedRoomRef.current = room;
  // D-013: this is deliberately an auth-free demo identity. Every buyer-side
  // action consumes the same persisted id, and the Orders tab imports the same
  // hook rather than inventing a second notion of "current user".
  const { userId, impersonate } = useDemoIdentity('buyer');
  const buyerCheckout = useBuyerCheckout();
  const heldProductIds = buyerCheckout?.heldProductIds ?? [];
  const heldProductIdSet = useMemo(() => new Set(heldProductIds), [heldProductIds]);

  const connectStream = useCallback(() =>
    startStream(
      () =>
        connectViewer({
          room,
          mediaBaseUrl,
          onTrack: (mediaStream) => {
            if (selectedRoomRef.current !== room) return;
            if (videoRef.current && videoRef.current.srcObject !== mediaStream) {
              videoRef.current.srcObject = mediaStream;
            }
            // `track` fires when the remote SDP installs its receiver, before
            // ICE necessarily has a usable path. `connectViewer` now resolves
            // only after the peer connection reaches `connected`, so let the
            // surrounding stream session make that the sole `live` signal.
            // A rejected play() here is Chrome's autoplay policy (unmuted, no
            // gesture). Silently swallowing it left the pane black while media
            // decoded underneath (WI-39774) — force muted and play anyway; the
            // buyer unmutes through the native controls.
            void videoRef.current?.play().catch(() => {
              const el = videoRef.current;
              if (!el) return;
              el.muted = true;
              void el.play().catch(() => undefined);
            });
          },
          // WI-39747: the retry below only covers "the publisher has not started
          // YET" (a WHEP 404). A stream that ARRIVES and then dies never
          // produces that 404 — measured against MediaMTX, every publisher
          // eventually ends in `peer connection closed`, anywhere from 3s to
          // 5m — so without this the pane goes black and nothing re-arms. On the
          // public domain an established connection dropping is routine (NAT,
          // mobile data, wifi handoffs), not exotic.
          onConnectionLost: () => {
            if (selectedRoomRef.current !== room) return;
            reconnectOnLossRef.current?.();
          },
        }),
      {
        attach: (viewer) => viewer.stream,
        fallbackError: 'The stream could not be connected.',
      },
    ), [mediaBaseUrl, room, startStream, videoRef]);

  /**
   * Staying attached while the seller's camera arrives (WI-39733).
   *
   * The event goes `live` BEFORE the WHIP publisher exists — `Start event`
   * publishes the lifecycle first and the camera permission grant sits between
   * the two — and MediaMTX answers WHEP with 404 for a path with no publisher.
   * A single auto-connect therefore lands in that gap for every buyer already
   * in the room, and because this effect does not re-run while the event stays
   * `live`, the publisher arriving seconds later changed nothing: the pane
   * stayed black until the buyer reloaded. So the viewer re-offers on a bounded
   * schedule instead of latching, and only for the not-yet 404 — every other
   * failure still surfaces immediately with its own message.
   *
   * The bound is not caution, it is a live defect: `End event` leaves the row
   * `live` forever (WI-39737), so dead rooms are reachable and an unbounded
   * poll would run in them for as long as the tab stayed open.
   */
  const publisherWaitRef = useRef<{
    generation: number;
    timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  }>({ generation: 0, timer: undefined });

  /**
   * Re-entry point for a stream that dies after it was working (WI-39747).
   *
   * Held in a ref rather than called directly because the recovery routine is
   * built FROM `connectStream`, so calling it from inside `connectStream`'s own
   * options would be a dependency cycle between the two callbacks.
   *
   * `remaining` bounds how many times a LOSS may re-arm the wait. Each re-entry
   * is itself bounded (~96s), but a connection that establishes and drops
   * immediately, forever, would otherwise reconnect forever. A handful of
   * recoveries covers a genuine network blip; past that the room is broken and
   * the buyer is better served by the terminal message than by a silent spinner.
   */
  const reconnectOnLossRef = useRef<(() => void) | undefined>(undefined);
  const lossReconnectsRemainingRef = useRef(MAX_LOSS_RECONNECTS);

  const cancelPublisherWait = useCallback(() => {
    publisherWaitRef.current.generation += 1;
    if (publisherWaitRef.current.timer !== undefined) {
      globalThis.clearTimeout(publisherWaitRef.current.timer);
      publisherWaitRef.current.timer = undefined;
    }
    setWaitingForPublisher(false);
  }, []);

  const connectStreamUntilPublisher = useCallback(async () => {
    cancelPublisherWait();
    const { generation } = publisherWaitRef.current;
    const superseded = () => publisherWaitRef.current.generation !== generation;

    const attempt = async (failures: number): Promise<void> => {
      if (superseded()) return;
      const outcome = await connectStream();
      if (superseded()) return;

      if (outcome.status !== 'failed' || !isPublisherNotReady(outcome.error)) {
        setWaitingForPublisher(false);
        return;
      }

      const delay = publisherRetryDelayMs(failures);
      if (delay === null) {
        // The wait is spent. `start` already left the viewer in its error
        // state; only the message changes, from a transport status the buyer
        // cannot act on to the one fact they can — nobody is on camera.
        setWaitingForPublisher(false);
        setStreamError(PUBLISHER_ABSENT_MESSAGE);
        return;
      }

      setWaitingForPublisher(true);
      setStreamState('connecting');
      publisherWaitRef.current.timer = globalThis.setTimeout(() => {
        void attempt(failures + 1);
      }, delay);
    };

    await attempt(0);
  }, [cancelPublisherWait, connectStream, setStreamError, setStreamState]);

  // Armed here, not called inline, to keep `connectStream` and the recovery
  // routine free of a mutual dependency. A loss re-enters the SAME bounded wait
  // a first connect uses, so a dead room still terminates instead of spinning.
  useEffect(() => {
    reconnectOnLossRef.current = () => {
      if (lossReconnectsRemainingRef.current <= 0) {
        setWaitingForPublisher(false);
        setStreamError(PUBLISHER_ABSENT_MESSAGE);
        return;
      }
      lossReconnectsRemainingRef.current -= 1;
      void connectStreamUntilPublisher();
    };
  }, [connectStreamUntilPublisher, setStreamError, setWaitingForPublisher]);

  useEffect(() => {
    if (activeGuideEvent?.status !== 'live') {
      cancelPublisherWait();
      return stopStream;
    }
    // A fresh live event gets a fresh recovery budget.
    lossReconnectsRemainingRef.current = MAX_LOSS_RECONNECTS;
    void connectStreamUntilPublisher();
    return () => {
      cancelPublisherWait();
      stopStream();
    };
  }, [activeGuideEvent?.status, cancelPublisherWait, connectStreamUntilPublisher, stopStream]);

  const disconnectStream = useCallback(() => {
    cancelPublisherWait();
    stopStream();
  }, [cancelPublisherWait, stopStream]);

  /** A real reservation (P-103): the hold hits inventory and decrements availableQty. */
  const reserveProduct = async (product: BuyerProduct) => {
    if (product.availableQty <= 0 && !heldProductIdSet.has(product.id)) return;
    try {
      if (!buyerCheckout) throw new Error('Buyer checkout is unavailable');
      const outcome = await openOrHoldBuyerProduct(product, buyerCheckout);
      if (outcome === 'opened') return;
      setHoldNoticeState({ eventId, value: `${product.title} is held for you.` });
      setHoldOverridesState((current) => ({
        eventId,
        value: {
          ...(current.eventId === eventId ? current.value : EMPTY_HOLD_OVERRIDES),
          [product.id]: Math.max(
            0,
            ((current.eventId === eventId ? current.value[product.id] : undefined) ?? product.availableQty) - 1,
          ),
        },
      }));
      lineupQuery.invalidate?.();
    } catch (error) {
      if (error instanceof Error && /insufficient available quantity/i.test(error.message)) {
        setHoldNoticeState({ eventId, value: `${product.title} just sold out.` });
        setHoldOverridesState((current) => ({
          eventId,
          value: {
            ...(current.eventId === eventId ? current.value : EMPTY_HOLD_OVERRIDES),
            [product.id]: 0,
          },
        }));
        lineupQuery.invalidate?.();
        return;
      }
      setHoldNoticeState({
        eventId,
        value: 'The hold could not be placed — check your connection and try again.',
      });
    }
  };

  const liveLabel = streamLabel(streamState);
  const productsWithLiveQuantity = useMemo(() => products.map((product) => {
    const liveQty = heldProductIdSet.has(product.id) ? holdOverrides[product.id] : undefined;
    return liveQty === undefined ? product : { ...product, availableQty: liveQty };
  }), [heldProductIdSet, holdOverrides, products]);
  const visibleProducts = availableBuyerProducts(productsWithLiveQuantity);
  // A running auction IS the current offer, so it — not catalog order — decides
  // which product the room is on. Without this the sticky mobile CTA names
  // whatever happens to sort first, contradicting the module directly above it.
  const auctionedProduct = auctionedProductId
    ? productsWithLiveQuantity.find((product) => product.id === auctionedProductId) ?? null
    : null;
  const onStageProductId = productsProp === undefined
    ? lineupItems.find((item) => item.stageState === 'on-stage')?.productId ?? null
    : null;
  const onStageProduct = onStageProductId
    ? productsWithLiveQuantity.find((product) => product.id === onStageProductId) ?? null
    : null;
  const currentProduct = auctionedProduct
    ?? onStageProduct
    ?? visibleProducts[0]
    ?? productsWithLiveQuantity[0]
    ?? null;
  const currentProductPosition = currentProduct
    ? productsWithLiveQuantity.findIndex((product) => product.id === currentProduct.id) + 1
    : 0;
  const totalProductCount = productsWithLiveQuantity.length;
  const productSequenceById = useMemo(
    () => Object.fromEntries(productsWithLiveQuantity.map((product, index) => [product.id, index + 1])),
    [productsWithLiveQuantity],
  );
  const upcomingProducts = currentProductPosition > 0
    ? productsWithLiveQuantity.slice(currentProductPosition)
    : productsWithLiveQuantity;
  const displayedProducts = showAllProducts
    ? productsWithLiveQuantity
    : upcomingProducts.slice(0, BUYER_PRODUCT_PREVIEW_LIMIT);
  const seller = useMemo<BuyerRoomSeller>(() => ({
    id: activeGuideEvent?.sellerId ?? 'event-host',
    name: activeGuideEvent?.sellerName ?? 'SideStage event host',
    status: activeGuideEvent?.status ?? 'unknown',
  }), [activeGuideEvent]);
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
      </header>

      <section className="buyer-stage-grid" aria-label="Live video and current offer">
        <div className="buyer-stage-primary">
          <div className="buyer-player-card">
          {/*
            `muted` + `autoPlay` are load-bearing (WI-39774): Chrome's autoplay
            policy REJECTS an unmuted play() with no user gesture, the rejection
            was swallowed, and the element sat paused forever — a black pane
            with packets flowing and frames decoding underneath. Muted autoplay
            is always policy-allowed; the native controls carry the unmute.
          */}
          <video
            ref={videoRef}
            className="buyer-player"
            // Empty native controls are not actionable, and Chromium paints
            // their internal SVG buttons again during each failed WHEP offer.
            // That late repaint made the otherwise-stable waiting paragraph a
            // 2.7s LCP candidate on public mobile Lighthouse. Keep the empty
            // player visually stable; expose mute/play controls once a real
            // media session exists.
            controls={Boolean(session)}
            playsInline
            muted
            autoPlay
            preload="none"
            aria-label={`${resolvedTitle} stream`}
          />
          <div className="buyer-player-overlay">
            <span className="live-badge">{room.eventId}</span>
            <p>
              {buyerStreamOverlayMessage({
                connected: Boolean(session),
                waitingForPublisher,
                streamState,
                streamError,
              })}
            </p>
            {session ? (
              <button className="button secondary" type="button" onClick={disconnectStream}>Disconnect</button>
            ) : streamState === 'error' ? (
              <button className="button primary" type="button" onClick={() => void connectStreamUntilPublisher()}>
                Retry stream
              </button>
            ) : null}
          </div>
          {transcript.segments.length > 0 || transcript.error || streamState === 'live' ? (
            <Suspense fallback={null}>
              <LazyVideoEngagementOverlay
                className="buyer-video-engagement-overlay"
                transcript={transcript}
              />
            </Suspense>
          ) : null}
          </div>

          <BuyerRoomContext
            chat={(
              <DeferredBuyerEventChat
                eventId={eventId}
                userId={userId}
                eventTitle={resolvedTitle}
                apiBaseUrl={resolveApiBaseUrl()}
              />
            )}
            currentProduct={currentProduct}
            eventTitle={resolvedTitle}
            productCount={totalProductCount}
            seller={seller}
            stats={stats}
          />
        </div>

        <AuctionPanel
          className="buyer-current-offer-slot"
          eventId={eventId}
          products={products}
          bidderId={userId}
          displayName={userId}
          apiBaseUrl={import.meta.env.VITE_API_URL}
          onActiveAuctionProductChange={handleActiveAuctionProductChange}
          idleContent={(
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
          )}
        />
      </section>

      <div className="buyer-lower-grid">
        <div className="buyer-shop-panel">
          <section className="buyer-drop-runway" aria-labelledby="buyer-drop-runway-title">
            <header className="buyer-products-heading">
              <div>
                <p className="eyebrow">Coming up</p>
                <h3 id="buyer-drop-runway-title">The drop runway</h3>
              </div>
              <span className="muted">
                {currentProductPosition > 0
                  ? `Item ${currentProductPosition} of ${totalProductCount} live now`
                  : lineupState === 'loading'
                    ? 'Loading the event lineup'
                    : lineupState === 'unpublished'
                      ? 'Event unavailable'
                      : lineupState === 'error'
                        ? 'Lineup unavailable'
                        : lineupState === 'empty'
                          ? 'Published lineup is empty'
                          : 'The lineup is waiting to be published'}
              </span>
            </header>

            {totalProductCount > 0 ? (
              <div className="buyer-drop-progress">
                <div className="buyer-drop-progress-copy">
                  <span>Drop progress</span>
                  <strong>{currentProductPosition} / {totalProductCount}</strong>
                </div>
                <div
                  className="buyer-drop-progress-track"
                  role="progressbar"
                  aria-label="Drop progress"
                  aria-valuemin={0}
                  aria-valuemax={totalProductCount}
                  aria-valuenow={currentProductPosition}
                  aria-valuetext={`Item ${currentProductPosition} of ${totalProductCount} is live`}
                >
                  <span style={{ width: `${(currentProductPosition / totalProductCount) * 100}%` }} />
                </div>
              </div>
            ) : null}

            {holdNotice && heldProductIds.length > 0 ? <p className="buyer-hold-notice" role="status">{holdNotice}</p> : null}
            <div id="buyer-event-products" className="buyer-products-shell" aria-label="Event products">
              {lineupState === 'loading' ? (
                <div className="buyer-rail-empty" role="status">Loading this event’s lineup…</div>
              ) : lineupState === 'unpublished' ? (
                <div className="buyer-rail-empty buyer-lineup-error" role="alert">
                  This event is not published or is no longer available.
                </div>
              ) : lineupState === 'error' ? (
                <div className="buyer-rail-empty buyer-lineup-error" role="alert">
                  The event lineup could not be loaded. Check your connection and try again.
                </div>
              ) : lineupState === 'empty' ? (
                <div className="buyer-rail-empty" role="status">
                  This published event does not have any lineup items yet.
                </div>
              ) : (
                <BuyerProductRail
                  products={displayedProducts}
                  heldProductIds={heldProductIds}
                  sequenceByProductId={productSequenceById}
                  currentSequenceNumber={currentProductPosition}
                  totalProducts={totalProductCount}
                  ariaLabel={showAllProducts ? 'Products in sale order' : 'Upcoming products in sale order'}
                  onHold={reserveProduct}
                />
              )}
            </div>

            {lineupState === 'ready' || lineupState === 'override' ? <footer className="buyer-runway-footer">
              <p>
                <strong>{visibleProducts.length}</strong> available
                {upcomingProducts.length > BUYER_PRODUCT_PREVIEW_LIMIT && !showAllProducts
                  ? ` · +${upcomingProducts.length - BUYER_PRODUCT_PREVIEW_LIMIT} more upcoming`
                  : ' · sale order locked'}
              </p>
              {upcomingProducts.length > BUYER_PRODUCT_PREVIEW_LIMIT ? (
                <button
                  className="button secondary buyer-products-toggle"
                  type="button"
                  aria-controls="buyer-event-products"
                  aria-expanded={showAllProducts}
                  onClick={() => setShowAllProductsState((current) => ({
                    eventId,
                    value: !(current.eventId === eventId && current.value),
                  }))}
                >
                  {showAllProducts
                    ? `Show next ${BUYER_PRODUCT_PREVIEW_LIMIT}`
                    : `View all ${productsWithLiveQuantity.length} items`}
                </button>
              ) : null}
            </footer> : null}
          </section>
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
