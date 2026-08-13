import { useEffect, useMemo, useState } from 'react';
import {
  createTranscriptionSession,
  type TranscriptSegment,
  type TranscriptionOptions,
  type TranscriptionSession,
  type TranscriptionState,
} from './transcription';

export interface TranscriptPaneProps extends Omit<TranscriptionOptions, 'speechRecognitionFactory' | 'webSocketFactory' | 'mediaRecorderFactory'> {
  session?: TranscriptionSession;
  autoStart?: boolean;
  className?: string;
}

function stateLabel(state: TranscriptionState): string {
  return state === 'listening' ? 'Listening' : state === 'connecting' ? 'Connecting…' : state === 'error' ? 'Needs attention' : 'Ready';
}

/** Seller-facing live transcript surface shared by Deepgram and Web Speech. */
export function TranscriptPane({ session, autoStart = false, className, ...options }: TranscriptPaneProps) {
  const managedSession = useMemo(
    () => session ?? createTranscriptionSession(options),
    [session, options.deepgramToken, options.deepgramTokenProvider, options.mediaStream, options.deepgramUrl, options.model, options.language],
  );
  const [state, setState] = useState<TranscriptionState>(managedSession.state);
  const [finalSegments, setFinalSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(managedSession.state);
    const removeSegment = managedSession.onSegment((segment) => {
      if (segment.isFinal) {
        setFinalSegments((current) => [...current, segment]);
        setInterim('');
      } else {
        setInterim(segment.text);
      }
    });
    const removeState = managedSession.onState(setState);
    const removeError = managedSession.onError((next) => setError(next.message));
    if (autoStart) void managedSession.start().catch((next) => setError(next instanceof Error ? next.message : String(next)));
    return () => {
      removeSegment();
      removeState();
      removeError();
      if (!session) void managedSession.stop();
    };
  }, [autoStart, managedSession, session]);

  const toggle = async () => {
    setError(null);
    if (state === 'listening' || state === 'connecting') await managedSession.stop();
    else await managedSession.start();
  };

  return (
    <section className={`transcript-pane${className ? ` ${className}` : ''}`} aria-label="Live transcript">
      <div className="transcript-pane-heading">
        <div>
          <p className="panel-kicker">Live transcript</p>
          <h3>What the room is saying</h3>
        </div>
        <span className={`transcript-state transcript-state-${state}`} aria-live="polite">
          <span aria-hidden="true" /> {stateLabel(state)} · {managedSession.provider === 'deepgram' ? 'Deepgram' : 'Browser'}
        </span>
      </div>
      <div className="transcript-body" aria-live="polite">
        {finalSegments.length === 0 && !interim ? <p className="muted">Start transcription to capture buyer questions and product mentions.</p> : null}
        {finalSegments.map((segment) => <p className="transcript-line" key={segment.id}>{segment.text}</p>)}
        {interim ? <p className="transcript-line transcript-interim">{interim}</p> : null}
      </div>
      {error ? <p className="transcript-error" role="alert">{error}</p> : null}
      <button className="button secondary" type="button" onClick={() => void toggle()}>
        {state === 'listening' || state === 'connecting' ? 'Stop transcription' : 'Start transcription'}
      </button>
    </section>
  );
}
