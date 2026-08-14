import { useCallback, useState } from 'react';
import { TabHeader } from './components/TabHeader';
import { CopilotPanel } from './CopilotPanel';
import { EventChat } from './EventChat';
import EventManager from './events/EventManager';
import { chatEventId, DEFAULT_EVENT_ID, DEFAULT_EVENT_TITLE, mediaBaseUrl } from './event-identity';
import { useCopyState, useStreamSession } from './hooks';
import { OnDeckPanel } from './seller/OnDeckPanel';
import { StageStatusPanel } from './seller/StageStatusPanel';
import type { CatalogProduct } from './seller-products';
import { TranscriptPane, type TranscriptProductOption } from './TranscriptPane';
import { connectPublisher, createEventRoom, type EventRoom, type PublisherSession } from './streaming';

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
  const recordTranscriptMoment = useCallback((segment: { text: string; startMs?: number; endMs?: number }) => {
    const transcriptEventId = room?.eventId ?? chatEventId(eventId);
    return fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:3100'}/chat/events/${encodeURIComponent(transcriptEventId)}/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: segment.text,
        startMs: segment.startMs,
        endMs: segment.endMs,
      }),
    }).then((response) => {
      if (!response.ok) throw new Error(`Transcript grounding failed (${response.status})`);
    }).catch(() => undefined);
  }, [eventId, room?.eventId]);

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

  return (
    <div className="tab-layout density-console">
      <TabHeader
        eyebrow="Seller view / stage control"
        title="Keep the room moving."
        copy="Your live context stays one glance away: what is on deck, what buyers are asking, and what the copilot can safely suggest."
      />
      <div className="seller-grid">
        <StageStatusPanel
          eventTitle={DEFAULT_EVENT_TITLE}
          eventId={eventId}
          onEventIdChange={setEventId}
          roomEventId={room?.eventId ?? null}
          streamState={stream.streamState}
          streamError={stream.streamError}
          videoRef={stream.videoRef}
          isSessionActive={Boolean(stream.session)}
          onStartEvent={() => void startEvent()}
          onEndEvent={stream.stop}
          onShareRoom={() => room && void copy(room.shareUrl)}
          shareDisabled={!room}
          copyState={copyState}
        />
        <TranscriptPane
          className="seller-transcript"
          mediaStream={stream.session?.localStream}
          deepgramToken={import.meta.env.VITE_DEEPGRAM_TOKEN}
          products={transcriptProducts}
          activeProductId={selectedProductId}
          onActiveProductChange={onActiveProductChange}
          onFinalSegment={recordTranscriptMoment}
        />
        <OnDeckPanel selectedProduct={selectedProduct} />
        <CopilotPanel apiBaseUrl={import.meta.env.VITE_API_URL} />
        <EventChat
          eventId={room?.eventId ?? chatEventId(eventId)}
          role="seller"
          userId="seller-demo"
          displayName="Host"
          eventTitle={DEFAULT_EVENT_TITLE}
          apiBaseUrl={import.meta.env.VITE_API_URL}
        />
        <EventManager
          eventId={eventId}
          eventName={DEFAULT_EVENT_TITLE}
          apiBaseUrl={import.meta.env.VITE_API_URL}
          onEventReady={(nextEventId) => setEventId(nextEventId)}
        />
      </div>
    </div>
  );
}
