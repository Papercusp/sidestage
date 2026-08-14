import { useCallback, useState } from 'react';
import { TabHeader } from './components/TabHeader';
import { CopilotPanel } from './CopilotPanel';
import { EventChat } from './EventChat';
import EventManager from './events/EventManager';
import { chatEventId, DEFAULT_EVENT_ID, DEFAULT_EVENT_TITLE, mediaBaseUrl } from './event-identity';
import { streamLabel, useCopyState, useStreamSession } from './hooks';
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
        <section className="stage-panel stage-primary" aria-labelledby="stage-status-title">
          <div className="panel-kicker"><span className="live-dot" /> Live console <span className="panel-status">{streamLabel(stream.streamState)}</span></div>
          <h2 id="stage-status-title">{DEFAULT_EVENT_TITLE}</h2>
          <p>Start the event when your camera and catalog are ready. SideStage publishes one room path that buyers can join with a share link.</p>
          <div className="seller-stream-preview">
            <video ref={stream.videoRef} className="stream-video" autoPlay muted playsInline aria-label="Seller camera preview" />
            <div className="stream-video-overlay">
              <span className="live-badge">{room?.eventId ?? 'room not started'}</span>
              <p>{stream.streamError ?? (stream.streamState === 'live' ? 'Your camera and microphone are live.' : 'Camera preview appears here after you start the event.')}</p>
            </div>
          </div>
          <label className="field-label" htmlFor="seller-event-id">Event room id</label>
          <input
            id="seller-event-id"
            className="text-input"
            value={eventId}
            onChange={(event) => setEventId(event.target.value)}
            disabled={stream.streamState === 'connecting' || stream.streamState === 'live'}
            aria-describedby="seller-event-help"
          />
          <p className="field-help" id="seller-event-help">Lowercase letters, numbers, and hyphens become the buyer share-link slug.</p>
          <div className="stage-actions">
            {stream.session ? (
              <button className="button secondary" type="button" onClick={stream.stop}>End event</button>
            ) : (
              <button className="button primary" type="button" onClick={() => void startEvent()} disabled={stream.streamState === 'connecting'}>
                {stream.streamState === 'connecting' ? 'Starting…' : 'Start event'}
              </button>
            )}
            <button className="button secondary" type="button" onClick={() => room && void copy(room.shareUrl)} disabled={!room}>
              {copyState === 'copied' ? 'Link copied' : copyState === 'failed' ? 'Copy failed' : 'Share room'}
            </button>
          </div>
        </section>
        <TranscriptPane
          className="seller-transcript"
          mediaStream={stream.session?.localStream}
          deepgramToken={import.meta.env.VITE_DEEPGRAM_TOKEN}
          products={transcriptProducts}
          activeProductId={selectedProductId}
          onActiveProductChange={onActiveProductChange}
          onFinalSegment={recordTranscriptMoment}
        />
        <section className="stage-panel" aria-labelledby="on-deck-title">
          <div className="panel-kicker">On deck <span className="panel-status">1 slot</span></div>
          {selectedProduct ? (
            <div className="on-deck-product">
              <div className={`mini-product-mark tone-${selectedProduct.tone}`}>{selectedProduct.glyph}</div>
              <div><h3 id="on-deck-title">{selectedProduct.name}</h3><p>{selectedProduct.price} · {selectedProduct.stockLabel}</p></div>
            </div>
          ) : (
            <div className="empty-state"><span className="empty-state-icon">＋</span><h3 id="on-deck-title">Choose a product</h3><p>Use the Buyer tab to place the first item on stage.</p></div>
          )}
        </section>
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
