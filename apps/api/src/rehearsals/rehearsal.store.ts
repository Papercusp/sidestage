import { randomUUID } from 'node:crypto';
import type {
  DressRehearsalBlocker,
  DressRehearsalVerdict,
  RehearsalKind,
  RehearsalReport,
} from './rehearsal.types';

export const REHEARSAL_STORE = Symbol('REHEARSAL_STORE');

/** Kind stored for the folded dress rehearsal, which spans every runner. */
export const DRESS_REHEARSAL_KIND = 'all';

/** Stored kind: a single runner, or the folded whole-suite verdict. */
export type RehearsalRunKind = RehearsalKind | typeof DRESS_REHEARSAL_KIND;

/**
 * Ownership stamped on a run when the caller supplies no principal.
 *
 * rehearsal_run.actor_id is NOT NULL and rejects blanks, so the column always
 * answers "who ran this"; an explicit shared operator identity is honest about
 * an unattributed run where an empty string would read as data corruption.
 */
export const DEFAULT_REHEARSAL_ACTOR = 'operator';

/**
 * Where a completed rehearsal run actually lives.
 *
 * Before WS cutover P-001c there was no store at all: RehearsalService computed
 * a report and returned it, so the run existed only in the HTTP response. The
 * `rehearsal_run` table was created and catalogued in the data-surface census
 * but never read or written — the census advertised a durable surface that did
 * not exist. Postgres is the authority now; this seam is what the in-memory
 * development fallback plugs into.
 */
export interface RehearsalStore {
  /** The most recent run of one rehearsal kind, or null when it has never run. */
  latestReport(kind: RehearsalKind): Promise<RehearsalReport | null>;

  /** The most recent folded dress rehearsal, or null when none has run. */
  latestVerdict(): Promise<DressRehearsalVerdict | null>;

  saveReport(report: RehearsalReport, context: RehearsalSaveContext): Promise<RehearsalReport>;

  saveVerdict(
    verdict: DressRehearsalVerdict,
    context: RehearsalSaveContext,
  ): Promise<DressRehearsalVerdict>;
}

export interface RehearsalSaveContext {
  actorId: string;
  /**
   * Label for the event the run was filed against. Rehearsals never read or
   * mutate live event state, so this is provenance, not a selector.
   */
  eventId?: string | null;
  /**
   * OPTIONAL retry token — and the reason this store's idempotency contract is
   * DELIBERATELY DIFFERENT from PgJudgeStore's, despite the two tables carrying
   * an identically-shaped `idempotency_key text NOT NULL UNIQUE` column.
   *
   * A judge run is a PURE FUNCTION of its request: the same cases at the same
   * threshold must resolve to the one stored verdict, so judge derives its key
   * by hashing the request and a replay is always a duplicate.
   *
   * A rehearsal is a LIVE MEASUREMENT. Running `auction` twice legitimately
   * produces two different results — it waits out a real one-second clock, and
   * the whole point of keeping run history is to compare those runs. Hashing
   * the request here would collapse every genuine re-run onto one row and
   * silently destroy exactly the history the table exists to hold.
   *
   * So: absent an explicit token every invocation gets a fresh key and is
   * stored as its own run. Supply `idempotencyKey` only for a true retry — a
   * client resend or a proxy replay — where two deliveries of ONE request must
   * not mint two runs.
   */
  idempotencyKey?: string;
}

/** A distinct key per invocation, so two genuine runs are never merged. */
export function rehearsalIdempotencyKey(context: RehearsalSaveContext): string {
  return context.idempotencyKey ?? randomUUID();
}

/** Failing cases lifted into the blocker shape the dress rehearsal uses. */
export function blockersFor(report: RehearsalReport): DressRehearsalBlocker[] {
  return report.cases
    .filter((entry) => !entry.passed)
    .map((entry) => ({
      kind: report.kind,
      caseId: entry.caseId,
      title: entry.title,
      observed: entry.observed,
    }));
}

/** Deep-copies a report so a stored run can never be mutated by its caller. */
export function cloneRehearsalReport(report: RehearsalReport): RehearsalReport {
  return structuredClone(report) as RehearsalReport;
}

/** Deep-copies a verdict so a stored run can never be mutated by its caller. */
export function cloneDressRehearsalVerdict(verdict: DressRehearsalVerdict): DressRehearsalVerdict {
  return structuredClone(verdict) as DressRehearsalVerdict;
}

/**
 * Development fallback authority — used only when no Postgres pool is
 * configured. It reproduces the durable store's ordering and idempotency
 * semantics so a test that passes here is not lying about production
 * behaviour, but it remains process-local: the census classifies it as such
 * rather than pretending the fallback is durable.
 */
export class InMemoryRehearsalStore implements RehearsalStore {
  private readonly reportsByKey = new Map<string, RehearsalReport>();
  private readonly verdictsByKey = new Map<string, DressRehearsalVerdict>();
  private readonly latestByKind = new Map<RehearsalKind, RehearsalReport>();
  private latestDressRehearsal: DressRehearsalVerdict | null = null;

  async latestReport(kind: RehearsalKind): Promise<RehearsalReport | null> {
    const stored = this.latestByKind.get(kind);
    return stored ? cloneRehearsalReport(stored) : null;
  }

  async latestVerdict(): Promise<DressRehearsalVerdict | null> {
    return this.latestDressRehearsal ? cloneDressRehearsalVerdict(this.latestDressRehearsal) : null;
  }

  async saveReport(
    report: RehearsalReport,
    context: RehearsalSaveContext,
  ): Promise<RehearsalReport> {
    const key = rehearsalIdempotencyKey(context);
    const existing = this.reportsByKey.get(key);
    if (existing) return cloneRehearsalReport(existing);

    const stored = cloneRehearsalReport(report);
    this.reportsByKey.set(key, stored);
    this.latestByKind.set(report.kind, stored);
    return cloneRehearsalReport(stored);
  }

  async saveVerdict(
    verdict: DressRehearsalVerdict,
    context: RehearsalSaveContext,
  ): Promise<DressRehearsalVerdict> {
    const key = rehearsalIdempotencyKey(context);
    const existing = this.verdictsByKey.get(key);
    if (existing) return cloneDressRehearsalVerdict(existing);

    const stored = cloneDressRehearsalVerdict(verdict);
    this.verdictsByKey.set(key, stored);
    this.latestDressRehearsal = stored;
    return cloneDressRehearsalVerdict(stored);
  }
}
