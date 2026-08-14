import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import './video-chat-overlay.css';

export interface VideoChatOverlayProps {
  children: ReactNode;
  label?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function scrollVideoChatToLatest(root: ParentNode | null): void {
  const messages = root?.querySelector<HTMLElement>('[data-video-chat-scroll]');
  if (messages) messages.scrollTop = messages.scrollHeight;
}

/** Compact, accessible chat anchored inside a video frame. */
export function VideoChatOverlay({
  children,
  label = 'Live chat',
  defaultOpen = true,
  open,
  onOpenChange,
  className,
}: VideoChatOverlayProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const expanded = open ?? internalOpen;
  const panelId = useId();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded) scrollVideoChatToLatest(contentRef.current);
  }, [expanded]);

  const setOpen = (next: boolean) => {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className={`video-chat-overlay${className ? ` ${className}` : ''}`} data-open={expanded || undefined}>
      <button
        type="button"
        className="video-chat-overlay-toggle"
        aria-controls={panelId}
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
      >
        <span aria-hidden="true">{expanded ? '×' : '⌁'}</span>
        {expanded ? `Hide ${label}` : label}
      </button>
      <div ref={contentRef} id={panelId} className="video-chat-overlay-content" hidden={!expanded}>
        {children}
      </div>
    </div>
  );
}
