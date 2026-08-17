import type { Pool } from 'pg';

import {
  blockersFor,
  cloneDressRehearsalVerdict,
  cloneRehearsalReport,
  DRESS_REHEARSAL_KIND,
  rehearsalIdempotencyKey,
  type RehearsalSaveContext,
  type RehearsalStore,
} from '../rehearsals/rehearsal.store';
import type {
  DressRehearsalVerdict,
  RehearsalKind,
  RehearsalReport,
} from '../rehearsals/rehearsal.types';

/**
 * `report` arrives as a parsed object on most drivers and as raw text on
 * others, so the row is generic over what the jsonb column decodes to.
 */
interface RehearsalRunRow<TReport> {
  run_id: string;
  report: TReport | string;
}

function json<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

/**
 * The stored run is reconstructed from the `report` jsonb rather than rebuilt
 * from the lifted columns.
 *
 * The hot columns (ready, total_cases, passed_cases, kind, ran_at) exist so a
 * reader can answer "did this run pass" and order by recency WITHOUT parsing
 * jsonb — they are a projection for querying, not a second source of truth.
 * Rebuilding the report from them would silently drop every field they do not
 * cover (per-case evidence, caveats, titles) and hand the caller a report that
 * is a strict subset of what was actually observed.
 */
function mapReport(row: RehearsalRunRow<RehearsalReport>): RehearsalReport {
  return json<RehearsalReport>(row.report);
}

function mapVerdict(row: RehearsalRunRow<DressRehearsalVerdict>): DressRehearsalVerdict {
  return json<DressRehearsalVerdict>(row.report);
}

const RUN_COLUMNS = 'run_id, report';

const INSERT_RUN = `INSERT INTO rehearsal_run (
    run_id, idempotency_key, actor_id, event_id, kind, ran_at,
    total_cases, passed_cases, ready, blockers, caveats, report
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING run_id`;

/**
 * PostgreSQL production authority for completed rehearsal runs.
 *
 * NOTE ON IDEMPOTENCY — this store's contract is deliberately NOT PgJudgeStore's,
 * even though both tables carry an identically-shaped `idempotency_key text NOT
 * NULL UNIQUE`. A judge run is a pure function of its request, so a replay must
 * resolve to the stored verdict. A rehearsal is a live measurement, so two runs
 * of the same kind are two legitimately different results and must occupy two
 * rows. The key defaults to a fresh uuid per invocation and only dedups when a
 * caller passes an explicit retry token. See RehearsalSaveContext.idempotencyKey.
 */
export class PgRehearsalStore implements RehearsalStore {
  constructor(private readonly pool: Pool) {}

  async latestReport(kind: RehearsalKind): Promise<RehearsalReport | null> {
    const result = await this.pool.query<RehearsalRunRow<RehearsalReport>>(
      `SELECT ${RUN_COLUMNS} FROM rehearsal_run
       WHERE kind = $1 ORDER BY ran_at DESC, run_id DESC LIMIT 1`,
      [kind],
    );
    const row = result.rows[0];
    return row ? mapReport(row) : null;
  }

  async latestVerdict(): Promise<DressRehearsalVerdict | null> {
    const result = await this.pool.query<RehearsalRunRow<DressRehearsalVerdict>>(
      `SELECT ${RUN_COLUMNS} FROM rehearsal_run
       WHERE kind = $1 ORDER BY ran_at DESC, run_id DESC LIMIT 1`,
      [DRESS_REHEARSAL_KIND],
    );
    const row = result.rows[0];
    return row ? mapVerdict(row) : null;
  }

  async saveReport(
    report: RehearsalReport,
    context: RehearsalSaveContext,
  ): Promise<RehearsalReport> {
    const idempotencyKey = rehearsalIdempotencyKey(context);
    const inserted = await this.pool.query<{ run_id: string }>(INSERT_RUN, [
      report.runId,
      idempotencyKey,
      context.actorId,
      context.eventId ?? null,
      report.kind,
      report.ranAt,
      report.totalCases,
      report.passedCases,
      report.passed,
      JSON.stringify(blockersFor(report)),
      JSON.stringify(report.caveats ?? []),
      JSON.stringify(report),
    ]);

    if (inserted.rows.length > 0) return cloneRehearsalReport(report);

    // Only reachable when the caller supplied an explicit retry token that has
    // already been stored: return the run recorded under it rather than
    // pretending this replay produced a second measurement.
    const existing = await this.pool.query<RehearsalRunRow<RehearsalReport>>(
      `SELECT ${RUN_COLUMNS} FROM rehearsal_run WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) {
      // No insert and no row: the key vanished between the two statements,
      // which should be impossible. Fail loudly rather than invent a report.
      throw new Error(`rehearsal run for idempotency key ${idempotencyKey} could not be resolved`);
    }
    return mapReport(row);
  }

  async saveVerdict(
    verdict: DressRehearsalVerdict,
    context: RehearsalSaveContext,
  ): Promise<DressRehearsalVerdict> {
    const idempotencyKey = rehearsalIdempotencyKey(context);
    // The folded verdict gets its own run_id: it is a distinct operational
    // record from the per-kind runs it summarizes, which are stored separately
    // and keep their own ids.
    const runId = `dress-${idempotencyKey}`;
    const inserted = await this.pool.query<{ run_id: string }>(INSERT_RUN, [
      runId,
      idempotencyKey,
      context.actorId,
      context.eventId ?? null,
      DRESS_REHEARSAL_KIND,
      verdict.ranAt,
      verdict.totalCases,
      verdict.passedCases,
      verdict.ready,
      JSON.stringify(verdict.blockers),
      JSON.stringify(verdict.caveats),
      JSON.stringify(verdict),
    ]);

    if (inserted.rows.length > 0) return cloneDressRehearsalVerdict(verdict);

    const existing = await this.pool.query<RehearsalRunRow<DressRehearsalVerdict>>(
      `SELECT ${RUN_COLUMNS} FROM rehearsal_run WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error(`dress rehearsal for idempotency key ${idempotencyKey} could not be resolved`);
    }
    return mapVerdict(row);
  }
}
