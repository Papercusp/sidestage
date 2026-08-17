import type { ReactNode, Ref } from 'react';
import { streamLabel, type StreamState } from '../hooks';
import { liveTranscriptPresentation } from '../LiveTranscriptOverlay';
import type { LiveTranscriptController } from '../use-live-transcript';
import { VideoEngagementOverlay } from '../VideoEngagementOverlay';
import type { ActiveEventStatus } from './active-event-status';

export interface StageStatusPanelProps {
  /** Headline for the live console — the event currently on stage. */
  eventTitle: string;
  /** Editable room slug the seller publishes to. */
  eventId: string;
  onEventIdChange: (nextEventId: string) => void;
  /**
   * Whether a BUYER can find this room, from the seller's own directory
   * (WI-39718).
   *
   * Required, not optional. The console's whole failure mode was implying
   * liveness it had never checked, so a caller that cannot say what the
   * directory holds must fail to compile rather than silently render the old,
   * status-free headline again.
   */
  eventStatus: ActiveEventStatus;
  /** The started room's id, or null before the event starts. */
  roomEventId: string | null;
  streamState: StreamState;
  streamError: string | null;
  /**
   * Set when the publish that "Start event" attempts did not land — the room
   * may be streaming while no buyer can reach it.
   */
  publishWarning: string | null;
  /** Retry that publish; also the one-click publish offered beside the warning. */
  onPublishEvent: () => void;
  publishing: boolean;
  /** Bound to the publisher preview element by the owning stream session. */
  videoRef: Ref<HTMLVideoElement>;
  /** True once a publisher session exists (renders "End event" instead of "Start event"). */
  isSessionActive: boolean;
  onStartEvent: () => void;
  onEndEvent: () => void;
  /** Live EventChat content kept mounted inside the shared video engagement surface. */
  chat: ReactNode;
  /** Long-lived transcript runtime rendered as captions over the camera surface. */
  transcript: LiveTranscriptController;
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
  eventStatus,
  roomEventId,
  streamState,
  streamError,
  publishWarning,
  onPublishEvent,
  publishing,
  videoRef,
  isSessionActive,
  onStartEvent,
  onEndEvent,
  chat,
  transcript,
}: StageStatusPanelProps) {
  return (
    <section className="stage-panel stage-primary" aria-labelledby="stage-status-title">
      <div className="panel-kicker"><span className="live-dot" /> Live console <span className="panel-status">{streamLabel(streamState)}</span></div>
      <h2 id="stage-status-title">{eventTitle}</h2>
      {/* Directly under the headline, because the headline is what the owner
          read as "this is live" (WI-39718). The badge answers the question the
          title only implied, and `role="status"` announces the answer when the
          directory resolves rather than leaving it to a sighted glance. */}
      <p className={`stage-event-status is-${eventStatus.presence}`} role="status" data-testid="stage-event-status">
        <span className="stage-event-status-badge">{eventStatus.label}</span>
        <span className="stage-event-status-detail">{eventStatus.detail}</span>
      </p>
      <p>Start the event when your camera and catalog are ready. SideStage publishes one room path that buyers join from the channel guide.</p>
      <div className="seller-stream-preview">
        <video ref={videoRef} className="stream-video" autoPlay muted playsInline aria-label="Seller camera preview" />
        <div className="stream-video-overlay">
          <span className="live-badge">{roomEventId ?? 'room not started'}</span>
          <p>{streamError ?? (streamState === 'live' ? 'Your camera and microphone are live.' : 'Camera preview appears here after you start the event.')}</p>
        </div>
        <VideoEngagementOverlay
          className="seller-video-engagement-overlay"
          chat={chat}
          transcript={liveTranscriptPresentation(transcript)}
        />
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
      <p className="field-help" id="seller-event-help">Lowercase letters, numbers, and hyphens become the room id buyers join from the channel guide.</p>
      <div className="stage-actions">
        {isSessionActive ? (
          <button className="button secondary" type="button" onClick={onEndEvent}>End event</button>
        ) : (
          <button className="button primary" type="button" onClick={onStartEvent} disabled={streamState === 'connecting'}>
            {streamState === 'connecting' ? 'Starting…' : 'Start event'}
          </button>
        )}
      </div>
      {/* The loud half of the WI-39718 fix. "Start event" publishes first, so
          this renders only when that publish FAILED — the exact state in which
          the room is streaming and no buyer can find it. `role="alert"` because
          it arrives after the seller has already started, and the one-click
          retry sits inside it so the fix never requires leaving the console. */}
      {publishWarning ? (
        <div className="stage-publish-warning" role="alert">
          <p>{publishWarning}</p>
          <button className="button secondary" type="button" onClick={onPublishEvent} disabled={publishing}>
            {publishing ? 'Publishing…' : 'Publish to buyers'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default StageStatusPanel;
