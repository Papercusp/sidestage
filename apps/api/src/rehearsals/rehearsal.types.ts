/**
 * Shared contract for the Test tab's launch-readiness rehearsals.
 *
 * A rehearsal drives a REAL SideStage service through a scripted sequence and
 * reports, case by case, whether the seam behaved the way the host is entitled
 * to assume it will behave during a live event. It is not a unit test: unit
 * tests prove the logic to us, a rehearsal proves the wiring to the seller,
 * minutes before they go live, in language they can act on.
 *
 * Every rehearsal reports through this one shape so the web tab renders all of
 * them with a single panel component.
 */

export const REHEARSAL_KINDS = ['actions', 'auction', 'checkout', 'injection'] as const;

export type RehearsalKind = (typeof REHEARSAL_KINDS)[number];

/** Structured, renderable evidence for one case. Values stay scalar so the UI never has to recurse. */
export type RehearsalEvidence = Record<string, string | number | boolean>;

/** The identity of a case, fixed at authoring time so run-over-run diffs line up. */
export interface RehearsalCaseSpec {
  caseId: string;
  title: string;
  /** What the seam is REQUIRED to do — written for the seller, not the developer. */
  expectation: string;
}

/** What a probe saw. Returned by a probe, folded into the case result. */
export interface RehearsalObservation {
  passed: boolean;
  /** What actually happened, in one seller-readable line. */
  observed: string;
  evidence?: RehearsalEvidence;
}

export interface RehearsalCaseResult extends RehearsalCaseSpec, RehearsalObservation {}

export interface RehearsalReport {
  runId: string;
  kind: RehearsalKind;
  title: string;
  /** One-line verdict for the panel header. */
  summary: string;
  totalCases: number;
  passedCases: number;
  passed: boolean;
  latencyMs: number;
  ranAt: string;
  cases: RehearsalCaseResult[];
  /**
   * Set when some part of the rehearsal stood in for a real external
   * dependency (a payment sandbox, say). Surfaced in the UI so a green
   * rehearsal is never mistaken for proof that the third party is healthy.
   */
  caveats?: string[];
}

/** Request body accepted by every rehearsal endpoint. */
export interface RehearsalRequest {
  /**
   * Echoed into the report so a run can be filed against the event it was run
   * for. Rehearsals never read or mutate live event state, so this is a label,
   * not a selector — the isolation is what makes the rehearsal safe to run
   * during an event.
   */
  eventId?: string;
}
