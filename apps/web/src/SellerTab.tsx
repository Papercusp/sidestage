import { useCallback, useState } from 'react';
import { DemoIdentityControl } from './BuyerIdentityControl';
import { useDemoIdentity } from './buyer-identity';
import { TabHeader } from './components/TabHeader';
import { EventChat } from './EventChat';
import { chatEventId, DEFAULT_EVENT_ID, DEFAULT_EVENT_TITLE, mediaBaseUrl } from './event-identity';
import { useCopyState, useStreamSession } from './hooks';
import { studioViewHref, useUrlStudioView } from './app-routing';
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
import { type TranscriptProductOption } from './TranscriptPane';
import { connectPublisher, createEventRoom, type EventRoom, type PublisherSession } from './streaming';
import './studio.css';

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
  const stream = useStreamSession<PublisherSession>();
  const { copyState, copy } = useCopyState();
  const { userId, impersonate } = useDemoIdentity('seller');
  const [studioView, navigateStudioView] = useUrlStudioView();
  const recordTranscriptMoment = useCallback((segment: { text: string; startMs?: number; endMs?: number }) => {
    const transcriptEventId = room?.eventId ?? chatEventId(eventId);
    const product = transcriptProducts.find((candidate) => candidate.id === selectedProductId);
    return fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3100'}/chat/events/${encodeURIComponent(transcriptEventId)}/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: segment.text,
        startMs: segment.startMs,
        endMs: segment.endMs,
        productId: product?.id,
        productTitle: product?.label,
      }),
    }).then((response) => {
      if (!response.ok) throw new Error(`Transcript grounding failed (${response.status})`);
    }).catch(() => undefined);
  }, [eventId, room?.eventId, selectedProductId, transcriptProducts]);

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
      chat: <EventChat {...eventChatProps} />,
    },
    transcript: {
      className: 'seller-transcript',
      mediaStream: stream.session?.localStream,
      deepgramToken: import.meta.env.VITE_DEEPGRAM_TOKEN,
      products: transcriptProducts,
      activeProductId: selectedProductId,
      onActiveProductChange,
      onFinalSegment: recordTranscriptMoment,
    },
    'on-deck': { selectedProduct, eventId, apiBaseUrl: import.meta.env.VITE_API_URL },
    copilot: {
      apiBaseUrl: import.meta.env.VITE_API_URL,
      eventId: room?.eventId ?? chatEventId(eventId),
    },
    'event-chat': eventChatProps,
    'event-manager': {
      eventId,
      actorId: userId,
      eventName: DEFAULT_EVENT_TITLE,
      apiBaseUrl: import.meta.env.VITE_API_URL,
      onEventReady: (nextEventId: string) => setEventId(nextEventId),
    },
    'event-settings': {
      eventId,
      apiBaseUrl: import.meta.env.VITE_API_URL,
      embedded: true,
    },
  };

  const activeBoard = studioView === 'active-event';
  const layoutName = activeBoard
    ? SELLER_ACTIVE_DOCK_LAYOUT_NAME
    : SELLER_MANAGER_DOCK_LAYOUT_NAME;
  const layoutSeed = activeBoard
    ? sellerActiveEventDockDefaultLayout
    : sellerEventManagerDockDefaultLayout;
  const resetEventName = activeBoard
    ? SELLER_ACTIVE_DOCK_RESET_EVENT
    : SELLER_MANAGER_DOCK_RESET_EVENT;
  const hrefFor = (view: 'active-event' | 'event-manager') => studioViewHref(
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
        {([
          ['active-event', 'Active Event'],
          ['event-manager', 'Event Manager'],
        ] as const).map(([view, label]) => (
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
      <SellerDock
        key={layoutName}
        panels={panels}
        registry={sellerPanelRegistry}
        layoutName={layoutName}
        layoutSeed={layoutSeed}
        resetEventName={resetEventName}
        missingComponent={SellerDockMissingPanel}
      >
        <DemoIdentityControl
          userId={userId}
          onImpersonate={impersonate}
          inputId="seller-demo-user-id"
          label="Seller demo user"
        />
      </SellerDock>
    </div>
  );
}
