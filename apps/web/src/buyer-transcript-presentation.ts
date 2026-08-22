import type {
  TranscriptOverlayPresentation,
  TranscriptOverlaySegment,
} from './LiveTranscriptOverlay';

export interface EventTranscriptMoment extends TranscriptOverlaySegment {
  endMs?: number;
  productId?: string;
  productTitle?: string;
}

export interface RemoteTranscriptInputs {
  /** Captions may call themselves live only while their video is live too. */
  videoLive: boolean;
  error?: unknown;
  loading?: boolean;
}

/**
 * Convert persisted seller moments into the role-neutral transcript shape.
 * This module deliberately has no React/CSS runtime, so an idle buyer need not
 * download the visual transcript/history surface just to derive hidden state.
 */
export function remoteTranscriptPresentation(
  moments: readonly EventTranscriptMoment[],
  { videoLive, error, loading = false }: RemoteTranscriptInputs,
): TranscriptOverlayPresentation {
  const latestProduct = [...moments].reverse().find((moment) => moment.productId && moment.productTitle);
  const unavailable = !loading && Boolean(error) && moments.length === 0;
  const hasCaptions = moments.length > 0;
  const live = hasCaptions && videoLive;
  return {
    state: unavailable ? 'error' : live ? 'listening' : 'idle',
    segments: moments,
    error: unavailable ? 'The live transcript is temporarily unavailable.' : null,
    activeProduct: latestProduct ? {
      id: latestProduct.productId!,
      label: latestProduct.productTitle!,
      live,
    } : null,
    statusLabel: unavailable
      ? 'Transcript unavailable'
      : live
        ? 'Transcript live'
        : hasCaptions
          ? 'Captions from earlier in this event'
          : 'Waiting for captions',
    emptyLabel: 'Seller captions will appear here as the event unfolds.',
  };
}

export interface TranscriptErrorState {
  streak: number;
  confirmed: Error | null;
}

/** Require two consecutive poll failures before showing transcript downtime. */
export function nextTranscriptErrorState(prevStreak: number, error: unknown): TranscriptErrorState {
  if (!error) return { streak: 0, confirmed: null };
  const streak = prevStreak + 1;
  const err = error instanceof Error ? error : new Error(String(error));
  return { streak, confirmed: streak >= 2 ? err : null };
}
