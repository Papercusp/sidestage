import { Inject, Injectable } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';

/**
 * The event directory behind the buyer "What's on" Channel Guide (P-118 /
 * D-019).
 *
 * This is deliberately separate from EventConfigService: config answers "what
 * are THIS event's copilot settings", keyed by an id the caller already has.
 * The guide asks the question nothing could answer before — "which events
 * exist at all, across every seller" — so it reads its own table rather than
 * trying to enumerate a keyed config store.
 */

/**
 * The seller-controlled lifecycle. Same four names the web already uses
 * (EventStatus in apps/web/src/events/events.ts) so the two sides of the wire
 * do not maintain two vocabularies for one concept.
 */
export type EventStatus = 'draft' | 'scheduled' | 'live' | 'ended';

/** The buyer-visible states, in the order the guide groups them. */
export const BUYER_VISIBLE_STATUSES: readonly EventStatus[] = ['live', 'scheduled', 'ended'];

export function isEventStatus(value: unknown): value is EventStatus {
  return value === 'draft' || value === 'scheduled' || value === 'live' || value === 'ended';
}

/** A directory row as stored — no viewer count, which is never persisted. */
export interface EventRecord {
  eventId: string;
  title: string;
  sellerId: string;
  sellerName: string;
  status: EventStatus;
  /** ISO-8601, or null for a draft that has never been scheduled. */
  startsAt: string | null;
  endedAt: string | null;
  thumbnailUrl?: string;
}

/** A directory row as served: the record plus its LIVE viewer count. */
export interface EventSummary extends EventRecord {
  viewers: number;
}

export interface EventStore {
  /**
   * Every event a buyer may see, i.e. everything except `draft`. The filter
   * lives HERE, at the read, rather than in the client: an unpublished event
   * must not travel over the wire at all, and a client-side filter would ship
   * it to the browser and merely decline to paint it.
   */
  listBuyerVisible(): Promise<EventRecord[]>;
}

export const EVENT_STORE = Symbol('EVENT_STORE');

/**
 * The no-Postgres fallback, matching the store seams elsewhere in this API
 * (cart, orders, auction inventory). A clean clone with no Docker still gets a
 * populated Channel Guide instead of an empty drawer that looks like a bug.
 *
 * These mirror db/seed/demo.sql. The offsets are relative to process start for
 * the same reason the seed uses `now() + interval`: fixed timestamps rot into
 * the past and silently empty the "Up next" group.
 */
export function demoEventRecords(now: Date = new Date()): EventRecord[] {
  const at = (minutes: number): string => new Date(now.getTime() + minutes * 60_000).toISOString();
  return [
    {
      eventId: 'sunday-drop',
      title: 'Sunday vintage drop',
      sellerId: 'seller-marsh',
      sellerName: 'Marsh & Co Vintage',
      status: 'live',
      startsAt: at(-35),
      endedAt: null,
      thumbnailUrl: 'https://placehold.co/400x400/D62B1F/FFF8EF/png?text=Vintage',
    },
    {
      eventId: 'midnight-sneaker-vault',
      title: 'Midnight sneaker vault',
      sellerId: 'seller-sole',
      sellerName: 'Sole Provisions',
      status: 'live',
      startsAt: at(-12),
      endedAt: null,
      thumbnailUrl: 'https://placehold.co/400x400/2A1F1A/FFC400/png?text=Sneakers',
    },
    {
      eventId: 'estate-jewels-hour',
      title: 'Estate jewels hour',
      sellerId: 'seller-ashgrove',
      sellerName: 'Ashgrove Estate',
      status: 'live',
      startsAt: at(-80),
      endedAt: null,
      thumbnailUrl: 'https://placehold.co/400x400/8A7A6C/FFF8EF/png?text=Jewels',
    },
    {
      eventId: 'tuesday-tool-run',
      title: 'Tuesday tool run',
      sellerId: 'seller-ironbark',
      sellerName: 'Ironbark Supply',
      status: 'scheduled',
      startsAt: at(120),
      endedAt: null,
      thumbnailUrl: 'https://placehold.co/400x400/A66A00/FFF8EF/png?text=Tools',
    },
    {
      eventId: 'denim-archive-drop',
      title: 'Denim archive drop',
      sellerId: 'seller-blueloom',
      sellerName: 'Blue Loom Archive',
      status: 'scheduled',
      startsAt: at(360),
      endedAt: null,
      thumbnailUrl: 'https://placehold.co/400x400/1E7F4F/FFF8EF/png?text=Denim',
    },
    {
      eventId: 'weekend-ceramics',
      title: 'Weekend ceramics studio sale',
      sellerId: 'seller-kiln',
      sellerName: 'Kiln & Coast',
      status: 'scheduled',
      startsAt: at(2880),
      endedAt: null,
      thumbnailUrl: 'https://placehold.co/400x400/E8D3BC/2A1F1A/png?text=Ceramics',
    },
    {
      eventId: 'friday-flash-audio',
      title: 'Friday flash: hi-fi audio',
      sellerId: 'seller-northstar',
      sellerName: 'Northstar Audio',
      status: 'ended',
      startsAt: at(-19 * 60),
      endedAt: at(-18 * 60),
      thumbnailUrl: 'https://placehold.co/400x400/2A1F1A/FFF8EF/png?text=Audio',
    },
    {
      eventId: 'warehouse-clearout',
      title: 'Warehouse clear-out marathon',
      sellerId: 'seller-restart',
      sellerName: 'Restart Outfitters',
      status: 'ended',
      startsAt: at(-(3 * 24 * 60 + 120)),
      endedAt: at(-3 * 24 * 60),
      thumbnailUrl: 'https://placehold.co/400x400/C2271C/FFF8EF/png?text=Clearout',
    },
  ];
}

export class InMemoryEventStore implements EventStore {
  constructor(private readonly records: EventRecord[] = demoEventRecords()) {}

  async listBuyerVisible(): Promise<EventRecord[]> {
    return this.records.filter((record) => record.status !== 'draft');
  }
}

/**
 * Group order for the guide: Live now, then Up next, then Ended.
 * Exported so the ordering is testable without a store or a Nest context.
 */
export function statusRank(status: EventStatus): number {
  if (status === 'live') return 0;
  if (status === 'scheduled') return 1;
  return 2;
}

function timeValue(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Sort within the guide.
 *
 * Live events sort by VIEWER COUNT descending — a channel guide's whole job is
 * to point at the busiest room first, and viewers is the only signal here that
 * reflects what is actually happening right now. Upcoming sorts by soonest
 * start, ended by most recently finished. Title breaks every tie so the order
 * is stable across reads rather than shifting with whatever the database
 * happened to return.
 */
export function compareForGuide(a: EventSummary, b: EventSummary): number {
  const byStatus = statusRank(a.status) - statusRank(b.status);
  if (byStatus !== 0) return byStatus;

  if (a.status === 'live') {
    const byViewers = b.viewers - a.viewers;
    if (byViewers !== 0) return byViewers;
  } else if (a.status === 'scheduled') {
    const left = timeValue(a.startsAt);
    const right = timeValue(b.startsAt);
    // A scheduled event with no start time sorts after those that have one:
    // "sometime" is less useful to a buyer than "in two hours".
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right;
    }
  } else {
    const left = timeValue(a.endedAt);
    const right = timeValue(b.endedAt);
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    }
  }

  return a.title.localeCompare(b.title);
}

@Injectable()
export class EventService {
  constructor(
    @Inject(EVENT_STORE) private readonly store: EventStore,
    @Inject(ChatService) private readonly chat: ChatService,
  ) {}

  /**
   * The Channel Guide payload.
   *
   * Viewer counts are read per event from live chat presence — the same source
   * /events/:eventId/stats already uses — rather than from a stored column, so
   * the guide can never show a count that outlived the viewers it counted.
   */
  async listForGuide(): Promise<EventSummary[]> {
    const records = await this.store.listBuyerVisible();
    const summaries = records.map((record) => ({
      ...record,
      // Only a live room can have anyone in it; reporting presence for an
      // ended event would be reporting whoever is idling on its replay page.
      viewers: record.status === 'live' ? this.chat.getStats(record.eventId).activeUsers : 0,
    }));
    return summaries.sort(compareForGuide);
  }
}
