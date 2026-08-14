import { useId, useState, type ReactNode } from 'react';

import './video-chat-overlay.css';

export interface VideoChatOverlayProps {
  children: ReactNode;
  label?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
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
      <div id={panelId} className="video-chat-overlay-content" hidden={!expanded}>
        {children}
      </div>
    </div>
  );
}

