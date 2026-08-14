import { useCallback, useEffect, useState } from 'react';
import { useSyncMutate } from '@papercusp/sync';
import { useDemoIdentity } from './buyer-identity';
import { requestChatJson } from './chat-api';
import { TabHeader } from './components/TabHeader';
import { EventChat, resolveApiOrigin } from './EventChat';
import { chatEventId, DEFAULT_EVENT_ID, DEFAULT_EVENT_TITLE, mediaBaseUrl } from './event-identity';
import { readSellerAuctionToken } from './events/api';
import { useCopyState, useStreamSession } from './hooks';
import { studioViewHref, useUrlStudioView, type StudioView } from './app-routing';
import { InventoryPanel } from './InventoryPanel';
import { emptyStageLog, stageLogOnProductChange } from './run-of-show';
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
}: {
  eventId: string;
  roomEventId?: string;
  selectedProductId: string | null;
  transcriptProducts: readonly TranscriptProductOption[];
  apiBaseUrl?: string;
}) {
  const transcriptEventId = roomEventId ?? chatEventId(eventId);
  const transcriptFallback = useCallback((input: TranscriptMomentMutationInput) => (
    requestChatJson<unknown>(
      `${resolveApiOrigin(apiBaseUrl)}/chat/events/${encodeURIComponent(transcriptEventId)}/transcript`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  ), [apiBaseUrl, transcriptEventId]);
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
 * another render until React trips its maximum-depth guard. Read the seller
 * token at invocation time so a stable callback still uses the latest grant.
 */
export function useSellerDeepgramTokenProvider(apiBaseUrl?: string) {
  return useCallback(() => requestDeepgramToken(apiBaseUrl, {
    sellerAccessToken: readSellerAuctionToken(),
  }), [apiBaseUrl]);
}

export function SellerTab({
  selectedProduct,
  selectedProductId,
  transcriptProducts,
  onActiveProductChange,
}: {
  selectedProduct: CatalogProduct | null;
  selectedProductId: string | null;
  transcriptProducts: readonly TranscriptProductOption[];
  onActiveProductChange: (productId: string | null) => void;
}) {
  const [eventId, setEventId] = useState(DEFAULT_EVENT_ID);
  const [room, setRoom] = useState<EventRoom | null>(null);
  const [runOfShowLog, setRunOfShowLog] = useState(emptyStageLog);
  const stream = useStreamSession<PublisherSession>();
  const { copyState, copy } = useCopyState();
  const { userId, impersonate } = useDemoIdentity('seller');
  const [studioView, navigateStudioView] = useUrlStudioView();
  const mobileStudio = useMobileStudioViewport();

  // The desktop dock and mobile tab host remount their panels at the breakpoint.
  // Keep the live show clock above both hosts so that transition history survives.
  useEffect(() => {
    setRunOfShowLog((current) => stageLogOnProductChange(current, selectedProductId, Date.now()));
  }, [selectedProductId]);

  const recordTranscriptMoment = useTranscriptMomentRecorder({
    eventId,
    roomEventId: room?.eventId,
    selectedProductId,
    transcriptProducts,
    apiBaseUrl: import.meta.env.VITE_API_URL,
  });
  const transcriptEventId = room?.eventId ?? chatEventId(eventId);
  const deepgramTokenProvider = useSellerDeepgramTokenProvider(import.meta.env.VITE_API_URL);
  const classifyProductFocus = useCallback<TranscriptProductFocusClassifier>((input) => (
    requestChatJson<TranscriptSemanticFocusResult>(
      `${resolveApiOrigin(import.meta.env.VITE_API_URL)}/chat/events/${encodeURIComponent(transcriptEventId)}/transcript/product-focus`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  ), [transcriptEventId]);
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

  const startEvent = async () => {
    let nextRoom: EventRoom;
    try {
      nextRoom = createEventRoom(eventId);
    } catch (error) {
      stream.setStreamState('error');
      stream.setStreamError(error instanceof Error ? error.message : 'Choose a valid event room id.');
      return;
    }
    setRoom(nextRoom);
    await stream.start(
      () => connectPublisher({ room: nextRoom, mediaBaseUrl: mediaBaseUrl() }),
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
    eventTitle: DEFAULT_EVENT_TITLE,
    apiBaseUrl: import.meta.env.VITE_API_URL,
  };

  const panels: SellerDockPanelContextValue = {
    'stage-status': {
      eventTitle: DEFAULT_EVENT_TITLE,
      eventId,
      onEventIdChange: setEventId,
      roomEventId: room?.eventId ?? null,
      streamState: stream.streamState,
      streamError: stream.streamError,
      videoRef: stream.videoRef,
      isSessionActive: Boolean(stream.session),
      onStartEvent: () => void startEvent(),
      onEndEvent: stream.stop,
      onShareRoom: () => room && void copy(room.shareUrl),
      shareDisabled: !room,
      copyState,
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
      eventName: DEFAULT_EVENT_TITLE,
      apiBaseUrl: import.meta.env.VITE_API_URL,
      onEventReady: (nextEventId: string) => setEventId(nextEventId),
    },
    'run-of-show': {
      eventId,
      stageLog: runOfShowLog,
      activeProduct: selectedProduct,
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
      {studioView === 'inventory' ? (
        <InventoryPanel apiBaseUrl={import.meta.env.VITE_API_URL} />
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
    </div>
  );
}
