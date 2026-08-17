import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncMutate, useSyncPrincipal, useSyncQuery } from '@papercusp/sync';
import { useDemoIdentity } from './buyer-identity';
import { requestChatJson } from './chat-api';
import { TabHeader } from './components/TabHeader';
import { EventChat, resolveApiOrigin } from './EventChat';
import { chatEventId, DEFAULT_EVENT_TITLE, mediaBaseUrl, resolveActiveEventId, urlEventId } from './event-identity';
import {
  sellerPrivateRequestHeaders,
  transitionSellerEvent,
  type GuideEvent,
  type SellerEventItem,
  type SellerEventRecord,
} from './events/api';
import type { EventLifecycleAction } from './events/event-lifecycle';
import { activeEventStatus, publishOnStartWarning } from './seller/active-event-status';
import { retryEndEvent, runEndEvent } from './seller/end-event';
import { useStreamSession } from './hooks';
import { studioViewHref, useUrlStudioView, type StudioView } from './app-routing';
import { InventoryPanel } from './InventoryPanel';
import { emptyStageLog, stageLogOnProductChange } from './run-of-show';
import { StageClockProvider } from './seller/stage-clock';
import { SellerMobileStudio, useMobileStudioViewport } from './SellerMobileStudio';
import { SellerDock } from './SellerDock';
import {
  SELLER_ACTIVE_DOCK_LAYOUT_NAME,
  SELLER_MANAGER_DOCK_LAYOUT_NAME,
  sellerActiveEventDockDefaultLayout,
  sellerEventManagerDockDefaultLayout,
} from './seller-dock-layout';
import {
  SELLER_ACTIVE_DOCK_RESET_EVENT,
  SELLER_MANAGER_DOCK_RESET_EVENT,
} from './seller-dock-store';
import type { SellerDockPanelContextValue } from './seller-dock-panel-props';
import { SellerDockMissingPanel, sellerPanelRegistry } from './seller-dock-panels';
import type { CatalogProduct } from './seller-products';
import { connectPublisher, createEventRoom, type EventRoom, type PublisherSession } from './streaming';
import {
  type TranscriptSemanticFocusResult,
  type TranscriptProductFocusClassifier,
} from './transcript-product-focus';
import { useLiveTranscript, type TranscriptProductOption } from './use-live-transcript';
import { requestDeepgramToken } from './transcription';
import './studio.css';

export const STUDIO_VIEW_TABS = [
  { id: 'inventory', label: 'Inventory' },
  { id: 'event-manager', label: 'Event Manager' },
  { id: 'active-event', label: 'Active Event' },
] as const satisfies readonly { id: StudioView; label: string }[];

export function studioBoardConfig(view: StudioView) {
  return view === 'active-event'
    ? {
        layoutName: SELLER_ACTIVE_DOCK_LAYOUT_NAME,
        layoutSeed: sellerActiveEventDockDefaultLayout,
        resetEventName: SELLER_ACTIVE_DOCK_RESET_EVENT,
      }
    : {
        layoutName: SELLER_MANAGER_DOCK_LAYOUT_NAME,
        layoutSeed: sellerEventManagerDockDefaultLayout,
        resetEventName: SELLER_MANAGER_DOCK_RESET_EVENT,
    };
}

export function shouldUseMobileStudio(view: StudioView, mobileViewport: boolean): boolean {
  return mobileViewport && view === 'active-event';
}

export interface SellerEventIdentity {
  eventId: string;
  eventTitle: string;
}

/** Keep the selected room id and its authoritative directory/config title atomic. */
export function sellerEventIdentity(eventId: string, eventTitle?: string): SellerEventIdentity {
  return {
    eventId,
    eventTitle: eventTitle?.trim() || DEFAULT_EVENT_TITLE,
  };
}

/**
 * The event the URL explicitly names, or null when it names none (WI-39718).
 *
 * This used to be `initialSellerEventIdentity()`, which seeded the Studio from
 * `browserEventId()` — `urlEventId() ?? DEFAULT_EVENT_ID`. That `??` is the
 * defect: with no `?event=` in the URL it MANUFACTURED the hard-coded
 * `sunday-drop` literal and the Studio presented it as the Active Event,
 * whatever the directory actually held — a draft, or in production no row at
 * all. The buyer shell removed exactly this seed-outranks-directory bug (D-001,
 * `resolveActiveEventId`); the seller half kept the raw seed until now.
 *
 * Returning the honest `null` is what lets `resolveSellerEventIdentity` follow
 * the directory instead, with the seed surviving only as the pre-directory
 * fallback it was always meant to be.
 */
export function initialPinnedSellerEvent(): SellerEventIdentity | null {
  const pinned = urlEventId();
  return pinned === null ? null : sellerEventIdentity(pinned);
}

/**
 * Which event the Studio is pointed at — the seller mirror of the buyer shell's
 * D-001 precedence, deliberately delegating to that same
 * `resolveActiveEventId` rather than restating its `??` chain: two copies of
 * "explicit pin, then the directory, then the seed" is how the two shells drift
 * back apart.
 *
 * The directory here is the seller's OWN (`events.mine`), not the buyer guide,
 * because the seller's first row may legitimately be a draft — and the server
 * already orders that directory live-first, then scheduled, then draft
 * (`compareForSeller`), so its head is the event the seller most likely means.
 *
 * The title travels with the id from the same directory row, so a resolved
 * event can no longer wear DEFAULT_EVENT_TITLE ("Sunday vintage drop") over
 * some other seller's event — the second, quieter half of the same trap.
 */
export function resolveSellerEventIdentity(
  pinnedEvent: SellerEventIdentity | null,
  ownedEvents: readonly SellerEventRecord[],
): SellerEventIdentity {
  const eventId = resolveActiveEventId(pinnedEvent?.eventId ?? null, ownedEvents);
  const record = ownedEvents.find((event) => event.eventId === eventId);
  return sellerEventIdentity(
    eventId,
    record?.title ?? (pinnedEvent?.eventId === eventId ? pinnedEvent.eventTitle : undefined),
  );
}

export interface SellerEventTitleBindings {
  stageStatus: string;
  eventChat: string;
  eventManager: string;
}

/** Resolve every seller panel from the same authoritative guide record. */
export function sellerEventTitleBindings(
  identity: SellerEventIdentity,
  guideEvents: readonly Pick<GuideEvent, 'eventId' | 'title'>[],
): SellerEventTitleBindings {
  const guideTitle = guideEvents
    .find((event) => event.eventId === identity.eventId)
    ?.title.trim();
  const resolvedTitle = guideTitle || identity.eventTitle;
  return {
    stageStatus: resolvedTitle,
    eventChat: resolvedTitle,
    eventManager: resolvedTitle,
  };
}

export interface TranscriptMomentMutationInput {
  text: string;
  startMs?: number;
  endMs?: number;
  productId?: string;
  productTitle?: string;
}

/** Named transcript write seam; the REST route remains its transport fallback. */
export function useTranscriptMomentRecorder({
  eventId,
  roomEventId,
  selectedProductId,
  transcriptProducts,
  apiBaseUrl,
  principal,
}: {
  eventId: string;
  roomEventId?: string;
  selectedProductId: string | null;
  transcriptProducts: readonly TranscriptProductOption[];
  apiBaseUrl?: string;
  principal?: string;
}) {
  const transcriptEventId = roomEventId ?? chatEventId(eventId);
  const transcriptFallback = useCallback((input: TranscriptMomentMutationInput) => (
    requestChatJson<unknown>(
      `${resolveApiOrigin(apiBaseUrl)}/chat/events/${encodeURIComponent(transcriptEventId)}/transcript`,
      {
        method: 'POST',
        headers: sellerPrivateRequestHeaders(principal),
        body: JSON.stringify(input),
      },
    )
  ), [apiBaseUrl, principal, transcriptEventId]);
  const mutateTranscript = useSyncMutate<TranscriptMomentMutationInput, unknown>(
    'chat.addTranscriptMoment',
    transcriptFallback,
  );

  return useCallback((segment: { text: string; startMs?: number; endMs?: number }) => {
    const product = transcriptProducts.find((candidate) => candidate.id === selectedProductId);
    return mutateTranscript({
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      productId: product?.id,
      productTitle: product?.label,
    }).then(() => undefined).catch(() => undefined);
  }, [mutateTranscript, selectedProductId, transcriptProducts]);
}

/**
 * Keep the transcription session's token factory stable across Studio renders.
 *
 * `useLiveTranscript` treats this callback as session-construction input. An
 * inline function would rebuild the session after every state update, feeding
 * another render until React trips its maximum-depth guard.
 */
export function useSellerDeepgramTokenProvider(apiBaseUrl?: string, principal?: string) {
  return useCallback(() => requestDeepgramToken(apiBaseUrl, {
    principal,
  }), [apiBaseUrl, principal]);
}

export function SellerTab({
  selectedProduct,
  selectedProductId,
  sellerProducts,
  transcriptProducts,
  onActiveProductChange,
}: {
  selectedProduct: CatalogProduct | null;
  selectedProductId: string | null;
  sellerProducts: readonly CatalogProduct[];
  transcriptProducts: readonly TranscriptProductOption[];
  onActiveProductChange: (productId: string | null) => void;
}) {
  const [pinnedEvent, setPinnedEvent] = useState<SellerEventIdentity | null>(initialPinnedSellerEvent);
  const [room, setRoom] = useState<EventRoom | null>(null);
  const stream = useStreamSession<PublisherSession>();
  const { userId, impersonate } = useDemoIdentity('seller');
  const principal = useSyncPrincipal() ?? userId;
  const [studioView, navigateStudioView] = useUrlStudioView();
  const mobileStudio = useMobileStudioViewport();
  const guideQuery = useSyncQuery<GuideEvent>({
    queryName: 'events.guide',
    args: {},
    pollIntervalMs: 15_000,
  });
  /*
   * The seller's OWN event directory (WI-39718).
   *
   * The guide above cannot stand in for it: GET /events filters drafts out by
   * design, so the guide answers "is it absent?" identically for a draft and
   * for an id that names nothing — and telling those two apart is the whole
   * point of the Active Event badge. Event Manager already reads this exact
   * query with these exact args, so the two seller boards resolve status from
   * one source rather than two that can disagree.
   */
  const directoryQuery = useSyncQuery<SellerEventRecord>({
    queryName: 'events.mine',
    args: { sellerId: userId },
    pollIntervalMs: 15_000,
  });
  const ownedEvents = useMemo(() => directoryQuery.data ?? [], [directoryQuery.data]);
  const { eventId, eventTitle } = useMemo(
    () => resolveSellerEventIdentity(pinnedEvent, ownedEvents),
    [ownedEvents, pinnedEvent],
  );
  const eventStatus = useMemo(
    () => activeEventStatus(eventId, ownedEvents, directoryQuery.loading),
    [directoryQuery.loading, eventId, ownedEvents],
  );
  // The seller's own rows come FIRST: they carry drafts, which the buyer guide
  // never will, so a draft's real title reaches every panel instead of the
  // DEFAULT_EVENT_TITLE placeholder the identity falls back to.
  const eventTitles = useMemo(
    () => sellerEventTitleBindings({ eventId, eventTitle }, [...ownedEvents, ...(guideQuery.data ?? [])]),
    [eventId, eventTitle, guideQuery.data, ownedEvents],
  );

  /*
   * The live show clock (plan sidestage-lineup-run-of-show-2026-08-16).
   *
   * It lives here because the desktop dock and the mobile tab host remount
   * their panels at the breakpoint, and the Event Manager board is a dock panel
   * too — so this is the one level above every consumer, and transition history
   * survives all of them.
   *
   * D-005: it advances on the EVENT'S STAGED PRODUCT — the server-authoritative
   * `onStage` flag that the guarded push/swap actions mutate — not on the
   * seller's local `selectedProductId`. The Lineup timeline renders its "on
   * stage" chip from that same flag, so sourcing the clock anywhere else would
   * let the chip and the clock disagree about which product is live, and would
   * compute pace against the wrong slot.
   */
  const stageItemsQuery = useSyncQuery<SellerEventItem>({
    queryName: 'event.actions.items',
    args: { eventId },
    pollIntervalMs: 10_000,
  });
  const stagedProductId = useMemo(
    () => stageItemsQuery.data?.find((item) => item.onStage)?.productId ?? null,
    [stageItemsQuery.data],
  );
  const recordTranscriptMoment = useTranscriptMomentRecorder({
    eventId,
    roomEventId: room?.eventId,
    selectedProductId,
    transcriptProducts,
    apiBaseUrl: import.meta.env.VITE_API_URL,
    principal,
  });
  const transcriptEventId = room?.eventId ?? chatEventId(eventId);
  const deepgramTokenProvider = useSellerDeepgramTokenProvider(import.meta.env.VITE_API_URL, principal);
  const classifyProductFocus = useCallback<TranscriptProductFocusClassifier>((input) => (
    requestChatJson<TranscriptSemanticFocusResult>(
      `${resolveApiOrigin(import.meta.env.VITE_API_URL)}/chat/events/${encodeURIComponent(transcriptEventId)}/transcript/product-focus`,
      {
        method: 'POST',
        headers: sellerPrivateRequestHeaders(principal),
        body: JSON.stringify(input),
      },
    )
  ), [principal, transcriptEventId]);
  const transcript = useLiveTranscript({
    active: Boolean(stream.session?.localStream),
    mediaStream: stream.session?.localStream,
    deepgramTokenProvider,
    fallbackToWebSpeech: true,
    products: transcriptProducts,
    activeProductId: selectedProductId,
    onActiveProductChange,
    onFinalSegment: recordTranscriptMoment,
    classifyProductFocus,
  });

  /*
   * Publishing is part of starting (WI-39718).
   *
   * The Studio has two start affordances and the owner reasonably took the
   * nearer one: the Live console's "Start event" opened the MEDIA room, while
   * only Event Manager's "Go live" moved the EVENT. Starting the room therefore
   * left a draft a draft, GET /events kept filtering it out, and a live show ran
   * that no buyer could discover — a failure that presents as a broken sync
   * transport and is in fact a lifecycle gap.
   *
   * `go-live` is legal from every state and idempotent from `live`
   * (`resolveLifecycleTransition`), so this needs no client-side legality check
   * and cannot be wrong about one — D-002 keeps that authority server-side. An
   * unknown room 404s, which is exactly the case that deserves the loud warning
   * rather than a silent no-op.
   */
  const publishFallback = useCallback(
    ({ eventId: resolvedEventId, action }: { eventId: string; action: EventLifecycleAction }) => (
      transitionSellerEvent(resolvedEventId, action, {}, import.meta.env.VITE_API_URL, principal)
    ),
    [principal],
  );
  const mutateLifecycle = useSyncMutate<
    { eventId: string; action: EventLifecycleAction },
    SellerEventRecord
  >('event.lifecycle', publishFallback);

  const [publishWarning, setPublishWarning] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const publishActiveEvent = useCallback(async (): Promise<boolean> => {
    setPublishing(true);
    try {
      await mutateLifecycle({ eventId, action: 'go-live' });
      setPublishWarning(null);
      // The badge reads the directory, so it must refetch or it would keep
      // saying "Draft" about an event this call just took live.
      directoryQuery.invalidate();
      return true;
    } catch (error) {
      setPublishWarning(publishOnStartWarning(error));
      return false;
    } finally {
      setPublishing(false);
    }
  }, [directoryQuery, eventId, mutateLifecycle]);

  /*
   * Ending is part of ending (WI-39737) — the exact mirror of the publish-on-
   * start gap above.
   *
   * "End event" used to be `stream.stop` and nothing else: the camera went off
   * and the event stayed `status='live'` in the directory forever. Because the
   * What's-On rail sorts live events FIRST, that pinned a dead room to the TOP
   * of every buyer's rail, and clicking it lands on the MediaMTX WHEP 404 /
   * black-video path (WI-39733). The seller's most reasonable action produced
   * the worst-looking failure the product has.
   *
   * WHICH READING OF "END EVENT" THIS IMPLEMENTS, and why it is not the
   * destructive one it looks like: this ends the EVENT LIFECYCLE (`end` →
   * `ended`), not merely the broadcast. The reason that is safe is in the
   * server's own transition table — `resolveLifecycleTransition` makes
   * `go-live` legal from EVERY state including `ended`, and treats it as a new
   * run rather than an error. So a mis-click during a show is recovered by
   * pressing "Start event" again; the only cost is a restamped start time. It
   * is not a one-way door, which is what would have made a "pause / seller
   * away" state necessary instead. `end` is also idempotent from `ended`, so
   * the retry beside the warning is safe to press twice.
   */
  const [endWarning, setEndWarning] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const endDeps = useMemo(() => ({
    endLifecycle: () => mutateLifecycle({ eventId, action: 'end' as const }),
    setWarning: setEndWarning,
    invalidateDirectory: () => directoryQuery.invalidate(),
  }), [directoryQuery, eventId, mutateLifecycle]);

  /*
   * The sequence itself lives in `seller/end-event.ts` — including why the
   * camera stops BEFORE the API call, which is the reverse of `startEvent`.
   * What stays here is only the React shell: the pending flag and the state
   * setters it drives.
   */
  const endEvent = useCallback(async (): Promise<boolean> => {
    setEnding(true);
    try {
      return await runEndEvent({ ...endDeps, stopStream: stream.stop });
    } finally {
      setEnding(false);
    }
  }, [endDeps, stream.stop]);

  const retryEnd = useCallback(async (): Promise<boolean> => {
    setEnding(true);
    try {
      return await retryEndEvent(endDeps);
    } finally {
      setEnding(false);
    }
  }, [endDeps]);

  const startEvent = async () => {
    let nextRoom: EventRoom;
    try {
      nextRoom = createEventRoom(eventId);
    } catch (error) {
      stream.setStreamState('error');
      stream.setStreamError(error instanceof Error ? error.message : 'Choose a valid event room id.');
      return;
    }
    // Publish BEFORE the camera connects: a failed publish must be visible
    // while the seller is still looking at this panel, not discovered later by
    // an empty room. A failure does not abort the start — the seller asked to
    // go on camera and gets to — it raises the alert and leaves the one-click
    // retry beside it.
    await publishActiveEvent();
    setRoom(nextRoom);
    await stream.start(
      () => connectPublisher({
        room: nextRoom,
        mediaBaseUrl: mediaBaseUrl(),
        // WI-39747: an established publish can fall over (measured repeatedly
        // against MediaMTX: `closed: peer connection closed` after anywhere
        // from 3s to 5m). Nothing used to surface that, so the seller kept
        // believing they were live while buyers held a black pane for the rest
        // of the event. On the public domain this is routine, not exotic —
        // buyers and sellers arrive over NAT, mobile data and wifi handoffs.
        onConnectionLost: () => {
          stream.setStreamState('error');
          stream.setStreamError(
            'Your camera disconnected from the media server — viewers are no longer seeing you. Start the stream again to reconnect.',
          );
        },
      }),
      {
        attach: (session) => session.localStream,
        fallbackError: 'The camera and microphone could not be connected.',
      },
    );
  };

  /**
   * The props every docked panel reads, by panel id (P-009).
   *
   * This replaces the six inline JSX call sites the `.seller-grid` used to
   * hold: the panels now mount inside the dock, so their props travel here
   * instead. The panel COMPONENTS are unchanged (D-003) — each entry is exactly
   * the prop set its element carried before.
   *
   * D-006/D-009: this bundle reaches panels through React context, never as
   * dockview panel `params`. It holds `videoRef`, a live `MediaStream` and
   * several callbacks; `params` is serialized into the layout JSON that P-010
   * persists, so routing props through it would corrupt layout restore.
   *
   * The explicit annotation is load-bearing rather than decorative: it is what
   * makes a panel's props change a compile error HERE, at the one place that
   * holds the values, instead of an undefined prop discovered at runtime inside
   * the panel. `SellerDockPanelContextValue` derives each entry from the
   * component's own props, so the two cannot drift.
   *
   * Deliberately NOT memoised. Every one of these panels re-rendered on every
   * SellerTab render under `.seller-grid`, and `startEvent` / `stream.start` /
   * `stream.stop` are rebuilt each render anyway, so a `useMemo` here would
   * either be defeated by its own dependencies or risk closing over stale
   * state. Rebuilding the object preserves today's behavior exactly.
   */
  const eventChatProps: SellerDockPanelContextValue['event-chat'] = {
    eventId: room?.eventId ?? chatEventId(eventId),
    role: 'seller',
    userId,
    displayName: userId,
    eventTitle: eventTitles.eventChat,
    apiBaseUrl: import.meta.env.VITE_API_URL,
  };

  const panels: SellerDockPanelContextValue = {
    'stage-status': {
      eventTitle: eventTitles.stageStatus,
      eventId,
      // Typing a room id is an EXPLICIT choice, so it pins — the directory only
      // decides which event is active when the seller has not said.
      onEventIdChange: (nextEventId) => setPinnedEvent((current) => (
        sellerEventIdentity(
          nextEventId,
          nextEventId === current?.eventId ? current.eventTitle : DEFAULT_EVENT_TITLE,
        )
      )),
      eventStatus,
      roomEventId: room?.eventId ?? null,
      streamState: stream.streamState,
      streamError: stream.streamError,
      publishWarning,
      onPublishEvent: () => void publishActiveEvent(),
      publishing,
      videoRef: stream.videoRef,
      isSessionActive: Boolean(stream.session),
      onStartEvent: () => void startEvent(),
      onEndEvent: () => void endEvent(),
      endWarning,
      onEndRetry: () => void retryEnd(),
      ending,
      chat: <EventChat {...eventChatProps} surface="audience-overlay" />,
      transcript,
    },
    'on-deck': { selectedProduct, eventId, apiBaseUrl: import.meta.env.VITE_API_URL },
    copilot: {
      apiBaseUrl: import.meta.env.VITE_API_URL,
      eventId: room?.eventId ?? chatEventId(eventId),
      actorId: userId,
    },
    'event-chat': eventChatProps,
    'event-manager': {
      eventId,
      actorId: userId,
      sellerName: userId,
      eventName: eventTitles.eventManager,
      apiBaseUrl: import.meta.env.VITE_API_URL,
      onEventReady: (nextEventId: string, nextEventTitle: string) => {
        setPinnedEvent(sellerEventIdentity(nextEventId, nextEventTitle));
      },
    },
    inventory: {
      eventId,
      actorId: userId,
      eventName: eventTitles.stageStatus,
      apiBaseUrl: import.meta.env.VITE_API_URL,
    },
    'run-of-show': {
      eventId,
      actorId: userId,
      activeProduct: selectedProduct,
      catalogProducts: sellerProducts,
      onActiveProductChange,
      apiBaseUrl: import.meta.env.VITE_API_URL,
    },
  };

  const dockView = studioView === 'inventory' ? 'active-event' : studioView;
  const { layoutName, layoutSeed, resetEventName } = studioBoardConfig(dockView);
  const hrefFor = (view: StudioView) => studioViewHref(
    view,
    typeof window === 'undefined' ? '/' : window.location.href,
  );

  return (
    <div className="tab-layout density-console">
      <TabHeader
        eyebrow="Seller view / stage control"
        title="Keep the room moving."
        copy="Your live context stays one glance away: what is on deck, what buyers are asking, and what the copilot can safely suggest."
      />
      <nav className="studio-subtabs" aria-label="Studio boards">
        {STUDIO_VIEW_TABS.map(({ id: view, label }) => (
          <a
            key={view}
            className="studio-subtab"
            href={hrefFor(view)}
            aria-current={studioView === view ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigateStudioView(view);
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      {/* One clock above every panel host — the dock, the mobile host, and the
          Event Manager board inside them all read this same log (D-003). */}
      <StageClockProvider stagedProductId={stagedProductId}>
        {studioView === 'inventory' ? (
          <InventoryPanel apiBaseUrl={import.meta.env.VITE_API_URL} principal={principal} />
        ) : shouldUseMobileStudio(studioView, mobileStudio) ? (
          <SellerMobileStudio panels={panels} />
        ) : (
          <SellerDock
            key={layoutName}
            panels={panels}
            registry={sellerPanelRegistry}
            layoutName={layoutName}
            layoutSeed={layoutSeed}
            foregroundPanelId={studioView === 'event-manager' ? 'event-manager' : undefined}
            resetEventName={resetEventName}
            missingComponent={SellerDockMissingPanel}
          />
        )}
      </StageClockProvider>
    </div>
  );
}
