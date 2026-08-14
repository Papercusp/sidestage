import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { LiveTranscriptController } from './use-live-transcript';
import './live-transcript-overlay.css';

export interface LiveTranscriptOverlayProps {
  transcript: LiveTranscriptController;
}

export function liveTranscriptStateLabel(state: LiveTranscriptController['state']): string {
  if (state === 'listening') return 'Captions live';
  if (state === 'connecting') return 'Starting captions…';
  if (state === 'error') return 'Captions need attention';
  return 'Captions start with the event';
}

function segmentTime(startMs: number | undefined): string | null {
  if (startMs === undefined) return null;
  const seconds = Math.max(0, Math.floor(startMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Accessible captions and transcript history composed directly into the seller video. */
export function LiveTranscriptOverlay({ transcript }: LiveTranscriptOverlayProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyId = useId();
  const historyRef = useRef<HTMLDivElement>(null);
  const latestFinal = transcript.finalSegments.at(-1)?.text ?? '';
  const caption = transcript.interim || latestFinal;
  const statusLabel = liveTranscriptStateLabel(transcript.state);
  const history = useMemo(() => transcript.finalSegments, [transcript.finalSegments]);

  useEffect(() => {
    if (historyOpen && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [historyOpen, history.length, transcript.interim]);

  return (
    <div className="live-transcript-overlay" data-history-open={historyOpen || undefined}>
      {historyOpen ? (
        <div
          ref={historyRef}
          className="live-transcript-history"
          id={historyId}
          role="region"
          aria-label="Transcript history"
          tabIndex={0}
        >
          {history.length === 0 && !transcript.interim ? (
            <p className="live-transcript-empty">Spoken captions will appear when the event starts.</p>
          ) : null}
          {history.map((segment) => (
            <p className="live-transcript-history-line" key={segment.id}>
              {segmentTime(segment.startMs) ? <time>{segmentTime(segment.startMs)}</time> : null}
              <span>{segment.text}</span>
            </p>
          ))}
          {transcript.interim ? <p className="live-transcript-history-line is-interim"><span>{transcript.interim}</span></p> : null}
        </div>
      ) : null}

      {transcript.suggestedProduct ? (
        <div className="live-transcript-suggestion" role="status">
          <button
            type="button"
            className="live-transcript-mention"
            onClick={() => transcript.stageProduct(transcript.suggestedProduct!.id)}
          >
            <span aria-hidden="true">✦</span>
            <span>Stage {transcript.suggestedProduct.label}</span>
            {transcript.suggestedProduct.price ? <strong>{transcript.suggestedProduct.price}</strong> : null}
          </button>
          <button type="button" className="live-transcript-dismiss" onClick={transcript.dismissSuggestion} aria-label="Dismiss product mention">×</button>
        </div>
      ) : null}

      <div className="live-transcript-caption-shell">
        <p className={`live-transcript-caption${transcript.interim ? ' is-interim' : ''}`} aria-live="polite" aria-atomic="true">
          {caption || statusLabel}
        </p>
        <div className="live-transcript-toolbar">
          <span className={`live-transcript-state state-${transcript.state}`}>
            <span aria-hidden="true" /> {statusLabel}
          </span>
          {transcript.activeProduct ? <span className="live-transcript-active">On stage: <strong>{transcript.activeProduct.label}</strong></span> : null}
          <button
            type="button"
            className="live-transcript-history-toggle"
            aria-controls={historyId}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((current) => !current)}
          >
            {historyOpen ? 'Close transcript' : 'Transcript'}
          </button>
        </div>
      </div>

      {transcript.error ? <p className="live-transcript-error" role="alert">{transcript.error}</p> : null}
    </div>
  );
}

export default LiveTranscriptOverlay;
