import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { EventService, type EventRecord } from './event.service';

/**
 * How often due `scheduled` events are taken live, in milliseconds.
 *
 * Sized against the surface a buyer is actually looking at: the Channel Guide
 * polls every 15s and its countdown ticks per second, so a 15s sweep means a
 * room opens within one guide refresh of its scheduled instant. Sweeping faster
 * would not show up any sooner; sweeping slower would let the countdown sit at
 * "Starting now" while the room stayed shut, which reads as a broken schedule.
 */
export const DEFAULT_EVENT_ACTIVATION_SWEEP_INTERVAL_MS = 15_000;

export function eventActivationSweepIntervalMs(
  raw: string | undefined = process.env.EVENT_ACTIVATION_SWEEP_MS,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_EVENT_ACTIVATION_SWEEP_INTERVAL_MS;
  return Math.floor(parsed);
}

/**
 * Auto-go-live for scheduled events (D-003).
 *
 * A scheduled event's start time is a PROMISE to buyers — the guide renders a
 * live countdown against it — and until this existed nothing kept it: the
 * countdown reached zero, printed "Starting now", and the room stayed
 * `scheduled` until a seller happened to press a button. Since the whole point
 * of scheduling is that the seller does NOT have to be present at the moment,
 * the flip has to happen server-side.
 *
 * Why not in the browser: a client-side flip fires only for whoever has a tab
 * open, does not fire at all when nobody is watching (the case that matters
 * most, because the first buyer arrives BECAUSE the room opened), and would be
 * a lifecycle write originating from an unauthenticated buyer surface.
 *
 * Shape deliberately mirrors ChatPresenceSweeper: a module-lifecycle-bound
 * interval, `unref`'d so it never holds a process or a test runner alive, and a
 * sweep that never throws. Two sweepers with one shape beats a second
 * scheduling mechanism.
 */
@Injectable()
export class EventActivationSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventActivationSweeper.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(EventService) private readonly events: EventService,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
    private readonly intervalMs: number = eventActivationSweepIntervalMs(),
  ) {}

  onModuleInit(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One sweep. Never throws: a transient database failure must not take the
   * process down, and the next tick retries the same due rows — the store's
   * `status = 'scheduled'` predicate makes the retry idempotent.
   */
  async sweep(now: Date = new Date()): Promise<EventRecord[]> {
    let activated: EventRecord[];
    try {
      activated = await this.events.activateDueScheduled(now);
    } catch (error) {
      this.logger.warn(
        `Event activation sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }

    if (activated.length === 0) return [];

    for (const event of activated) {
      this.invalidations.invalidate('event.lineup.items', { eventId: event.eventId });
      // `events.mine` is per-seller. The stored sellerId is already the
      // role-projected principal the directory query resolves against, so it
      // can be replayed here even though no seller is present in the sweep.
      this.invalidations.invalidate('events.mine', undefined, { principal: event.sellerId });
    }
    this.invalidations.invalidate('events.guide');

    this.logger.log(
      `Took ${activated.length} scheduled event(s) live: ${activated.map((event) => event.eventId).join(', ')}`,
    );
    return activated;
  }
}
