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

/** Legacy acceptance identity that must never be mistaken for seller data. */
export function isSyntheticSellerIdentity(
  seller: { sellerId: string; sellerName: string },
): boolean {
  return seller.sellerId.trim().toLowerCase() === 'demo-seller'
    || seller.sellerName.trim().toLowerCase() === 'sidestage seller';
}

export function isEventStatus(value: unknown): value is EventStatus {
  return value === 'draft' || value === 'scheduled' || value === 'live' || value === 'ended';
}

/* ── The seller lifecycle: schedule / go live / end (D-002, D-003) ─────────── */

/**
 * What a seller can DO to an event's lifecycle.
 *
 * Withdrawing an event is deliberately absent: that is `unpublish`, which
 * already exists as DELETE /events/:eventId and means something different
 * (leave every event-scoped record intact, drop out of buyer reads).
 */
export type EventLifecycleAction = 'schedule' | 'go-live' | 'end';

export function isEventLifecycleAction(value: unknown): value is EventLifecycleAction {
  return value === 'schedule' || value === 'go-live' || value === 'end';
}

/** The three columns a transition may move, and nothing else. */
export interface EventLifecycleState {
  status: EventStatus;
  startsAt: string | null;
  endedAt: string | null;
}

export type EventLifecycleOutcome =
  | { ok: true; next: EventLifecycleState }
  | { ok: false; reason: string };

/** Accept any parseable instant; normalize to ISO-8601 UTC, else null. */
function normalizedInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * The single authority on which lifecycle transitions are legal, and on what
 * each one does to `status` / `starts_at` / `ended_at` (D-002).
 *
 * PURE, and deliberately not a method on either store. Both the in-memory and
 * the Postgres backend apply a state this function already resolved, instead
 * of each re-deciding the same table: two implementations of one rule is how
 * the backends drift, and such drift surfaces only on whichever backend the
 * tests do not exercise. It also means the refusal messages — the only thing
 * the seller actually reads when a button will not work — are written once.
 *
 * `now` is injectable so the timestamps a transition stamps are assertable
 * rather than merely "recent".
 */
export function resolveLifecycleTransition(
  current: EventLifecycleState,
  action: EventLifecycleAction,
  input: { startsAt?: unknown; now?: Date } = {},
): EventLifecycleOutcome {
  const nowIso = (input.now ?? new Date()).toISOString();

  if (action === 'schedule') {
    // Rescheduling a room that is ON AIR would move the clock under an
    // audience already watching it. Ending it first is one extra click and an
    // unambiguous one.
    if (current.status === 'live') {
      return { ok: false, reason: 'End the live event before rescheduling it.' };
    }
    const startsAt = normalizedInstant(input.startsAt);
    if (!startsAt) {
      return { ok: false, reason: 'A valid ISO-8601 start time is required to schedule an event.' };
    }
    // A past start time is allowed on purpose: with the auto-go-live sweep
    // (D-003) that reads as "start it now", which is a real thing to want.
    return { ok: true, next: { status: 'scheduled', startsAt, endedAt: null } };
  }

  if (action === 'go-live') {
    // Idempotent, because a seller double-clicking "Go live" on a room that is
    // already live must not be an error — and must not restamp its start time.
    if (current.status === 'live') return { ok: true, next: { ...current } };
    return {
      ok: true,
      next: {
        status: 'live',
        // Re-running an ENDED show is a NEW run: carrying the finished run's
        // start time forward would report the room as hours old at the instant
        // it opens. Otherwise honour a start time already scheduled, so the
        // guide's countdown and the room's clock agree.
        startsAt: current.status === 'ended' ? nowIso : current.startsAt ?? nowIso,
        endedAt: null,
      },
    };
  }

  if (current.status === 'ended') return { ok: true, next: { ...current } };
  if (current.status !== 'live') {
    return {
      ok: false,
      reason: 'Only a live event can be ended. Unpublish it instead to withdraw it before it airs.',
    };
  }
  return { ok: true, next: { status: 'ended', startsAt: current.startsAt, endedAt: nowIso } };
}

/** The lifecycle fields of a stored record, for the resolver above. */
export function lifecycleStateOf(record: EventLifecycleState): EventLifecycleState {
  return { status: record.status, startsAt: record.startsAt, endedAt: record.endedAt };
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

/** What the seller's create/update flow publishes into the directory. */
export interface EventPublication {
  eventId: string;
  title: string;
  sellerId: string;
  sellerName: string;
  thumbnailUrl?: string;
}

export interface EventStore {
  /**
   * Every event a buyer may see, i.e. everything except `draft`. The filter
   * lives HERE, at the read, rather than in the client: an unpublished event
   * must not travel over the wire at all, and a client-side filter would ship
   * it to the browser and merely decline to paint it.
   */
  listBuyerVisible(): Promise<EventRecord[]>;

  /** Every event owned by one seller, including unpublished drafts. */
  listBySeller(sellerId: string): Promise<EventRecord[]>;

  /** Internal owner-oracle lookup; never exposed as a public directory read. */
  findById(eventId: string): Promise<EventRecord | undefined>;

  /** Atomic non-enumerating lookup for one seller-owned event. */
  findOwned(eventId: string, sellerId: string): Promise<EventRecord | undefined>;

  /**
   * Upsert the directory row for a seller-created event (EI-20426845001666103
   * / P-014): before this existed, the UI create flow wrote event_config and
   * registered items but NOTHING ever inserted the directory row, so a created
   * event was reachable by direct link yet invisible in the Channel Guide —
   * GET /events stayed [] forever on a database without the demo seed.
   *
   * Semantics: a NEW event is inserted `scheduled` (buyer-visible — the UI
   * create flow IS the publish act; inserting the table's `draft` default
   * would reproduce the exact invisibility this method exists to fix). An
   * EXISTING row only has its title/seller/thumbnail updated — status,
   * starts_at and ended_at are deliberately preserved so a rename or a
   * thumbnail swap on a live or ended event never resets its lifecycle.
   */
  publish(input: EventPublication): Promise<boolean>;

  /**
   * Remove one seller-owned event from every buyer read without destroying
   * its config, audit, chat, or commerce history. The operation is idempotent:
   * an already-draft row still counts as found, while another seller's row is
   * indistinguishable from a missing one.
   */
  unpublish(eventId: string, sellerId: string): Promise<boolean>;

  /**
   * Write an ALREADY-RESOLVED lifecycle state onto one seller-owned row, and
   * return the row as stored.
   *
   * The store does not decide legality — `resolveLifecycleTransition` does, and
   * the caller has already run it. Ownership is still enforced here: a foreign
   * or absent id returns undefined, the same non-enumerating collapse the rest
   * of this contract uses.
   */
  applyLifecycle(
    eventId: string,
    sellerId: string,
    next: EventLifecycleState,
  ): Promise<EventRecord | undefined>;

  /**
   * Flip every `scheduled` row whose start time has already passed to `live`
   * (D-003), returning the rows that moved. Runs as one statement per sweep,
   * for every seller at once — the sweep has no seller principal because no
   * seller is present when a scheduled show is due.
   */
  activateDueScheduled(now: Date): Promise<EventRecord[]>;
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
      // Owned by the seed seller: the Studio prefills this room id, and an
      // anonymous visitor resolves to demo-seller (buyer-identity.ts) — an
      // owner mismatch here 404s every Studio pane on the no-Docker path.
      sellerId: 'demo-seller',
      sellerName: 'Demo Seller',
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

  async listBySeller(sellerId: string): Promise<EventRecord[]> {
    return this.records.filter((record) => record.sellerId === sellerId);
  }

  async findById(eventId: string): Promise<EventRecord | undefined> {
    return this.records.find((record) => record.eventId === eventId);
  }

  async findOwned(eventId: string, sellerId: string): Promise<EventRecord | undefined> {
    return this.records.find(
      (record) => record.eventId === eventId && record.sellerId === sellerId,
    );
  }

  async publish(input: EventPublication): Promise<boolean> {
    const existing = this.records.find((record) => record.eventId === input.eventId);
    if (existing) {
      if (existing.sellerId !== input.sellerId) return false;
      existing.title = input.title;
      existing.sellerName = input.sellerName;
      if (input.thumbnailUrl) {
        existing.thumbnailUrl = input.thumbnailUrl;
      } else {
        delete existing.thumbnailUrl;
      }
      // A seller can publish a previously withdrawn draft again. Other
      // lifecycle states remain untouched on ordinary config saves.
      if (existing.status === 'draft') existing.status = 'scheduled';
      return true;
    }
    this.records.push({
      eventId: input.eventId,
      title: input.title,
      sellerId: input.sellerId,
      sellerName: input.sellerName,
      status: 'scheduled',
      startsAt: null,
      endedAt: null,
      ...(input.thumbnailUrl ? { thumbnailUrl: input.thumbnailUrl } : {}),
    });
    return true;
  }

  async unpublish(eventId: string, sellerId: string): Promise<boolean> {
    const existing = this.records.find(
      (record) => record.eventId === eventId && record.sellerId === sellerId,
    );
    if (!existing) return false;
    existing.status = 'draft';
    existing.startsAt = null;
    existing.endedAt = null;
    return true;
  }

  async applyLifecycle(
    eventId: string,
    sellerId: string,
    next: EventLifecycleState,
  ): Promise<EventRecord | undefined> {
    const existing = this.records.find(
      (record) => record.eventId === eventId && record.sellerId === sellerId,
    );
    if (!existing) return undefined;
    existing.status = next.status;
    existing.startsAt = next.startsAt;
    existing.endedAt = next.endedAt;
    return { ...existing };
  }

  async activateDueScheduled(now: Date): Promise<EventRecord[]> {
    const due = this.records.filter((record) => (
      record.status === 'scheduled'
        && record.startsAt !== null
        && Date.parse(record.startsAt) <= now.getTime()
    ));
    for (const record of due) {
      record.status = 'live';
      record.endedAt = null;
    }
    return due.map((record) => ({ ...record }));
  }
}

/** Production no-source state: fail honestly instead of publishing demo events. */
export class UnavailableEventStore implements EventStore {
  private unavailable(): never {
    throw new Error('Event data source unavailable: durable event storage is not connected.');
  }

  async listBuyerVisible(): Promise<EventRecord[]> {
    return this.unavailable();
  }

  async listBySeller(): Promise<EventRecord[]> {
    return this.unavailable();
  }

  async findById(): Promise<EventRecord | undefined> {
    return this.unavailable();
  }

  async findOwned(): Promise<EventRecord | undefined> {
    return this.unavailable();
  }

  async publish(): Promise<boolean> {
    return this.unavailable();
  }

  async unpublish(): Promise<boolean> {
    return this.unavailable();
  }

  async applyLifecycle(): Promise<EventRecord | undefined> {
    return this.unavailable();
  }

  async activateDueScheduled(): Promise<EventRecord[]> {
    return this.unavailable();
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

/** Seller workspace order: current work, upcoming work, drafts, then history. */
export function sellerStatusRank(status: EventStatus): number {
  if (status === 'live') return 0;
  if (status === 'scheduled') return 1;
  if (status === 'draft') return 2;
  return 3;
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

/** Stable lifecycle-first ordering for the seller-owned event directory. */
export function compareForSeller(a: EventRecord, b: EventRecord): number {
  const byStatus = sellerStatusRank(a.status) - sellerStatusRank(b.status);
  if (byStatus !== 0) return byStatus;

  if (a.status === 'scheduled') {
    const left = timeValue(a.startsAt);
    const right = timeValue(b.startsAt);
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right;
    }
  } else if (a.status === 'ended') {
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

export interface EventSellerIdentity {
  sellerId: string;
  sellerName: string;
}

@Injectable()
export class EventService {
  constructor(
    @Inject(EVENT_STORE) private readonly store: EventStore,
    @Inject(ChatService) private readonly chat: ChatService,
  ) {}

  /**
   * Publish/refresh the directory row for a seller-created event, from its
   * saved config (EI-20426845001666103 / P-014). Called by the config PUT —
   * the single entry the UI create flow already goes through — so one UI
   * create transaction yields a buyer-visible Channel Guide row with the
   * uploaded thumbnail.
   */
  async publishFromConfig(
    config: { eventId: string; name: string; thumbnailUrl?: string },
    seller: EventSellerIdentity,
  ): Promise<boolean> {
    const sellerId = seller.sellerId.trim();
    const sellerName = seller.sellerName.trim();
    // The legacy catalog is owned by `demo-seller`, so a fresh generated demo
    // persona legitimately creates its private event row under that owner.
    // `listForGuide()` remains the public boundary and filters every
    // `demo-seller` row. Only the retired placeholder display identity is
    // refused here; conflating "never public" with "must not exist" made the
    // clean-clone create flow fail before it could register its first item.
    if (!sellerId || !sellerName || sellerName.toLowerCase() === 'sidestage seller') {
      return false;
    }
    return this.store.publish({
      eventId: config.eventId,
      title: config.name,
      sellerId,
      sellerName,
      ...(config.thumbnailUrl ? { thumbnailUrl: config.thumbnailUrl } : {}),
    });
  }

  /**
   * Withdraw a seller-owned event from the public guide. Drafting instead of
   * deleting preserves every event-scoped record and lets the normal config
   * save path publish it again later.
   */
  async unpublish(eventId: string, sellerId: string): Promise<boolean> {
    return this.store.unpublish(eventId.trim(), sellerId.trim());
  }

  /**
   * Apply one seller lifecycle transition (D-002).
   *
   * Three outcomes the caller must tell apart, which is why this returns a
   * discriminated result rather than a record-or-undefined: the event is not
   * this seller's (404), the transition is illegal from the current state (409,
   * with the reason the seller reads), or it applied (200 with the new row).
   */
  async transition(
    eventId: string,
    sellerId: string,
    action: EventLifecycleAction,
    input: { startsAt?: unknown; now?: Date } = {},
  ): Promise<
    | { outcome: 'not-found' }
    | { outcome: 'refused'; reason: string }
    | { outcome: 'applied'; event: EventRecord }
  > {
    const id = eventId.trim();
    const seller = sellerId.trim();
    const current = await this.store.findOwned(id, seller);
    if (!current) return { outcome: 'not-found' };

    const resolved = resolveLifecycleTransition(lifecycleStateOf(current), action, input);
    if (!resolved.ok) return { outcome: 'refused', reason: resolved.reason };

    const applied = await this.store.applyLifecycle(id, seller, resolved.next);
    // The row was owned a moment ago, so a miss here means it was withdrawn
    // concurrently rather than that the seller was wrong about owning it.
    if (!applied) return { outcome: 'not-found' };
    return { outcome: 'applied', event: applied };
  }

  /**
   * Take every scheduled event whose start time has passed live (D-003).
   *
   * Server-side by design: a browser-side flip would fire only for whoever
   * happened to have a tab open, would not fire at all with nobody watching,
   * and would be a lifecycle write originating from an unauthenticated buyer
   * surface. Returns the rows that moved so the caller can invalidate exactly
   * the affected event surfaces.
   */
  async activateDueScheduled(now: Date = new Date()): Promise<EventRecord[]> {
    return this.store.activateDueScheduled(now);
  }

  /** The event table is the sole owner oracle for every event-anchored row. */
  async findById(eventId: string): Promise<EventRecord | undefined> {
    return this.store.findById(eventId.trim());
  }

  /** Foreign and absent ids deliberately collapse to the same undefined result. */
  async findOwned(eventId: string, sellerId: string): Promise<EventRecord | undefined> {
    return this.store.findOwned(eventId.trim(), sellerId.trim());
  }

  /**
   * The Channel Guide payload.
   *
   * Viewer counts are read per event from live chat presence — the same source
   * /events/:eventId/stats already uses — rather than from a stored column, so
   * the guide can never show a count that outlived the viewers it counted.
   */
  async listForGuide(): Promise<EventSummary[]> {
    const records = (await this.store.listBuyerVisible())
      .filter((record) => !isSyntheticSellerIdentity(record));
    const summaries = await Promise.all(records.map(async (record) => ({
      ...record,
      // Only a live room can have anyone in it; reporting presence for an
      // ended event would be reporting whoever is idling on its replay page.
      viewers: record.status === 'live'
        ? (await this.chat.getStats(record.eventId)).activeUsers
        : 0,
    })));
    return summaries.sort(compareForGuide);
  }

  /**
   * The seller's own event directory. Unlike the buyer guide this includes
   * drafts, never derives audience presence, and is scoped at the store read
   * so another seller's rows do not cross the API boundary.
   */
  async listForSeller(sellerId: string): Promise<EventRecord[]> {
    const id = sellerId.trim();
    if (!id) return [];
    return (await this.store.listBySeller(id)).sort(compareForSeller);
  }
}
