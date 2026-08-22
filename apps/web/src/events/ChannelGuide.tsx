import { useEffect, useState } from 'react';
import { EventThumbnail } from '../event-creation/EventThumbnail';
import { eventWatchHref } from '../app-routing';
import type { GuideEvent } from './api';
import {
  formatScheduledStartTime,
  groupGuideEvents,
  rowMetaLabel,
} from './channel-guide';
import {
  ChannelGuideActiveNow,
  channelGuideActiveNowRowClass,
} from './ChannelGuideActiveNow';
import './channel-guide.css';

export interface ChannelGuideProps {
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

/** One clock drives every row; N upcoming events never create N timers. */
function useGuideClock(fixedNow?: Date): Date {
  const [clock, setClock] = useState(() => fixedNow ?? new Date());

  useEffect(() => {
    if (fixedNow) return undefined;
    const timer = globalThis.setInterval(() => setClock(new Date()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, [fixedNow]);

  return fixedNow ?? clock;
}

/**
 * The persistent "What's on" Channel Guide sidebar (P-118 / D-019).
 *
 * The guide is the leftmost child of the shared app grid, so it stays mounted
 * across every page, always occupies layout space, and never obscures content.
 * At narrow widths the grid stacks this landmark rather than restoring a drawer.
 *
 * Every colour comes from the R3 :root tokens (D-004). No hex literal appears
 * in this component or its stylesheet.
 */
export function ChannelGuide({
  events,
  currentEventId,
  onSelect,
  loading = false,
  error = null,
  now,
}: ChannelGuideProps) {
  const groups = groupGuideEvents(events);
  const clock = useGuideClock(now);

  return (
    <aside className="channel-guide-panel" aria-labelledby="channel-guide-title">
      <header className="channel-guide-header">
        <div>
          <p className="channel-guide-eyebrow">What&rsquo;s on</p>
          <h2 className="channel-guide-title" id="channel-guide-title">Every live room</h2>
        </div>
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
                      const metaLabel = rowMetaLabel(event, clock);
                      const exactStart = event.status === 'scheduled'
                        ? formatScheduledStartTime(event.startsAt)
                        : null;
                      return (
                        <li key={event.eventId}>
                          <a
                            href={eventWatchHref(
                              event.eventId,
                              typeof window === 'undefined' ? '/' : window.location.href,
                            )}
                            className={`channel-guide-row${channelGuideActiveNowRowClass(event.status)}${current ? ' is-current' : ''}`}
                            onClick={(click) => {
                              if (
                                click.button !== 0
                                || click.metaKey
                                || click.ctrlKey
                                || click.shiftKey
                                || click.altKey
                              ) return;
                              click.preventDefault();
                              onSelect(event.eventId);
                            }}
                            aria-current={current ? 'true' : undefined}
                          >
                            <EventThumbnail
                              url={event.thumbnailUrl}
                              eventName={event.title}
                              className="channel-guide-thumb"
                              loading="lazy"
                            />
                            <span className="channel-guide-row-text">
                              <span className="channel-guide-row-title">{event.title}</span>
                              <span className="channel-guide-row-seller">{event.sellerName}</span>
                              <span className={`channel-guide-row-meta channel-guide-meta-${event.status}`}>
                                {event.status === 'live' ? (
                                  <ChannelGuideActiveNow watchingLabel={metaLabel} />
                                ) : exactStart && event.startsAt ? (
                                  <time
                                    dateTime={event.startsAt}
                                    title={`Scheduled for ${exactStart}`}
                                    aria-label={`Scheduled for ${exactStart}. ${metaLabel}`}
                                  >
                                    {metaLabel}
                                    <span className="channel-guide-start-exact" aria-hidden="true">
                                      {' · '}{exactStart}
                                    </span>
                                  </time>
                                ) : metaLabel}
                              </span>
                            </span>
                            {current ? (
                              <span className="channel-guide-check" aria-label="Currently watching">
                                ✓
                              </span>
                            ) : null}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            : null}
      </div>
    </aside>
  );
}

export default ChannelGuide;
