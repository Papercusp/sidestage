import { useCallback, useEffect, useRef, useState } from 'react';

export type StreamState = 'idle' | 'connecting' | 'live' | 'error';

export function streamLabel(state: StreamState): string {
  return state === 'live'
    ? 'Live now'
    : state === 'connecting'
      ? 'Connecting…'
      : state === 'error'
        ? 'Stream unavailable'
        : 'Preview ready';
}

export interface StreamSessionLike {
  stop(): void | Promise<void>;
}

/**
 * What one `start` attempt did, so a caller can decide whether to try again
 * (WI-39733). The hook still owns the state and the message — this only tells
 * the caller which of the four things happened, because "the connect failed"
 * and "the connect failed because the seller is not publishing yet" need
 * different behaviour and the second is indistinguishable from the first once
 * the error has been flattened into `streamError` text.
 */
export type StreamStartOutcome =
  | { readonly status: 'connected' }
  /** A session was already live or a connect was already in flight. */
  | { readonly status: 'busy' }
  /** A newer attempt replaced this one; this attempt's session was discarded. */
  | { readonly status: 'superseded' }
  | { readonly status: 'failed'; readonly error: unknown };

/**
 * The publisher/viewer session lifecycle both tabs used to hand-roll (P-104):
 * connect-once guard, error capture, video element attachment, and teardown.
 * The caller supplies the connect function; `attach` returns the MediaStream
 * to bind to the video element (or null to manage it via callbacks).
 */
export function useStreamSession<T extends StreamSessionLike>() {
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [session, setSession] = useState<T | null>(null);
  const sessionRef = useRef<T | null>(null);
  const connectionAttemptRef = useRef(0);
  const connectingRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    return () => {
      connectionAttemptRef.current += 1;
      connectingRef.current = false;
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) void current.stop();
    };
  }, []);

  const start = useCallback(async (
    connect: () => Promise<T>,
    options: { attach?: (session: T) => MediaStream | null; fallbackError: string },
  ): Promise<StreamStartOutcome> => {
    if (sessionRef.current || connectingRef.current) return { status: 'busy' };
    const attempt = connectionAttemptRef.current + 1;
    connectionAttemptRef.current = attempt;
    connectingRef.current = true;
    setStreamState('connecting');
    setStreamError(null);
    try {
      const next = await connect();
      if (connectionAttemptRef.current !== attempt) {
        try {
          await next.stop();
        } catch {
          // A superseded room is already detached; cleanup is best-effort.
        }
        return;
      }
      connectingRef.current = false;
      sessionRef.current = next;
      setSession(next);
      setStreamState('live');
      const stream = options.attach?.(next) ?? null;
      if (videoRef.current && stream) videoRef.current.srcObject = stream;
    } catch (error) {
      if (connectionAttemptRef.current !== attempt) return;
      connectingRef.current = false;
      setStreamState('error');
      setStreamError(error instanceof Error ? error.message : options.fallbackError);
    }
  }, []);

  const stop = useCallback(() => {
    connectionAttemptRef.current += 1;
    connectingRef.current = false;
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setStreamState('idle');
    if (videoRef.current) videoRef.current.srcObject = null;
    if (current) void current.stop();
  }, []);

  return { streamState, setStreamState, streamError, setStreamError, session, sessionRef, videoRef, start, stop };
}
