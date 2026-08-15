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

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function roundedUnits(ms: number, unit: number): number {
  return Math.max(1, Math.floor(ms / unit));
}

/**
 * Live, second-resolution countdown copy for an upcoming event.
 *
 * Returns "Schedule pending" when there is no usable start time. An event can
 * legitimately be scheduled without one, and inventing a countdown from a null
 * would print "in NaN" — the failure mode this exists to avoid.
 */
export function formatStartLabel(startsAt: string | null, now: Date = new Date()): string {
  if (!startsAt) return 'Schedule pending';
  const start = Date.parse(startsAt);
  if (Number.isNaN(start)) return 'Schedule pending';

  const delta = start - now.getTime();
  // A scheduled event whose start has passed but which nobody has flipped to
  // live yet: say so plainly instead of counting up into negative numbers.
  if (delta <= 0) return 'Starting now';

  // ceil keeps a sub-second positive remainder at 1s instead of announcing
  // "Starting now" before the scheduled instant has actually arrived.
  const totalSeconds = Math.max(1, Math.ceil(delta / SECOND));
  const days = Math.floor(totalSeconds / (DAY / SECOND));
  const hours = Math.floor((totalSeconds % (DAY / SECOND)) / (HOUR / SECOND));
  const minutes = Math.floor((totalSeconds % (HOUR / SECOND)) / (MINUTE / SECOND));
  const seconds = totalSeconds % (MINUTE / SECOND);

  if (days > 0) return `Starts in ${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `Starts in ${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `Starts in ${minutes}m ${seconds}s`;
  return `Starts in ${seconds}s`;
}

/** Exact local start time shown beside the relative countdown. */
export function formatScheduledStartTime(
  startsAt: string | null,
  locales?: Intl.LocalesArgument,
  timeZone?: string,
): string | null {
  if (!startsAt) return null;
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return null;
  return new Intl.DateTimeFormat(locales, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(start);
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
