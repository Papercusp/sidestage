import { createHash } from 'node:crypto';

import {
  SYSTEM_TEST_RUN_OUTCOMES,
  SYSTEM_TEST_RUN_PHASES,
  getSystemTestSuiteManifest,
  isSystemTestRunState,
  parseSystemTestRunRequest,
  type SystemTestActor,
  type SystemTestCaseStatus,
  type SystemTestEvidenceKind,
  type SystemTestRunRequest,
  type SystemTestRunState,
} from '@papercusp/system-test-contract';
import type { Pool, PoolClient } from 'pg';

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TERMINAL_STATES = new Set<SystemTestRunState>(SYSTEM_TEST_RUN_OUTCOMES);
const NONTERMINAL_STATES = new Set<SystemTestRunState>(SYSTEM_TEST_RUN_PHASES);
const CASE_STATUSES = new Set<SystemTestCaseStatus>(['passed', 'failed', 'blocked', 'not-run']);
const CLEANUP_STATUSES = new Set<SystemTestCleanupStatus>([
  'not-started',
  'pending',
  'running',
  'succeeded',
  'failed',
]);

const TRANSITIONS: Readonly<Record<SystemTestRunState, readonly SystemTestRunState[]>> = {
  queued: ['provisioning', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed'],
  provisioning: ['running', 'cleaning', 'failed', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed'],
  running: ['collecting', 'cleaning', 'failed', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed'],
  collecting: ['cleaning', 'failed', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed'],
  cleaning: ['passed', 'failed', 'blocked', 'cancelled', 'timed-out', 'cleanup-failed'],
  passed: ['cleanup-failed'],
  failed: ['cleanup-failed'],
  blocked: ['cleanup-failed'],
  cancelled: ['cleanup-failed'],
  'timed-out': ['cleanup-failed'],
  'cleanup-failed': [],
};

export type SystemTestCleanupStatus =
  | 'not-started'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed';

export class SystemTestRunStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SystemTestRunStoreError';
  }
}

export class SystemTestRunConflictError extends SystemTestRunStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SystemTestRunConflictError';
  }
}

export interface CreateSystemTestRunInput {
  runId: string;
  idempotencyKey: string;
  request: SystemTestRunRequest;
  actor: SystemTestActor;
  now?: Date;
}

export interface RecordSystemTestCaseInput {
  caseId: string;
  status: SystemTestCaseStatus;
  summary: string;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface RecordSystemTestArtifactInput {
  artifactId: string;
  caseId?: string;
  kind: SystemTestEvidenceKind;
  ref: string;
  summary: string;
  capturedAt: Date;
  deployedSha: string;
  byteSize?: number;
}

export interface RecordSystemTestEnvironmentInput {
  environmentId: string;
  kind: string;
  status: string;
  imageDigest?: string;
  endpointFingerprint?: string;
  configurationFingerprint?: string;
  details?: Record<string, unknown>;
  recordedAt?: Date;
}

export interface RecordSystemTestCleanupInput {
  status: SystemTestCleanupStatus;
  summary: string;
  at?: Date;
}

export interface StoredSystemTestRun {
  id: string;
  idempotencyKey: string;
  contractVersion: number;
  suiteId: string;
  suiteVersion: number;
  profile: string;
  actor: SystemTestActor;
  requestedSha: string;
  eventId: string | null;
  deployedSha: string | null;
  state: SystemTestRunState;
  blockedReasons: string[];
  summary: string;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StoredSystemTestCase {
  caseId: string;
  ordinal: number;
  title: string;
  status: SystemTestCaseStatus;
  summary: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StoredSystemTestArtifact {
  artifactId: string;
  caseId: string | null;
  kind: SystemTestEvidenceKind;
  ref: string;
  summary: string;
  capturedAt: string;
  deployedSha: string;
  byteSize: number | null;
  redacted: true;
}

export interface StoredSystemTestEnvironment {
  environmentId: string;
  kind: string;
  status: string;
  imageDigest: string | null;
  endpointFingerprint: string | null;
  configurationFingerprint: string | null;
  details: Record<string, unknown>;
  recordedAt: string;
}

export interface StoredSystemTestTransition {
  sequence: number;
  fromState: SystemTestRunState | null;
  toState: SystemTestRunState;
  reason: string;
  occurredAt: string;
}

export interface StoredSystemTestCancellation {
  requestedBy: SystemTestActor;
  reason: string;
  requestedAt: string;
  acknowledgedAt: string | null;
}

export interface StoredSystemTestRetention {
  resultsExpiresAt: string;
  artifactsExpiresAt: string;
}

export interface StoredSystemTestCleanup {
  status: SystemTestCleanupStatus;
  summary: string;
  attempts: number;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface StoredSystemTestRunSnapshot {
  run: StoredSystemTestRun;
  suite: {
    suiteId: string;
    suiteVersion: number;
    profile: string;
    title: string;
    manifest: Record<string, unknown>;
  };
  cases: StoredSystemTestCase[];
  artifacts: StoredSystemTestArtifact[];
  environments: StoredSystemTestEnvironment[];
  transitions: StoredSystemTestTransition[];
  cancellation: StoredSystemTestCancellation | null;
  retention: StoredSystemTestRetention;
  cleanup: StoredSystemTestCleanup;
}

export interface PurgedSystemTestRuns {
  artifacts: number;
  runs: number;
}

export interface ClaimSystemTestRunOptions {
  maxConcurrentRuns: number;
  now?: Date;
}

export interface ListSystemTestRunsOptions {
  actor: SystemTestActor;
  limit?: number;
}

/**
 * Trusted-worker reporting seam. P-004 can depend on this interface while the
 * PostgreSQL implementation remains the single durable ledger.
 */
export interface SystemTestRunReporter {
  createRun(input: CreateSystemTestRunInput): Promise<StoredSystemTestRunSnapshot>;
  advanceRun(
    runId: string,
    state: SystemTestRunState,
    options?: { reason?: string; at?: Date },
  ): Promise<StoredSystemTestRunSnapshot>;
  heartbeat(runId: string, at?: Date): Promise<void>;
  setDeploymentEvidence(runId: string, deployedSha: string, at?: Date): Promise<void>;
  recordCase(runId: string, input: RecordSystemTestCaseInput): Promise<void>;
  recordArtifact(runId: string, input: RecordSystemTestArtifactInput): Promise<void>;
  recordEnvironment(runId: string, input: RecordSystemTestEnvironmentInput): Promise<void>;
  requestCancellation(
    runId: string,
    input: { requestedBy: SystemTestActor; reason: string; at?: Date },
  ): Promise<StoredSystemTestRunSnapshot>;
  acknowledgeCancellation(runId: string, at?: Date): Promise<StoredSystemTestRunSnapshot>;
  recordCleanup(runId: string, input: RecordSystemTestCleanupInput): Promise<StoredSystemTestRunSnapshot>;
  getRun(runId: string): Promise<StoredSystemTestRunSnapshot | null>;
}

/** API and trusted-worker queue operations backed by the same run ledger. */
export interface SystemTestRunQueueStore extends SystemTestRunReporter {
  claimNextRun(options: ClaimSystemTestRunOptions): Promise<StoredSystemTestRunSnapshot | null>;
  listRuns(options: ListSystemTestRunsOptions): Promise<StoredSystemTestRunSnapshot[]>;
}

interface LockedRunRow {
  id: string;
  state: SystemTestRunState;
}

function requireIdentifier(value: string, label: string, pattern = IDENTIFIER_PATTERN): void {
  if (!pattern.test(value)) throw new SystemTestRunStoreError(`${label} has an invalid format`);
}

function requireText(value: string, label: string, max: number): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SystemTestRunStoreError(`${label} must not be empty`);
  }
  if (value.length > max) throw new SystemTestRunStoreError(`${label} must be at most ${max} characters`);
}

function requireDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SystemTestRunStoreError(`${label} must be a valid Date`);
  }
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new SystemTestRunStoreError(`database returned an invalid timestamp`);
  return parsed.toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function canonicalRequest(request: SystemTestRunRequest, actor: SystemTestActor): Record<string, unknown> {
  return {
    actor: { id: actor.id, role: actor.role },
    request: {
      contractVersion: request.contractVersion,
      suiteId: request.suiteId,
      suiteVersion: request.suiteVersion,
      profile: request.profile,
      requestedSha: request.requestedSha,
      ...(request.eventId === undefined ? {} : { eventId: request.eventId }),
    },
  };
}

function requestHash(request: SystemTestRunRequest, actor: SystemTestActor): string {
  return createHash('sha256').update(JSON.stringify(canonicalRequest(request, actor))).digest('hex');
}

function plusDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 24 * 60 * 60 * 1_000);
}

function pgCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Same-state calls are idempotent; every other edge is explicitly allow-listed. */
export function canTransitionSystemTestRun(from: SystemTestRunState, to: SystemTestRunState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/**
 * Redact credentials before an artifact locator or human summary crosses the
 * persistence boundary. Locators retain their scheme/path for retrieval while
 * user-info, query strings, and fragments are discarded.
 */
export function redactSystemTestText(value: string): string {
  let redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(api[-_ ]?key|access[-_ ]?token|authorization|password|secret)\b\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[REDACTED]',
    );
  redacted = redacted.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, (candidate) => {
    try {
      const parsed = new URL(candidate);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return candidate.replace(/[?#].*$/, '');
    }
  });
  return redacted;
}

export function redactSystemTestJson(value: unknown): unknown {
  if (typeof value === 'string') return redactSystemTestText(value);
  if (Array.isArray(value)) return value.map(redactSystemTestJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if (/(?:authorization|password|secret|token|api[-_]?key)/i.test(key)) {
      return [key, '[REDACTED]'];
    }
    return [key, redactSystemTestJson(entry)];
  }));
}

async function lockRun(client: PoolClient, runId: string): Promise<LockedRunRow> {
  const result = await client.query<LockedRunRow>(
    'SELECT id, state FROM system_test_run WHERE id = $1 FOR UPDATE',
    [runId],
  );
  const row = result.rows[0];
  if (!row) throw new SystemTestRunStoreError(`system-test run ${runId} does not exist`);
  if (!isSystemTestRunState(row.state)) {
    throw new SystemTestRunStoreError(`system-test run ${runId} has unknown state ${String(row.state)}`);
  }
  return row;
}

async function appendTransition(
  client: PoolClient,
  run: LockedRunRow,
  to: SystemTestRunState,
  reason: string,
  at: Date,
): Promise<void> {
  if (run.state === to) return;
  if (!canTransitionSystemTestRun(run.state, to)) {
    throw new SystemTestRunConflictError(`illegal system-test transition ${run.state} -> ${to}`);
  }
  const sequenceResult = await client.query<{ next: number }>(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM system_test_transition WHERE run_id = $1',
    [run.id],
  );
  const sequence = Number(sequenceResult.rows[0]?.next ?? 1);
  await client.query(
    `INSERT INTO system_test_transition
       (run_id, sequence, from_state, to_state, reason, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [run.id, sequence, run.state, to, reason, at],
  );
  await client.query(
    `UPDATE system_test_run
        SET state = $2,
            summary = CASE WHEN $3 <> '' THEN $3 ELSE summary END,
            blocked_reasons = CASE
              WHEN $2 IN ('blocked', 'timed-out') AND $3 <> ''
                THEN blocked_reasons || jsonb_build_array($3::text)
              ELSE blocked_reasons
            END,
            started_at = CASE
              WHEN $2 IN ('provisioning', 'running') THEN COALESCE(started_at, $4)
              ELSE started_at
            END,
            finished_at = CASE
              WHEN $2 = ANY($5::text[]) THEN $4
              ELSE finished_at
            END,
            heartbeat_at = $4,
            updated_at = $4
      WHERE id = $1`,
    [run.id, to, reason, at, [...SYSTEM_TEST_RUN_OUTCOMES]],
  );
  if (to === 'timed-out') {
    await client.query(
      `UPDATE system_test_cleanup
          SET status = 'pending', requested_at = COALESCE(requested_at, $2),
              summary = CASE WHEN summary = '' THEN 'Cleanup required after stale-run recovery.' ELSE summary END,
              updated_at = $2
        WHERE run_id = $1 AND status <> 'failed'`,
      [run.id, at],
    );
  } else if (to === 'cleanup-failed') {
    await client.query(
      `UPDATE system_test_cleanup
          SET status = 'failed', summary = CASE WHEN $2 <> '' THEN $2 ELSE summary END,
              finished_at = COALESCE(finished_at, $3), updated_at = $3
        WHERE run_id = $1`,
      [run.id, reason, at],
    );
  }
  run.state = to;
}

export class PostgresSystemTestRunStore implements SystemTestRunQueueStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createRun(input: CreateSystemTestRunInput): Promise<StoredSystemTestRunSnapshot> {
    requireIdentifier(input.runId, 'runId', RUN_ID_PATTERN);
    requireText(input.idempotencyKey, 'idempotencyKey', 200);
    requireText(input.actor.id, 'actor.id', 160);
    if (input.actor.role !== 'operator' && input.actor.role !== 'release') {
      throw new SystemTestRunStoreError('actor.role is unknown');
    }
    const request = parseSystemTestRunRequest(input.request);
    const manifest = getSystemTestSuiteManifest(request.suiteId);
    const now = input.now ?? new Date();
    requireDate(now, 'now');
    const hash = requestHash(request, input.actor);

    try {
      await this.#transaction(async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO system_test_run
             (id, idempotency_key, request_hash, contract_version, suite_id, suite_version,
              profile, actor_id, actor_role, requested_sha, event_id, state, created_at, updated_at, heartbeat_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12, $12, $12)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [
            input.runId,
            input.idempotencyKey,
            hash,
            request.contractVersion,
            request.suiteId,
            request.suiteVersion,
            request.profile,
            input.actor.id,
            input.actor.role,
            request.requestedSha,
            request.eventId ?? null,
            now,
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await client.query<{ id: string; request_hash: string }>(
            'SELECT id, request_hash FROM system_test_run WHERE idempotency_key = $1 FOR UPDATE',
            [input.idempotencyKey],
          );
          const row = existing.rows[0];
          if (!row || row.request_hash !== hash) {
            throw new SystemTestRunConflictError(
              `idempotency key ${input.idempotencyKey} was already used for a different launch`,
            );
          }
          return;
        }

        await client.query(
          `INSERT INTO system_test_suite
             (run_id, suite_id, suite_version, profile, title, manifest_snapshot, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            input.runId,
            manifest.id,
            manifest.suiteVersion,
            request.profile,
            manifest.title,
            JSON.stringify(manifest),
            now,
          ],
        );
        for (const [ordinal, testCase] of manifest.cases.entries()) {
          await client.query(
            `INSERT INTO system_test_case (run_id, case_id, ordinal, title, status)
             VALUES ($1, $2, $3, $4, 'not-run')`,
            [input.runId, testCase.caseId, ordinal, testCase.title],
          );
        }
        await client.query(
          `INSERT INTO system_test_retention (run_id, results_expires_at, artifacts_expires_at, created_at)
           VALUES ($1, $2, $3, $4)`,
          [
            input.runId,
            plusDays(now, manifest.retention.resultDays),
            plusDays(now, manifest.retention.artifactDays),
            now,
          ],
        );
        await client.query(
          `INSERT INTO system_test_cleanup (run_id, status, updated_at)
           VALUES ($1, 'not-started', $2)`,
          [input.runId, now],
        );
        await client.query(
          `INSERT INTO system_test_transition
             (run_id, sequence, from_state, to_state, reason, occurred_at)
           VALUES ($1, 1, NULL, 'queued', 'Launch accepted.', $2)`,
          [input.runId, now],
        );
      });
    } catch (error) {
      if (pgCode(error) === '23505') {
        throw new SystemTestRunConflictError(`runId ${input.runId} already exists`, { cause: error });
      }
      throw error;
    }

    const snapshot = await this.getRunByIdempotencyKey(input.idempotencyKey);
    if (!snapshot) throw new SystemTestRunStoreError('created run could not be read back');
    return snapshot;
  }

  async advanceRun(
    runId: string,
    state: SystemTestRunState,
    options: { reason?: string; at?: Date } = {},
  ): Promise<StoredSystemTestRunSnapshot> {
    if (!isSystemTestRunState(state)) throw new SystemTestRunStoreError(`unknown run state ${String(state)}`);
    const at = options.at ?? new Date();
    requireDate(at, 'at');
    const reason = options.reason ?? '';
    if (reason.length > 2_000) throw new SystemTestRunStoreError('transition reason is too long');
    await this.#transaction(async (client) => {
      const run = await lockRun(client, runId);
      await appendTransition(client, run, state, redactSystemTestText(reason), at);
    });
    return this.requireRun(runId);
  }

  async heartbeat(runId: string, at = new Date()): Promise<void> {
    requireDate(at, 'at');
    const result = await this.#pool.query(
      `UPDATE system_test_run SET heartbeat_at = $2, updated_at = $2
        WHERE id = $1 AND state = ANY($3::text[])`,
      [runId, at, [...SYSTEM_TEST_RUN_PHASES]],
    );
    if (result.rowCount === 0) {
      const existing = await this.#pool.query('SELECT 1 FROM system_test_run WHERE id = $1', [runId]);
      if (existing.rowCount === 0) throw new SystemTestRunStoreError(`system-test run ${runId} does not exist`);
    }
  }

  async setDeploymentEvidence(runId: string, deployedSha: string, at = new Date()): Promise<void> {
    if (!SHA_PATTERN.test(deployedSha)) throw new SystemTestRunStoreError('deployedSha must be a full lowercase git SHA');
    requireDate(at, 'at');
    await this.#transaction(async (client) => {
      await lockRun(client, runId);
      const current = await client.query<{ deployed_sha: string | null }>(
        'SELECT deployed_sha FROM system_test_run WHERE id = $1',
        [runId],
      );
      const existing = current.rows[0]?.deployed_sha ?? null;
      if (existing && existing !== deployedSha) {
        throw new SystemTestRunConflictError(`run ${runId} already records deployed SHA ${existing}`);
      }
      await client.query(
        'UPDATE system_test_run SET deployed_sha = $2, heartbeat_at = $3, updated_at = $3 WHERE id = $1',
        [runId, deployedSha, at],
      );
    });
  }

  async recordCase(runId: string, input: RecordSystemTestCaseInput): Promise<void> {
    requireIdentifier(input.caseId, 'caseId');
    if (!CASE_STATUSES.has(input.status)) throw new SystemTestRunStoreError(`unknown case status ${String(input.status)}`);
    if (input.summary.length > 2_000) throw new SystemTestRunStoreError('case summary is too long');
    if (input.startedAt) requireDate(input.startedAt, 'startedAt');
    if (input.finishedAt) requireDate(input.finishedAt, 'finishedAt');
    const summary = redactSystemTestText(input.summary);
    await this.#transaction(async (client) => {
      const run = await lockRun(client, runId);
      const existing = await client.query<{
        status: SystemTestCaseStatus;
        summary: string;
        started_at: Date | null;
        finished_at: Date | null;
      }>(
        'SELECT status, summary, started_at, finished_at FROM system_test_case WHERE run_id = $1 AND case_id = $2 FOR UPDATE',
        [runId, input.caseId],
      );
      const row = existing.rows[0];
      if (!row) throw new SystemTestRunStoreError(`case ${input.caseId} is not in run ${runId}'s suite snapshot`);
      const same = row.status === input.status
        && row.summary === summary
        && nullableIso(row.started_at) === (input.startedAt?.toISOString() ?? null)
        && nullableIso(row.finished_at) === (input.finishedAt?.toISOString() ?? null);
      if (same) return;
      if (TERMINAL_STATES.has(run.state) || row.status !== 'not-run' || row.summary !== '') {
        throw new SystemTestRunConflictError(`case ${input.caseId} already has a different result`);
      }
      await client.query(
        `UPDATE system_test_case
            SET status = $3, summary = $4, started_at = $5, finished_at = $6
          WHERE run_id = $1 AND case_id = $2`,
        [runId, input.caseId, input.status, summary, input.startedAt ?? null, input.finishedAt ?? null],
      );
    });
  }

  async recordArtifact(runId: string, input: RecordSystemTestArtifactInput): Promise<void> {
    requireIdentifier(input.artifactId, 'artifactId');
    if (input.caseId) requireIdentifier(input.caseId, 'caseId');
    requireText(input.kind, 'artifact kind', 80);
    requireText(input.ref, 'artifact ref', 2_000);
    if (input.summary.length > 2_000) throw new SystemTestRunStoreError('artifact summary is too long');
    requireDate(input.capturedAt, 'capturedAt');
    if (!SHA_PATTERN.test(input.deployedSha)) throw new SystemTestRunStoreError('deployedSha must be a full lowercase git SHA');
    if (input.byteSize !== undefined && (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0)) {
      throw new SystemTestRunStoreError('byteSize must be a non-negative safe integer');
    }
    const ref = redactSystemTestText(input.ref);
    const summary = redactSystemTestText(input.summary);
    await this.#transaction(async (client) => {
      await lockRun(client, runId);
      const inserted = await client.query(
        `INSERT INTO system_test_artifact
           (run_id, artifact_id, case_id, kind, ref, summary, captured_at, deployed_sha, byte_size, redacted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
         ON CONFLICT (run_id, artifact_id) DO NOTHING`,
        [
          runId,
          input.artifactId,
          input.caseId ?? null,
          input.kind,
          ref,
          summary,
          input.capturedAt,
          input.deployedSha,
          input.byteSize ?? null,
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{
          case_id: string | null;
          kind: string;
          ref: string;
          summary: string;
          captured_at: Date;
          deployed_sha: string;
          byte_size: string | number | null;
        }>(
          `SELECT case_id, kind, ref, summary, captured_at, deployed_sha, byte_size
             FROM system_test_artifact WHERE run_id = $1 AND artifact_id = $2`,
          [runId, input.artifactId],
        );
        const row = existing.rows[0];
        const same = row?.case_id === (input.caseId ?? null)
          && row.kind === input.kind
          && row.ref === ref
          && row.summary === summary
          && iso(row.captured_at) === input.capturedAt.toISOString()
          && row.deployed_sha === input.deployedSha
          && (row.byte_size === null ? null : Number(row.byte_size)) === (input.byteSize ?? null);
        if (!same) throw new SystemTestRunConflictError(`artifact ${input.artifactId} already has different evidence`);
      }
    });
  }

  async recordEnvironment(runId: string, input: RecordSystemTestEnvironmentInput): Promise<void> {
    requireIdentifier(input.environmentId, 'environmentId');
    requireText(input.kind, 'environment kind', 80);
    requireText(input.status, 'environment status', 80);
    if (input.imageDigest && !DIGEST_PATTERN.test(input.imageDigest)) {
      throw new SystemTestRunStoreError('imageDigest must be a content-addressed sha256 digest');
    }
    const recordedAt = input.recordedAt ?? new Date();
    requireDate(recordedAt, 'recordedAt');
    const endpoint = input.endpointFingerprint ? redactSystemTestText(input.endpointFingerprint) : null;
    const config = input.configurationFingerprint ? redactSystemTestText(input.configurationFingerprint) : null;
    const details = redactSystemTestJson(input.details ?? {}) as Record<string, unknown>;
    await this.#transaction(async (client) => {
      await lockRun(client, runId);
      const inserted = await client.query(
        `INSERT INTO system_test_environment
           (run_id, environment_id, kind, status, image_digest, endpoint_fingerprint,
            configuration_fingerprint, details, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (run_id, environment_id) DO NOTHING`,
        [
          runId,
          input.environmentId,
          input.kind,
          input.status,
          input.imageDigest ?? null,
          endpoint,
          config,
          JSON.stringify(details),
          recordedAt,
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{
          kind: string;
          status: string;
          image_digest: string | null;
          endpoint_fingerprint: string | null;
          configuration_fingerprint: string | null;
          details: Record<string, unknown>;
          recorded_at: Date;
        }>(
          `SELECT kind, status, image_digest, endpoint_fingerprint, configuration_fingerprint, details, recorded_at
             FROM system_test_environment WHERE run_id = $1 AND environment_id = $2`,
          [runId, input.environmentId],
        );
        const row = existing.rows[0];
        const same = row?.kind === input.kind
          && row.status === input.status
          && row.image_digest === (input.imageDigest ?? null)
          && row.endpoint_fingerprint === endpoint
          && row.configuration_fingerprint === config
          && JSON.stringify(row.details) === JSON.stringify(details)
          && iso(row.recorded_at) === recordedAt.toISOString();
        if (!same) {
          throw new SystemTestRunConflictError(`environment ${input.environmentId} already has different evidence`);
        }
      }
    });
  }

  async requestCancellation(
    runId: string,
    input: { requestedBy: SystemTestActor; reason: string; at?: Date },
  ): Promise<StoredSystemTestRunSnapshot> {
    requireText(input.requestedBy.id, 'requestedBy.id', 160);
    requireText(input.reason, 'cancellation reason', 2_000);
    if (input.requestedBy.role !== 'operator' && input.requestedBy.role !== 'release') {
      throw new SystemTestRunStoreError('requestedBy.role is unknown');
    }
    const at = input.at ?? new Date();
    requireDate(at, 'at');
    const reason = redactSystemTestText(input.reason);
    await this.#transaction(async (client) => {
      await lockRun(client, runId);
      const inserted = await client.query(
        `INSERT INTO system_test_cancellation
           (run_id, requested_by_id, requested_by_role, reason, requested_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (run_id) DO NOTHING`,
        [runId, input.requestedBy.id, input.requestedBy.role, reason, at],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{
          requested_by_id: string;
          requested_by_role: SystemTestActor['role'];
          reason: string;
          requested_at: Date;
        }>('SELECT requested_by_id, requested_by_role, reason, requested_at FROM system_test_cancellation WHERE run_id = $1', [runId]);
        const row = existing.rows[0];
        const same = row?.requested_by_id === input.requestedBy.id
          && row.requested_by_role === input.requestedBy.role
          && row.reason === reason
          && iso(row.requested_at) === at.toISOString();
        if (!same) throw new SystemTestRunConflictError(`run ${runId} already has a different cancellation request`);
      }
    });
    return this.requireRun(runId);
  }

  async acknowledgeCancellation(runId: string, at = new Date()): Promise<StoredSystemTestRunSnapshot> {
    requireDate(at, 'at');
    await this.#transaction(async (client) => {
      const run = await lockRun(client, runId);
      const cancellation = await client.query<{ acknowledged_at: Date | null }>(
        'SELECT acknowledged_at FROM system_test_cancellation WHERE run_id = $1 FOR UPDATE',
        [runId],
      );
      if (!cancellation.rows[0]) throw new SystemTestRunStoreError(`run ${runId} has no cancellation request`);
      if (!cancellation.rows[0].acknowledged_at) {
        await client.query(
          'UPDATE system_test_cancellation SET acknowledged_at = $2 WHERE run_id = $1',
          [runId, at],
        );
      }
      await appendTransition(client, run, 'cancelled', 'Cancellation acknowledged by the worker.', at);
    });
    return this.requireRun(runId);
  }

  async recordCleanup(runId: string, input: RecordSystemTestCleanupInput): Promise<StoredSystemTestRunSnapshot> {
    if (!CLEANUP_STATUSES.has(input.status)) throw new SystemTestRunStoreError(`unknown cleanup status ${String(input.status)}`);
    if (input.summary.length > 2_000) throw new SystemTestRunStoreError('cleanup summary is too long');
    const at = input.at ?? new Date();
    requireDate(at, 'at');
    const summary = redactSystemTestText(input.summary);
    const allowed: Readonly<Record<SystemTestCleanupStatus, readonly SystemTestCleanupStatus[]>> = {
      'not-started': ['pending', 'running', 'succeeded', 'failed'],
      pending: ['running', 'succeeded', 'failed'],
      running: ['succeeded', 'failed'],
      succeeded: ['failed'],
      failed: [],
    };
    await this.#transaction(async (client) => {
      const run = await lockRun(client, runId);
      const existing = await client.query<{ status: SystemTestCleanupStatus; summary: string }>(
        'SELECT status, summary FROM system_test_cleanup WHERE run_id = $1 FOR UPDATE',
        [runId],
      );
      const row = existing.rows[0];
      if (!row) throw new SystemTestRunStoreError(`run ${runId} has no cleanup record`);
      if (row.status === input.status && row.summary === summary) return;
      if (row.status !== input.status && !allowed[row.status].includes(input.status)) {
        throw new SystemTestRunConflictError(`illegal cleanup transition ${row.status} -> ${input.status}`);
      }
      await client.query(
        `UPDATE system_test_cleanup
            SET status = $2,
                summary = $3,
                attempts = attempts + CASE WHEN $2 = 'running' AND status <> 'running' THEN 1 ELSE 0 END,
                requested_at = CASE WHEN $2 = 'pending' THEN COALESCE(requested_at, $4) ELSE requested_at END,
                started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, $4) ELSE started_at END,
                finished_at = CASE WHEN $2 IN ('succeeded', 'failed') THEN $4 ELSE finished_at END,
                updated_at = $4
          WHERE run_id = $1`,
        [runId, input.status, summary, at],
      );
      if (input.status === 'failed') await appendTransition(client, run, 'cleanup-failed', summary, at);
    });
    return this.requireRun(runId);
  }

  async recoverStaleRuns(cutoff: Date, now = new Date()): Promise<string[]> {
    requireDate(cutoff, 'cutoff');
    requireDate(now, 'now');
    return this.#transaction(async (client) => {
      const stale = await client.query<LockedRunRow>(
        `SELECT id, state
           FROM system_test_run
          WHERE state = ANY($1::text[]) AND heartbeat_at < $2
          ORDER BY heartbeat_at
          FOR UPDATE SKIP LOCKED`,
        [[...SYSTEM_TEST_RUN_PHASES], cutoff],
      );
      for (const run of stale.rows) {
        await appendTransition(
          client,
          run,
          'timed-out',
          `No heartbeat before ${cutoff.toISOString()}; stale run recovered.`,
          now,
        );
      }
      return stale.rows.map((row) => row.id);
    });
  }

  async claimNextRun(options: ClaimSystemTestRunOptions): Promise<StoredSystemTestRunSnapshot | null> {
    if (!Number.isInteger(options.maxConcurrentRuns) || options.maxConcurrentRuns < 1 || options.maxConcurrentRuns > 16) {
      throw new SystemTestRunStoreError('maxConcurrentRuns must be an integer between 1 and 16');
    }
    const now = options.now ?? new Date();
    requireDate(now, 'now');
    const runId = await this.#transaction(async (client) => {
      // Serialize the count+claim decision across every worker process. Row locks
      // alone prevent duplicate claims but cannot enforce a global concurrency cap.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sidestage-system-test-queue-v1'))");
      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM system_test_run
          WHERE state = ANY($1::text[])`,
        [['provisioning', 'running', 'collecting', 'cleaning']],
      );
      if (Number(active.rows[0]?.count ?? 0) >= options.maxConcurrentRuns) return null;

      const candidate = await client.query<LockedRunRow>(
        `SELECT id, state
           FROM system_test_run
          WHERE state = 'queued'
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      const run = candidate.rows[0];
      if (!run) return null;
      await appendTransition(client, run, 'provisioning', 'Claimed by the trusted system-test worker.', now);
      return run.id;
    });
    return runId ? this.requireRun(runId) : null;
  }

  async listRuns(options: ListSystemTestRunsOptions): Promise<StoredSystemTestRunSnapshot[]> {
    requireText(options.actor.id, 'actor.id', 160);
    if (options.actor.role !== 'operator' && options.actor.role !== 'release') {
      throw new SystemTestRunStoreError('actor.role is unknown');
    }
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SystemTestRunStoreError('limit must be an integer between 1 and 100');
    }
    const ids = await this.#pool.query<{ id: string }>(
      `SELECT id
         FROM system_test_run
        WHERE $2 = 'release' OR actor_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [options.actor.id, options.actor.role, limit],
    );
    return Promise.all(ids.rows.map((row) => this.requireRun(row.id)));
  }

  async purgeExpired(now = new Date()): Promise<PurgedSystemTestRuns> {
    requireDate(now, 'now');
    return this.#transaction(async (client) => {
      const artifacts = await client.query(
        `DELETE FROM system_test_artifact AS artifact
              USING system_test_retention AS retention
              WHERE artifact.run_id = retention.run_id
                AND retention.artifacts_expires_at <= $1`,
        [now],
      );
      const runs = await client.query(
        `DELETE FROM system_test_run AS run
              USING system_test_retention AS retention
              WHERE run.id = retention.run_id
                AND retention.results_expires_at <= $1
                AND run.state = ANY($2::text[])`,
        [now, [...SYSTEM_TEST_RUN_OUTCOMES]],
      );
      return { artifacts: artifacts.rowCount ?? 0, runs: runs.rowCount ?? 0 };
    });
  }

  async getRun(runId: string): Promise<StoredSystemTestRunSnapshot | null> {
    const runResult = await this.#pool.query<{
      id: string;
      idempotency_key: string;
      contract_version: number;
      suite_id: string;
      suite_version: number;
      profile: string;
      actor_id: string;
      actor_role: SystemTestActor['role'];
      requested_sha: string;
      event_id: string | null;
      deployed_sha: string | null;
      state: SystemTestRunState;
      blocked_reasons: unknown;
      summary: string;
      created_at: Date;
      updated_at: Date;
      heartbeat_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
    }>('SELECT * FROM system_test_run WHERE id = $1', [runId]);
    const runRow = runResult.rows[0];
    if (!runRow) return null;

    const [suiteResult, casesResult, artifactsResult, environmentsResult, transitionsResult, cancellationResult, retentionResult, cleanupResult] = await Promise.all([
      this.#pool.query<{
        suite_id: string;
        suite_version: number;
        profile: string;
        title: string;
        manifest_snapshot: Record<string, unknown>;
      }>('SELECT suite_id, suite_version, profile, title, manifest_snapshot FROM system_test_suite WHERE run_id = $1', [runId]),
      this.#pool.query<{
        case_id: string;
        ordinal: number;
        title: string;
        status: SystemTestCaseStatus;
        summary: string;
        started_at: Date | null;
        finished_at: Date | null;
      }>('SELECT case_id, ordinal, title, status, summary, started_at, finished_at FROM system_test_case WHERE run_id = $1 ORDER BY ordinal', [runId]),
      this.#pool.query<{
        artifact_id: string;
        case_id: string | null;
        kind: SystemTestEvidenceKind;
        ref: string;
        summary: string;
        captured_at: Date;
        deployed_sha: string;
        byte_size: string | number | null;
        redacted: boolean;
      }>('SELECT artifact_id, case_id, kind, ref, summary, captured_at, deployed_sha, byte_size, redacted FROM system_test_artifact WHERE run_id = $1 ORDER BY captured_at, artifact_id', [runId]),
      this.#pool.query<{
        environment_id: string;
        kind: string;
        status: string;
        image_digest: string | null;
        endpoint_fingerprint: string | null;
        configuration_fingerprint: string | null;
        details: Record<string, unknown>;
        recorded_at: Date;
      }>('SELECT environment_id, kind, status, image_digest, endpoint_fingerprint, configuration_fingerprint, details, recorded_at FROM system_test_environment WHERE run_id = $1 ORDER BY environment_id', [runId]),
      this.#pool.query<{
        sequence: number;
        from_state: SystemTestRunState | null;
        to_state: SystemTestRunState;
        reason: string;
        occurred_at: Date;
      }>('SELECT sequence, from_state, to_state, reason, occurred_at FROM system_test_transition WHERE run_id = $1 ORDER BY sequence', [runId]),
      this.#pool.query<{
        requested_by_id: string;
        requested_by_role: SystemTestActor['role'];
        reason: string;
        requested_at: Date;
        acknowledged_at: Date | null;
      }>('SELECT requested_by_id, requested_by_role, reason, requested_at, acknowledged_at FROM system_test_cancellation WHERE run_id = $1', [runId]),
      this.#pool.query<{ results_expires_at: Date; artifacts_expires_at: Date }>(
        'SELECT results_expires_at, artifacts_expires_at FROM system_test_retention WHERE run_id = $1',
        [runId],
      ),
      this.#pool.query<{
        status: SystemTestCleanupStatus;
        summary: string;
        attempts: number;
        requested_at: Date | null;
        started_at: Date | null;
        finished_at: Date | null;
        updated_at: Date;
      }>('SELECT status, summary, attempts, requested_at, started_at, finished_at, updated_at FROM system_test_cleanup WHERE run_id = $1', [runId]),
    ]);

    const suite = suiteResult.rows[0];
    const retention = retentionResult.rows[0];
    const cleanup = cleanupResult.rows[0];
    if (!suite || !retention || !cleanup) {
      throw new SystemTestRunStoreError(`run ${runId} is missing a normalized child record`);
    }
    if (!isSystemTestRunState(runRow.state)) {
      throw new SystemTestRunStoreError(`run ${runId} has unknown state ${String(runRow.state)}`);
    }

    const cancellation = cancellationResult.rows[0];
    return {
      run: {
        id: runRow.id,
        idempotencyKey: runRow.idempotency_key,
        contractVersion: runRow.contract_version,
        suiteId: runRow.suite_id,
        suiteVersion: runRow.suite_version,
        profile: runRow.profile,
        actor: { id: runRow.actor_id, role: runRow.actor_role },
        requestedSha: runRow.requested_sha,
        eventId: runRow.event_id,
        deployedSha: runRow.deployed_sha,
        state: runRow.state,
        blockedReasons: asStringArray(runRow.blocked_reasons),
        summary: runRow.summary,
        createdAt: iso(runRow.created_at),
        updatedAt: iso(runRow.updated_at),
        heartbeatAt: iso(runRow.heartbeat_at),
        startedAt: nullableIso(runRow.started_at),
        finishedAt: nullableIso(runRow.finished_at),
      },
      suite: {
        suiteId: suite.suite_id,
        suiteVersion: suite.suite_version,
        profile: suite.profile,
        title: suite.title,
        manifest: suite.manifest_snapshot,
      },
      cases: casesResult.rows.map((row) => ({
        caseId: row.case_id,
        ordinal: row.ordinal,
        title: row.title,
        status: row.status,
        summary: row.summary,
        startedAt: nullableIso(row.started_at),
        finishedAt: nullableIso(row.finished_at),
      })),
      artifacts: artifactsResult.rows.map((row) => ({
        artifactId: row.artifact_id,
        caseId: row.case_id,
        kind: row.kind,
        ref: row.ref,
        summary: row.summary,
        capturedAt: iso(row.captured_at),
        deployedSha: row.deployed_sha,
        byteSize: row.byte_size === null ? null : Number(row.byte_size),
        redacted: true,
      })),
      environments: environmentsResult.rows.map((row) => ({
        environmentId: row.environment_id,
        kind: row.kind,
        status: row.status,
        imageDigest: row.image_digest,
        endpointFingerprint: row.endpoint_fingerprint,
        configurationFingerprint: row.configuration_fingerprint,
        details: row.details,
        recordedAt: iso(row.recorded_at),
      })),
      transitions: transitionsResult.rows.map((row) => ({
        sequence: row.sequence,
        fromState: row.from_state,
        toState: row.to_state,
        reason: row.reason,
        occurredAt: iso(row.occurred_at),
      })),
      cancellation: cancellation ? {
        requestedBy: { id: cancellation.requested_by_id, role: cancellation.requested_by_role },
        reason: cancellation.reason,
        requestedAt: iso(cancellation.requested_at),
        acknowledgedAt: nullableIso(cancellation.acknowledged_at),
      } : null,
      retention: {
        resultsExpiresAt: iso(retention.results_expires_at),
        artifactsExpiresAt: iso(retention.artifacts_expires_at),
      },
      cleanup: {
        status: cleanup.status,
        summary: cleanup.summary,
        attempts: cleanup.attempts,
        requestedAt: nullableIso(cleanup.requested_at),
        startedAt: nullableIso(cleanup.started_at),
        finishedAt: nullableIso(cleanup.finished_at),
        updatedAt: iso(cleanup.updated_at),
      },
    };
  }

  async getRunByIdempotencyKey(key: string): Promise<StoredSystemTestRunSnapshot | null> {
    const result = await this.#pool.query<{ id: string }>(
      'SELECT id FROM system_test_run WHERE idempotency_key = $1',
      [key],
    );
    const id = result.rows[0]?.id;
    return id ? this.getRun(id) : null;
  }

  async requireRun(runId: string): Promise<StoredSystemTestRunSnapshot> {
    const run = await this.getRun(runId);
    if (!run) throw new SystemTestRunStoreError(`system-test run ${runId} does not exist`);
    return run;
  }
}
