import { useEffect, useRef } from 'react';
import { EventThumbnail } from '../event-creation/EventThumbnail';
import type { GuideEvent } from './api';
import { groupGuideEvents, rowMetaLabel } from './channel-guide';
import './channel-guide.css';

export interface ChannelGuideProps {
  open: boolean;
  onClose: () => void;
  events: readonly GuideEvent[];
  /** The event the buyer is currently watching — check-marked in the list. */
  currentEventId: string;
  onSelect: (eventId: string) => void;
  /** True while the first load is in flight, so empty ≠ "nothing is on". */
  loading?: boolean;
  /** Set when the directory could not be read at all. */
  error?: string | null;
  /** Injected by tests so time-relative copy is deterministic. */
  now?: Date;
}

/**
 * The "What's on" Channel Guide drawer (P-118 / D-019).
 *
 * Renders as an overlay panel: per D-019 the guide "steals no space from the
 * stream until opened", so it is absent from the layout entirely while closed
 * rather than collapsed to zero width — a zero-width flex child still
 * participates in sizing and would nudge the video.
 *
 * Every colour comes from the R3 :root tokens (D-004). No hex literal appears
 * in this component or its stylesheet.
 */
export function ChannelGuide({
  open,
  onClose,
  events,
  currentEventId,
  onSelect,
  loading = false,
  error = null,
  now,
}: ChannelGuideProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes. Bound while open only, so the buyer view does not carry a
  // key listener for a panel nobody opened.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Move focus into the panel when it opens so keyboard and screen-reader users
  // land inside the thing that just appeared instead of staying on the button
  // behind it.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const groups = groupGuideEvents(events);
  const clock = now ?? new Date();

  return (
    <div className="channel-guide-layer">
      {/* Scrim: clicking outside closes. aria-hidden because the close button
          below is the accessible way out; a labelled backdrop would announce a
          second, redundant control. */}
      <div className="channel-guide-scrim" onClick={onClose} aria-hidden="true" />

      <div
        className="channel-guide-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="What's on"
      >
        <header className="channel-guide-header">
          <div>
            <p className="channel-guide-eyebrow">What&rsquo;s on</p>
            <h2 className="channel-guide-title">Every live room</h2>
          </div>
          <button
            type="button"
            className="channel-guide-close"
            onClick={onClose}
            ref={closeRef}
            aria-label="Close what's on"
          >
            ✕
          </button>
        </header>

        <div className="channel-guide-body">
          {loading ? <p className="channel-guide-note">Loading events…</p> : null}

          {/* An unreadable directory is stated as such. Falling through to the
              empty state would tell the buyer "nothing is on", which is a
              confident wrong answer to a question we could not ask. */}
          {!loading && error ? (
            <p className="channel-guide-note channel-guide-note-error">{error}</p>
          ) : null}

          {!loading && !error && groups.length === 0 ? (
            <p className="channel-guide-note">No events scheduled yet.</p>
          ) : null}

          {!loading && !error
            ? groups.map((group) => (
                <section className="channel-guide-group" key={group.id}>
                  <h3 className={`channel-guide-group-label channel-guide-group-${group.id}`}>
                    {group.id === 'live' ? <span className="channel-guide-live-dot" aria-hidden="true" /> : null}
                    {group.label}
                    <span className="channel-guide-group-count">{group.events.length}</span>
                  </h3>

                  <ul className="channel-guide-list">
                    {group.events.map((event) => {
                      const current = event.eventId === currentEventId;
                      return (
                        <li key={event.eventId}>
                          <button
                            type="button"
                            className={`channel-guide-row${current ? ' is-current' : ''}`}
                            onClick={() => onSelect(event.eventId)}
                            aria-current={current ? 'true' : undefined}
                          >
                            <EventThumbnail
                              url={event.thumbnailUrl}
                              eventName={event.title}
                              className="channel-guide-thumb"
                            />
                            <span className="channel-guide-row-text">
                              <span className="channel-guide-row-title">{event.title}</span>
                              <span className="channel-guide-row-seller">{event.sellerName}</span>
                              <span className={`channel-guide-row-meta channel-guide-meta-${event.status}`}>
                                {rowMetaLabel(event, clock)}
                              </span>
                            </span>
                            {current ? (
                              <span className="channel-guide-check" aria-label="Currently watching">
                                ✓
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}

export default ChannelGuide;
