import type { Ref } from 'react';
import { streamLabel, type CopyState, type StreamState } from '../hooks';

export interface StageStatusPanelProps {
  /** Headline for the live console — the event currently on stage. */
  eventTitle: string;
  /** Editable room slug the seller publishes to. */
  eventId: string;
  onEventIdChange: (nextEventId: string) => void;
  /** The started room's id, or null before the event starts. */
  roomEventId: string | null;
  streamState: StreamState;
  streamError: string | null;
  /** Bound to the publisher preview element by the owning stream session. */
  videoRef: Ref<HTMLVideoElement>;
  /** True once a publisher session exists (renders "End event" instead of "Start event"). */
  isSessionActive: boolean;
  onStartEvent: () => void;
  onEndEvent: () => void;
  onShareRoom: () => void;
  /** True before a room exists, when there is no share URL to copy. */
  shareDisabled: boolean;
  copyState: CopyState;
}

/**
 * The seller stage-status / live-console section (P-008).
 *
 * Extracted verbatim from SellerTab's inline `stage-panel stage-primary`
 * section so it can be mounted as a standalone dock panel (P-009). Purely
 * presentational: every piece of stream/room state arrives as a prop, so the
 * panel can be mounted anywhere its props can be supplied.
 */
export function StageStatusPanel({
  eventTitle,
  eventId,
  onEventIdChange,
  roomEventId,
  streamState,
  streamError,
  videoRef,
  isSessionActive,
  onStartEvent,
  onEndEvent,
  onShareRoom,
  shareDisabled,
  copyState,
}: StageStatusPanelProps) {
  return (
    <section className="stage-panel stage-primary" aria-labelledby="stage-status-title">
      <div className="panel-kicker"><span className="live-dot" /> Live console <span className="panel-status">{streamLabel(streamState)}</span></div>
      <h2 id="stage-status-title">{eventTitle}</h2>
      <p>Start the event when your camera and catalog are ready. SideStage publishes one room path that buyers can join with a share link.</p>
      <div className="seller-stream-preview">
        <video ref={videoRef} className="stream-video" autoPlay muted playsInline aria-label="Seller camera preview" />
        <div className="stream-video-overlay">
          <span className="live-badge">{roomEventId ?? 'room not started'}</span>
          <p>{streamError ?? (streamState === 'live' ? 'Your camera and microphone are live.' : 'Camera preview appears here after you start the event.')}</p>
        </div>
      </div>
      <label className="field-label" htmlFor="seller-event-id">Event room id</label>
      <input
        id="seller-event-id"
        className="text-input"
        value={eventId}
        onChange={(event) => onEventIdChange(event.target.value)}
        disabled={streamState === 'connecting' || streamState === 'live'}
        aria-describedby="seller-event-help"
      />
      <p className="field-help" id="seller-event-help">Lowercase letters, numbers, and hyphens become the buyer share-link slug.</p>
      <div className="stage-actions">
        {isSessionActive ? (
          <button className="button secondary" type="button" onClick={onEndEvent}>End event</button>
        ) : (
          <button className="button primary" type="button" onClick={onStartEvent} disabled={streamState === 'connecting'}>
            {streamState === 'connecting' ? 'Starting…' : 'Start event'}
          </button>
        )}
        <button className="button secondary" type="button" onClick={onShareRoom} disabled={shareDisabled}>
          {copyState === 'copied' ? 'Link copied' : copyState === 'failed' ? 'Copy failed' : 'Share room'}
        </button>
      </div>
    </section>
  );
}

export default StageStatusPanel;
