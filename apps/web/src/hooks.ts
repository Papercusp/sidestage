import { useEffect, useRef, useState } from 'react';

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
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    return () => {
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) void current.stop();
    };
  }, []);

  const start = async (
    connect: () => Promise<T>,
    options: { attach?: (session: T) => MediaStream | null; fallbackError: string },
  ) => {
    if (sessionRef.current || streamState === 'connecting') return;
    setStreamState('connecting');
    setStreamError(null);
    try {
      const next = await connect();
      sessionRef.current = next;
      setSession(next);
      setStreamState('live');
      const stream = options.attach?.(next) ?? null;
      if (videoRef.current && stream) videoRef.current.srcObject = stream;
    } catch (error) {
      setStreamState('error');
      setStreamError(error instanceof Error ? error.message : options.fallbackError);
    }
  };

  const stop = () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setStreamState('idle');
    if (videoRef.current) videoRef.current.srcObject = null;
    if (current) void current.stop();
  };

  return { streamState, setStreamState, streamError, setStreamError, session, sessionRef, videoRef, start, stop };
}
