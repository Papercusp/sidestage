import { Injectable } from '@nestjs/common';
import { runActionRehearsal } from './action-rehearsal';
import { runAuctionRehearsal } from './auction-rehearsal';
import { runCheckoutRehearsal } from './checkout-rehearsal';
import { runInjectionRehearsal } from './injection-rehearsal';
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
  run(kind: RehearsalKind): Promise<RehearsalReport> {
    return REHEARSAL_RUNNERS[kind]();
  }

  /**
   * Runs every rehearsal. They are run SEQUENTIALLY on purpose: the auction
   * rehearsal waits out a real one-second clock, and running the set in
   * parallel would put the box under load that the timing case then has to
   * survive — a rehearsal that is flaky under its own concurrency teaches the
   * host nothing.
   */
  async runAll(): Promise<DressRehearsalVerdict> {
    const reports: RehearsalReport[] = [];
    for (const kind of Object.keys(REHEARSAL_RUNNERS) as RehearsalKind[]) {
      reports.push(await REHEARSAL_RUNNERS[kind]());
    }
    return summarizeDressRehearsal(reports);
  }
}
