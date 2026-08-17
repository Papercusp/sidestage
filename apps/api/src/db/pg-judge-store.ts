import type { Pool, PoolClient } from 'pg';

import {
  cloneJudgeReport,
  type JudgeSaveContext,
  type JudgeStore,
} from '../judge/judge.store';
import {
  JUDGE_DIMENSIONS,
  type JudgeAggregateDimension,
  type JudgeCaseResult,
  type JudgeDimension,
  type JudgeDimensionResult,
  type JudgeReport,
} from '../judge/judge.types';

/**
 * Scores cross the wire as integer BASIS POINTS (0..10000), never floats.
 *
 * db/schema.sql has no float column anywhere, and the reason bites hardest
 * here: every verdict is `score >= passThreshold`, so a float round-tripping
 * through Postgres is exactly where a run lands on the wrong side of its own
 * pass boundary. Rounding once, at the boundary, keeps the stored verdict and
 * the recomputed one identical.
 */
const BASIS_POINTS = 10_000;

export function toBasisPoints(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(BASIS_POINTS, Math.max(0, Math.round(score * BASIS_POINTS)));
}

export function fromBasisPoints(basisPoints: number): number {
  return basisPoints / BASIS_POINTS;
}

interface JudgeRunRow {
  run_id: string;
  total_cases: number;
  passed_cases: number;
  overall_score_bp: number;
  pass_threshold_bp: number;
  passed: boolean;
  latency_ms: number;
  dimensions: Record<string, unknown> | string;
}

interface JudgeCaseRow {
  case_id: string;
  question: string;
  reply: string;
  overall_score_bp: number;
  passed: boolean;
  dimensions: Record<string, unknown> | string;
}

function json<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

/** Postgres row counts are text on some drivers; normalize before arithmetic. */
function int(value: number | string): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

/** Aggregate dimensions, stored as basis points, rebuilt as 0..1 scores. */
function mapAggregateDimensions(
  raw: Record<string, unknown>,
): JudgeReport['dimensions'] {
  return Object.fromEntries(JUDGE_DIMENSIONS.map((dimension) => {
    const entry = (raw[dimension] ?? {}) as { scoreBp?: number; passed?: boolean };
    return [dimension, {
      score: fromBasisPoints(int(entry.scoreBp ?? 0)),
      passed: entry.passed === true,
    } satisfies JudgeAggregateDimension];
  })) as JudgeReport['dimensions'];
}

function mapCaseDimensions(
  raw: Record<string, unknown>,
): JudgeCaseResult['dimensions'] {
  return Object.fromEntries(JUDGE_DIMENSIONS.map((dimension) => {
    const entry = (raw[dimension] ?? {}) as {
      scoreBp?: number;
      rationale?: string;
      passed?: boolean;
    };
    return [dimension, {
      dimension,
      score: fromBasisPoints(int(entry.scoreBp ?? 0)),
      rationale: entry.rationale ?? 'No rationale was returned.',
      passed: entry.passed === true,
    } satisfies JudgeDimensionResult];
  })) as JudgeCaseResult['dimensions'];
}

function serializeAggregateDimensions(report: JudgeReport): string {
  return JSON.stringify(Object.fromEntries(JUDGE_DIMENSIONS.map((dimension) => {
    const entry = report.dimensions[dimension];
    return [dimension, { scoreBp: toBasisPoints(entry.score), passed: entry.passed }];
  })));
}

function serializeCaseDimensions(result: JudgeCaseResult): string {
  return JSON.stringify(Object.fromEntries(JUDGE_DIMENSIONS.map((dimension) => {
    const entry = result.dimensions[dimension];
    return [dimension, {
      scoreBp: toBasisPoints(entry.score),
      rationale: entry.rationale,
      passed: entry.passed,
    }];
  })));
}

function mapReport(run: JudgeRunRow, cases: readonly JudgeCaseRow[]): JudgeReport {
  return {
    runId: run.run_id,
    totalCases: int(run.total_cases),
    passedCases: int(run.passed_cases),
    overallScore: fromBasisPoints(int(run.overall_score_bp)),
    passed: run.passed,
    passThreshold: fromBasisPoints(int(run.pass_threshold_bp)),
    dimensions: mapAggregateDimensions(json(run.dimensions)),
    cases: cases.map((row) => ({
      caseId: row.case_id,
      question: row.question,
      reply: row.reply,
      overallScore: fromBasisPoints(int(row.overall_score_bp)),
      passed: row.passed,
      dimensions: mapCaseDimensions(json(row.dimensions)),
    })),
    latencyMs: int(run.latency_ms),
  };
}

const RUN_COLUMNS = `run_id, total_cases, passed_cases, overall_score_bp,
  pass_threshold_bp, passed, latency_ms, dimensions`;

const CASE_COLUMNS = `case_id, question, reply, overall_score_bp, passed, dimensions`;

/** PostgreSQL production authority for graded judge runs. */
export class PgJudgeStore implements JudgeStore {
  constructor(private readonly pool: Pool) {}

  async latest(): Promise<JudgeReport | null> {
    const run = await this.pool.query<JudgeRunRow>(
      `SELECT ${RUN_COLUMNS} FROM judge_run ORDER BY created_at DESC, run_id DESC LIMIT 1`,
    );
    const header = run.rows[0];
    if (!header) return null;
    return mapReport(header, await this.readCases(this.pool, header.run_id));
  }

  async save(report: JudgeReport, context: JudgeSaveContext): Promise<JudgeReport> {
    const client = await this.pool.connect();
    try {
      // One transaction for the header AND every case row: a reader must never
      // observe a run whose cases are still arriving, and a mid-write failure
      // must leave no partially graded run behind.
      await client.query('BEGIN');

      // ON CONFLICT DO NOTHING makes the idempotency key the transaction
      // boundary: a replayed request inserts nothing and we return the run
      // already stored under that key, rather than minting a second runId.
      const inserted = await client.query<{ run_id: string }>(
        `INSERT INTO judge_run (
           run_id, idempotency_key, actor_id, total_cases, passed_cases,
           overall_score_bp, pass_threshold_bp, passed, latency_ms, dimensions
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING run_id`,
        [
          report.runId,
          context.idempotencyKey,
          context.actorId,
          report.totalCases,
          report.passedCases,
          toBasisPoints(report.overallScore),
          toBasisPoints(report.passThreshold),
          report.passed,
          Math.max(0, Math.round(report.latencyMs)),
          serializeAggregateDimensions(report),
        ],
      );

      if (inserted.rows.length === 0) {
        // Lost the race (or a genuine replay): the winner's run is canonical.
        const existing = await client.query<JudgeRunRow>(
          `SELECT ${RUN_COLUMNS} FROM judge_run WHERE idempotency_key = $1`,
          [context.idempotencyKey],
        );
        const header = existing.rows[0];
        if (header) {
          const cases = await this.readCases(client, header.run_id);
          await client.query('COMMIT');
          return mapReport(header, cases);
        }
        // No insert and no row: the key vanished between the two statements,
        // which should be impossible. Fail loudly rather than invent a report.
        throw new Error(`judge run for idempotency key ${context.idempotencyKey} could not be resolved`);
      }

      for (const [position, result] of report.cases.entries()) {
        await client.query(
          `INSERT INTO judge_case_result (
             run_id, case_id, position, question, reply,
             overall_score_bp, passed, dimensions
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            report.runId,
            result.caseId,
            position,
            result.question,
            result.reply,
            toBasisPoints(result.overallScore),
            result.passed,
            serializeCaseDimensions(result),
          ],
        );
      }

      await client.query('COMMIT');
      return cloneJudgeReport(report);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async readCases(
    executor: Pool | PoolClient,
    runId: string,
  ): Promise<JudgeCaseRow[]> {
    const result = await executor.query<JudgeCaseRow>(
      `SELECT ${CASE_COLUMNS} FROM judge_case_result WHERE run_id = $1 ORDER BY position`,
      [runId],
    );
    return result.rows;
  }
}

export type { JudgeDimension };
