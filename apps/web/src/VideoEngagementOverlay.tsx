import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import {
  TranscriptOverlayView,
  type TranscriptOverlayPresentation,
  type TranscriptOverlaySegment,
} from './LiveTranscriptOverlay';
import './video-chat-overlay.css';
import './video-engagement-overlay.css';

export interface EventTranscriptMoment extends TranscriptOverlaySegment {
  endMs?: number;
  productId?: string;
  productTitle?: string;
}

export interface VideoEngagementOverlayProps {
  /** Omit when chat is presented in a dedicated room-context panel. */
  chat?: ReactNode;
  transcript: TranscriptOverlayPresentation;
  chatLabel?: string;
  defaultChatOpen?: boolean;
  chatOpen?: boolean;
  onChatOpenChange?: (open: boolean) => void;
  className?: string;
}

/** Convert the persisted seller feed into the same presentation used by live capture. */
export function remoteTranscriptPresentation(
  moments: readonly EventTranscriptMoment[],
  error?: unknown,
): TranscriptOverlayPresentation {
  const latestProduct = [...moments].reverse().find((moment) => moment.productId && moment.productTitle);
  const unavailable = Boolean(error) && moments.length === 0;
  return {
    state: unavailable ? 'error' : moments.length > 0 ? 'listening' : 'idle',
    segments: moments,
    error: unavailable ? 'The live transcript is temporarily unavailable.' : null,
    activeProduct: latestProduct ? {
      id: latestProduct.productId!,
      label: latestProduct.productTitle!,
    } : null,
    statusLabel: unavailable
      ? 'Transcript unavailable'
      : moments.length > 0
        ? 'Transcript live'
        : 'Waiting for captions',
    emptyLabel: 'Seller captions will appear here as the event unfolds.',
  };
}

export function scrollVideoEngagementChatToLatest(root: ParentNode | null): void {
  const messages = root?.querySelector<HTMLElement>('[data-video-chat-scroll]');
  if (messages) messages.scrollTop = messages.scrollHeight;
}

/** One video-owned surface for the transcript, its history, and Event Chat. */
export function VideoEngagementOverlay({
  chat,
  transcript,
  chatLabel = 'Chat',
  defaultChatOpen = true,
  chatOpen,
  onChatOpenChange,
  className,
}: VideoEngagementOverlayProps) {
  const [internalChatOpen, setInternalChatOpen] = useState(defaultChatOpen);
  const hasChat = chat !== undefined && chat !== null;
  const expanded = hasChat && (chatOpen ?? internalChatOpen);
  const chatId = useId();
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded) scrollVideoEngagementChatToLatest(chatRef.current);
  }, [expanded]);

  const setChatOpen = (next: boolean) => {
    if (chatOpen === undefined) setInternalChatOpen(next);
    onChatOpenChange?.(next);
  };

  return (
    <div
      className={`video-engagement-overlay${className ? ` ${className}` : ''}`}
      data-chat-open={expanded || undefined}
    >
      {hasChat ? (
        <div
          ref={chatRef}
          id={chatId}
          className="video-engagement-chat-panel"
          hidden={!expanded}
        >
          {chat}
        </div>
      ) : null}
      <TranscriptOverlayView
        transcript={transcript}
        toolbarActions={hasChat ? (
          <button
            type="button"
            className="video-engagement-chat-toggle"
            aria-controls={chatId}
            aria-expanded={expanded}
            onClick={() => setChatOpen(!expanded)}
          >
            {expanded ? `Hide ${chatLabel.toLocaleLowerCase()}` : chatLabel}
          </button>
        ) : undefined}
      />
    </div>
  );
}

export default VideoEngagementOverlay;
