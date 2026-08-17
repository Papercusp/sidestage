import type { JudgeReport } from './judge.types';

export const JUDGE_STORE = Symbol('JUDGE_STORE');

/**
 * Where a graded judge run actually lives.
 *
 * Before WS cutover P-001c the "store" was a single process field on
 * AutoResponderJudgeService, which made the server authority for the
 * `judge.latest` query non-durable: a restart erased the newest report, and two
 * API replicas answered the same query differently. Postgres is the authority
 * now; this seam is what the in-memory development fallback plugs into.
 */
export interface JudgeStore {
  /** The most recently graded run, or null when nothing has been graded yet. */
  latest(): Promise<JudgeReport | null>;

  /**
   * Persist a graded run under `idempotencyKey`.
   *
   * IDEMPOTENT BY CONTRACT: re-saving the same key returns the run already
   * stored under it and writes nothing. A retried judge.run — a client retry, a
   * proxy replay — must not mint a second graded run with a fresh runId, or the
   * Test tab shows two verdicts for one submission.
   */
  save(report: JudgeReport, context: JudgeSaveContext): Promise<JudgeReport>;
}

export interface JudgeSaveContext {
  idempotencyKey: string;
  actorId: string;
}

/** Deep-copies a report so a stored run can never be mutated by its caller. */
export function cloneJudgeReport(report: JudgeReport): JudgeReport {
  return structuredClone(report) as JudgeReport;
}

/**
 * Development fallback authority — used only when no Postgres pool is
 * configured. It reproduces the durable store's IDEMPOTENCY semantics exactly
 * so a test that passes here is not lying about production behaviour, but it
 * remains process-local: the census classifies it as such rather than
 * pretending the fallback is durable.
 */
export class InMemoryJudgeStore implements JudgeStore {
  private readonly runsByIdempotencyKey = new Map<string, JudgeReport>();
  private latestRun: JudgeReport | null = null;

  async latest(): Promise<JudgeReport | null> {
    return this.latestRun ? cloneJudgeReport(this.latestRun) : null;
  }

  async save(report: JudgeReport, context: JudgeSaveContext): Promise<JudgeReport> {
    const existing = this.runsByIdempotencyKey.get(context.idempotencyKey);
    if (existing) return cloneJudgeReport(existing);

    const stored = cloneJudgeReport(report);
    this.runsByIdempotencyKey.set(context.idempotencyKey, stored);
    this.latestRun = stored;
    return cloneJudgeReport(stored);
  }
}
