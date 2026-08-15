import { useCallback, useEffect, useRef, useState } from 'react';

/** The three states a "Share room" copy control can be in (P-104). */
export type CopyState = 'idle' | 'copied' | 'failed';

/** Copy-to-clipboard button state, shared by every "Share room" control (P-104). */
export function useCopyState(resetMs = 1800) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const copy = async (text: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    globalThis.setTimeout(() => setCopyState('idle'), resetMs);
  };
  return { copyState, copy };
}

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
  ) => {
    if (sessionRef.current || connectingRef.current) return;
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
