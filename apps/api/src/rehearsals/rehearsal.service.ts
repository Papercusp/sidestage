import { Inject, Injectable } from '@nestjs/common';
import { runActionRehearsal } from './action-rehearsal';
import { runAuctionRehearsal } from './auction-rehearsal';
import { runCheckoutRehearsal } from './checkout-rehearsal';
import { runInjectionRehearsal } from './injection-rehearsal';
import {
  DEFAULT_REHEARSAL_ACTOR,
  DRESS_REHEARSAL_KIND,
  REHEARSAL_STORE,
  type RehearsalRunKind,
  type RehearsalSaveContext,
  type RehearsalStore,
} from './rehearsal.store';
import type { DressRehearsalVerdict, RehearsalKind, RehearsalReport } from './rehearsal.types';

type RehearsalRunner = (options?: { now?: () => number }) => Promise<RehearsalReport>;

export const REHEARSAL_RUNNERS: Record<RehearsalKind, RehearsalRunner> = {
  actions: runActionRehearsal,
  auction: runAuctionRehearsal,
  checkout: runCheckoutRehearsal,
  injection: runInjectionRehearsal,
};

/**
 * Folds the individual rehearsals into one go / no-go answer.
 *
 * The verdict deliberately flattens every failing case into a single blocker
 * list. A host about to go live needs "these three things are broken", not four
 * reports to open and compare — and the blockers keep their rehearsal kind so
 * the list stays traceable back to the panel it came from.
 */
export function summarizeDressRehearsal(reports: readonly RehearsalReport[], now: () => number = Date.now): DressRehearsalVerdict {
  const blockers = reports.flatMap((report) => report.cases
    .filter((entry) => !entry.passed)
    .map((entry) => ({ kind: report.kind, caseId: entry.caseId, title: entry.title, observed: entry.observed })));
  const totalCases = reports.reduce((sum, report) => sum + report.totalCases, 0);
  const passedCases = reports.reduce((sum, report) => sum + report.passedCases, 0);
  const caveats = [...new Set(reports.flatMap((report) => report.caveats ?? []))];
  return {
    ranAt: new Date(now()).toISOString(),
    // An empty run is never a green light: nothing was proven.
    ready: reports.length > 0 && blockers.length === 0,
    totalCases,
    passedCases,
    blockers,
    caveats,
    reports: [...reports],
  };
}

@Injectable()
export class RehearsalService {
  constructor(@Inject(REHEARSAL_STORE) private readonly store: RehearsalStore) {}

  async run(kind: RehearsalKind, context: Partial<RehearsalSaveContext> = {}): Promise<RehearsalReport> {
    const report = await REHEARSAL_RUNNERS[kind]();
    // Postgres decides what the canonical run is. The stored run is what the
    // Test tab and any later audit read; returning the in-memory report here
    // would leave the caller holding a run that a restart erases.
    return this.store.saveReport(report, withDefaults(context));
  }

  /**
   * Runs every rehearsal. They are run SEQUENTIALLY on purpose: the auction
   * rehearsal waits out a real one-second clock, and running the set in
   * parallel would put the box under load that the timing case then has to
   * survive — a rehearsal that is flaky under its own concurrency teaches the
   * host nothing.
   */
  async runAll(context: Partial<RehearsalSaveContext> = {}): Promise<DressRehearsalVerdict> {
    const reports: RehearsalReport[] = [];
    for (const kind of Object.keys(REHEARSAL_RUNNERS) as RehearsalKind[]) {
      reports.push(await REHEARSAL_RUNNERS[kind]());
    }
    const verdict = summarizeDressRehearsal(reports);

    // Each constituent run is persisted in its OWN right, not just inside the
    // folded verdict's jsonb: `rehearsal.latest(kind)` must see the run that
    // happened here, and a per-kind history that only exists nested inside a
    // dress-rehearsal blob is not queryable by the recency index the table
    // carries for exactly that read.
    // Each row needs its OWN idempotency key. rehearsal_run.idempotency_key is
    // UNIQUE across the whole table, so reusing one retry token for every row
    // would make the constituent runs collide with each other AND the folded
    // verdict collide with a report — and the store's ON CONFLICT DO NOTHING +
    // re-SELECT would then hand back a row of the WRONG KIND. Absent a token
    // each save already mints a fresh uuid, so this only has to disambiguate
    // the explicit-retry path.
    for (const report of reports) {
      await this.store.saveReport(report, withDefaults(context, report.kind));
    }
    return this.store.saveVerdict(verdict, withDefaults(context, DRESS_REHEARSAL_KIND));
  }

  /** The last stored run of one kind — survives restart, identical on every replica. */
  latest(kind: RehearsalKind): Promise<RehearsalReport | null> {
    return this.store.latestReport(kind);
  }

  /** The last stored dress rehearsal — survives restart, identical on every replica. */
  latestDressRehearsal(): Promise<DressRehearsalVerdict | null> {
    return this.store.latestVerdict();
  }
}

/**
 * A save context always carries an actor: rehearsal_run.actor_id is NOT NULL
 * and rejects blanks, so an unattributed run is stamped with the shared
 * operator identity rather than failing the insert at the database boundary.
 *
 * `idempotencyKey` is deliberately left undefined when the caller omits it —
 * the store then mints a fresh key so two genuine runs stay two rows.
 *
 * `scope` qualifies an explicitly-supplied retry token so that one token spread
 * across a dress rehearsal still yields one unique key per stored row. It is
 * ignored when no token was supplied, because a minted uuid is already unique.
 */
function withDefaults(
  context: Partial<RehearsalSaveContext>,
  scope?: RehearsalRunKind,
): RehearsalSaveContext {
  const token = context.idempotencyKey;
  return {
    actorId: context.actorId?.trim() || DEFAULT_REHEARSAL_ACTOR,
    eventId: context.eventId ?? null,
    idempotencyKey: token && scope ? `${token}:${scope}` : token,
  };
}
