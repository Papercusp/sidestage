import type { GuideEvent } from './api';

/**
 * Pure logic for the buyer "What's on" Channel Guide (P-118 / D-019).
 *
 * Kept out of the component so grouping and time copy can be tested as plain
 * functions against a fixed clock, rather than through a rendered drawer where
 * a wrong label and a wrong group look the same in the DOM.
 */

export type GuideGroupId = 'live' | 'scheduled' | 'ended';

export interface GuideGroup {
  id: GuideGroupId;
  /** The heading a buyer reads, fixed by D-019. */
  label: string;
  events: GuideEvent[];
}

/** Group order and copy are the ones the owner picked; not a runtime choice. */
const GROUP_ORDER: readonly { id: GuideGroupId; label: string }[] = [
  { id: 'live', label: 'Live now' },
  { id: 'scheduled', label: 'Up next' },
  { id: 'ended', label: 'Ended' },
];

/**
 * Split the API's already-ordered list into the three display groups.
 *
 * Relative order WITHIN a group is preserved from the server, which sorts live
 * rooms by viewer count and upcoming by soonest start — re-sorting here would
 * silently override a decision the API is better placed to make (it can see
 * live presence).
 *
 * Empty groups are dropped rather than rendered as bare headings: a heading
 * with nothing under it reads as a loading failure.
 */
export function groupGuideEvents(events: readonly GuideEvent[]): GuideGroup[] {
  return GROUP_ORDER.flatMap(({ id, label }) => {
    const matching = events.filter((event) => event.status === id);
    return matching.length > 0 ? [{ id, label, events: matching }] : [];
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function roundedUnits(ms: number, unit: number): number {
  return Math.max(1, Math.floor(ms / unit));
}

/**
 * "Starts in 2h" style copy for an upcoming event.
 *
 * Returns a bare "Scheduled" when there is no usable start time. An event can
 * legitimately be scheduled without one, and inventing a countdown from a null
 * would print "in NaN" — the failure mode this exists to avoid.
 */
export function formatStartLabel(startsAt: string | null, now: Date = new Date()): string {
  if (!startsAt) return 'Scheduled';
  const start = Date.parse(startsAt);
  if (Number.isNaN(start)) return 'Scheduled';

  const delta = start - now.getTime();
  // A scheduled event whose start has passed but which nobody has flipped to
  // live yet: say so plainly instead of counting up into negative numbers.
  if (delta <= 0) return 'Starting now';
  if (delta < MINUTE) return 'Starting now';
  if (delta < HOUR) return `Starts in ${roundedUnits(delta, MINUTE)}m`;
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    const minutes = Math.floor((delta % HOUR) / MINUTE);
    return minutes > 0 ? `Starts in ${hours}h ${minutes}m` : `Starts in ${hours}h`;
  }
  const days = roundedUnits(delta, DAY);
  return `Starts in ${days}d`;
}

/** "Ended 3h ago" style copy for a finished event's replay row. */
export function formatEndedLabel(endedAt: string | null, now: Date = new Date()): string {
  if (!endedAt) return 'Replay';
  const ended = Date.parse(endedAt);
  if (Number.isNaN(ended)) return 'Replay';

  const delta = now.getTime() - ended;
  if (delta < MINUTE) return 'Just ended';
  if (delta < HOUR) return `Ended ${roundedUnits(delta, MINUTE)}m ago`;
  if (delta < DAY) return `Ended ${roundedUnits(delta, HOUR)}h ago`;
  return `Ended ${roundedUnits(delta, DAY)}d ago`;
}

/** "1 watching" / "12 watching" — singular matters at the count buyers see most. */
export function formatViewers(viewers: number): string {
  const safe = Number.isFinite(viewers) && viewers > 0 ? Math.floor(viewers) : 0;
  return safe === 1 ? '1 watching' : `${safe} watching`;
}

/**
 * The secondary line for a row, chosen by group: viewers for a live room,
 * a countdown for an upcoming one, how long ago for a replay.
 */
export function rowMetaLabel(event: GuideEvent, now: Date = new Date()): string {
  if (event.status === 'live') return formatViewers(event.viewers);
  if (event.status === 'scheduled') return formatStartLabel(event.startsAt, now);
  return formatEndedLabel(event.endedAt, now);
}
