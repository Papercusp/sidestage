import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

export const RUN_OF_SHOW_STORE = Symbol('RUN_OF_SHOW_STORE');

/**
 * One planned lineup slot in the seller's run of show.
 *
 * The run of show is ADVISORY by design (plan D-001): it never gates, blocks,
 * or auto-drives staging or commerce. It is the seller's own pre-show plan —
 * which order to present products, how long to spend on each, and what to say
 * — surfaced back to them during the live event as guidance they are free to
 * ignore.
 */
export interface RunOfShowEntry {
  productId: string;
  /**
   * Planned time on stage, in seconds. `null` means the seller set no budget
   * for this product — the live timer then shows elapsed time with no target.
   */
  plannedDurationSec: number | null;
  /**
   * Seller-authored talking points. Auto-surfaced in the Studio the moment
   * this product hits the stage (plan D-002); empty string means no notes.
   */
  notes: string;
}

export interface RunOfShowPlan {
  eventId: string;
  /** Array order IS the planned show order (plan D-003). */
  entries: RunOfShowEntry[];
  updatedAt: string;
}

export interface RunOfShowStore {
  get(eventId: string): Promise<RunOfShowPlan | undefined>;
  set(plan: RunOfShowPlan): Promise<void>;
}

@Injectable()
export class InMemoryRunOfShowStore implements RunOfShowStore {
  private readonly plans = new Map<string, RunOfShowPlan>();

  async get(eventId: string): Promise<RunOfShowPlan | undefined> {
    return this.plans.get(eventId);
  }

  async set(plan: RunOfShowPlan): Promise<void> {
    this.plans.set(plan.eventId, plan);
  }
}

export class PgRunOfShowStore implements RunOfShowStore {
  constructor(private readonly pool: Pool) {}

  async get(eventId: string): Promise<RunOfShowPlan | undefined> {
    const result = await this.pool.query<{ payload: RunOfShowPlan }>(
      'SELECT payload FROM event_run_of_show WHERE event_id = $1',
      [eventId],
    );
    return result.rows[0]?.payload ?? undefined;
  }

  async set(plan: RunOfShowPlan): Promise<void> {
    await this.pool.query(
      `INSERT INTO event_run_of_show (event_id, payload, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (event_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [plan.eventId, JSON.stringify(plan)],
    );
  }
}

/** The default: an event with no saved plan has an empty, valid run of show. */
export function emptyRunOfShow(eventId: string): RunOfShowPlan {
  return { eventId, entries: [], updatedAt: new Date(0).toISOString() };
}

/** More slots than any live show plausibly runs; bounds the jsonb document. */
const MAX_ENTRIES = 200;
/** Bounds one product's talking points; long-form prep belongs elsewhere. */
const MAX_NOTES_CHARS = 2_000;
/** 4 hours on a single product is already implausible; reject typo'd inputs. */
const MAX_DURATION_SEC = 4 * 3600;

@Injectable()
export class RunOfShowService {
  constructor(@Inject(RUN_OF_SHOW_STORE) private readonly store: RunOfShowStore) {}

  async get(eventId: string): Promise<RunOfShowPlan> {
    const id = this.readEventId(eventId);
    return (await this.store.get(id)) ?? emptyRunOfShow(id);
  }

  /**
   * Whole-document replace: the client sends the full ordered entry list.
   * Reordering, editing a note, and removing a slot are all the same save,
   * which keeps the store seam one upsert and the order unambiguous.
   */
  async save(eventId: string, input: { entries?: unknown }): Promise<RunOfShowPlan> {
    const id = this.readEventId(eventId);
    const next: RunOfShowPlan = {
      eventId: id,
      entries: this.readEntries(input.entries),
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(next);
    return next;
  }

  /** Same event-id rule as EventConfigService: this names the same events. */
  private readEventId(value: string): string {
    const id = value.trim().toLowerCase();
    if (!id || id.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new BadRequestException('eventId must be lowercase letters, numbers, and hyphens');
    }
    return id;
  }

  private readEntries(value: unknown): RunOfShowEntry[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new BadRequestException('entries must be an array');
    if (value.length > MAX_ENTRIES) {
      throw new BadRequestException(`entries must have ${MAX_ENTRIES} or fewer items`);
    }
    const seen = new Set<string>();
    return value.map((raw, index) => {
      const entry = this.readEntry(raw, index);
      if (seen.has(entry.productId)) {
        throw new BadRequestException(`entries[${index}]: duplicate productId "${entry.productId}"`);
      }
      seen.add(entry.productId);
      return entry;
    });
  }

  private readEntry(value: unknown, index: number): RunOfShowEntry {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException(`entries[${index}] must be an object`);
    }
    const raw = value as Record<string, unknown>;

    const productId = typeof raw.productId === 'string' ? raw.productId.trim() : '';
    if (!productId || productId.length > 128) {
      throw new BadRequestException(`entries[${index}].productId is required and must be 128 characters or fewer`);
    }

    const duration = raw.plannedDurationSec;
    let plannedDurationSec: number | null = null;
    if (duration !== undefined && duration !== null) {
      if (!Number.isSafeInteger(duration) || (duration as number) < 1 || (duration as number) > MAX_DURATION_SEC) {
        throw new BadRequestException(
          `entries[${index}].plannedDurationSec must be null or a whole number of seconds between 1 and ${MAX_DURATION_SEC}`,
        );
      }
      plannedDurationSec = duration as number;
    }

    const notesRaw = raw.notes;
    if (notesRaw !== undefined && notesRaw !== null && typeof notesRaw !== 'string') {
      throw new BadRequestException(`entries[${index}].notes must be a string`);
    }
    const notes = typeof notesRaw === 'string' ? notesRaw : '';
    if (notes.length > MAX_NOTES_CHARS) {
      throw new BadRequestException(`entries[${index}].notes must be ${MAX_NOTES_CHARS} characters or fewer`);
    }

    return { productId, plannedDurationSec, notes };
  }
}
