import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SYSTEM_TEST_CONTRACT_VERSION, SYSTEM_TEST_SUITE_MANIFESTS } from '@papercusp/system-test-contract';
import { createMigratedTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresSystemTestRunStore,
  SystemTestRunConflictError,
  type CreateSystemTestRunInput,
} from './postgres-run-store';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const BASE_TIME = new Date('2026-08-14T20:00:00.000Z');
const SCHEMA_SQL = resolve(__dirname, '../../../db/schema.sql');

let database: MigratedTestDb;
let pool: Pool;
let store: PostgresSystemTestRunStore;

function launch(
  runId: string,
  idempotencyKey: string,
  now = BASE_TIME,
): CreateSystemTestRunInput {
  return {
    runId,
    idempotencyKey,
    request: {
      contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
      suiteId: 'actions',
      suiteVersion: SYSTEM_TEST_SUITE_MANIFESTS.actions.suiteVersion,
      profile: 'smoke',
      requestedSha: SHA,
    },
    actor: { id: 'operator-integration', role: 'operator' },
    now,
  };
}

beforeAll(async () => {
  database = await createMigratedTestDb([SCHEMA_SQL]);
  pool = new Pool({ connectionString: database.url, max: 3 });
  store = new PostgresSystemTestRunStore(pool);
});

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('PostgresSystemTestRunStore', () => {
  it('re-applies the production schema idempotently with all normalized run tables intact', async () => {
    const schema = readFileSync(SCHEMA_SQL, 'utf8');
    await pool.query(schema);
    await pool.query(schema);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'system_test_%'
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'system_test_artifact',
      'system_test_cancellation',
      'system_test_case',
      'system_test_cleanup',
      'system_test_environment',
      'system_test_retention',
      'system_test_run',
      'system_test_suite',
      'system_test_transition',
    ]);
  });

  it('creates one normalized, idempotent snapshot for one allow-listed suite launch', async () => {
    const input = launch('run-create-1', 'launch-create-1');
    const first = await store.createRun(input);
    const replay = await store.createRun(input);

    expect(replay).toEqual(first);
    expect(first.run).toMatchObject({
      id: 'run-create-1',
      suiteId: 'actions',
      state: 'queued',
      requestedSha: SHA,
    });
    expect(first.suite.manifest).toMatchObject({ id: 'actions', suiteVersion: 1 });
    expect(first.cases.map((entry) => entry.caseId)).toEqual(
      SYSTEM_TEST_SUITE_MANIFESTS.actions.cases.map((entry) => entry.caseId),
    );
    expect(first.transitions).toEqual([
      expect.objectContaining({ sequence: 1, fromState: null, toState: 'queued' }),
    ]);
    expect(first.cleanup.status).toBe('not-started');

    await expect(store.createRun({
      ...launch('run-create-2', 'launch-create-1'),
      request: { ...input.request, requestedSha: 'c'.repeat(40) },
    })).rejects.toBeInstanceOf(SystemTestRunConflictError);

    const counts = await pool.query<{ table_name: string; rows: string }>(
      `SELECT 'run' AS table_name, count(*)::text AS rows FROM system_test_run WHERE id = $1
       UNION ALL SELECT 'suite', count(*)::text FROM system_test_suite WHERE run_id = $1
       UNION ALL SELECT 'case', count(*)::text FROM system_test_case WHERE run_id = $1
       UNION ALL SELECT 'retention', count(*)::text FROM system_test_retention WHERE run_id = $1
       UNION ALL SELECT 'cleanup', count(*)::text FROM system_test_cleanup WHERE run_id = $1`,
      [input.runId],
    );
    expect(Object.fromEntries(counts.rows.map((row) => [row.table_name, Number(row.rows)]))).toEqual({
      run: 1,
      suite: 1,
      case: SYSTEM_TEST_SUITE_MANIFESTS.actions.cases.length,
      retention: 1,
      cleanup: 1,
    });
  });

  it('persists evidence idempotently, refuses regressions, and lets cleanup failure override a pass', async () => {
    await store.createRun(launch('run-result-1', 'launch-result-1'));
    await store.advanceRun('run-result-1', 'provisioning', { at: new Date('2026-08-14T20:00:01Z') });
    await store.advanceRun('run-result-1', 'running', { at: new Date('2026-08-14T20:00:02Z') });
    await store.setDeploymentEvidence('run-result-1', SHA, new Date('2026-08-14T20:00:03Z'));

    const environment = {
      environmentId: 'api',
      kind: 'service',
      status: 'healthy',
      imageDigest: DIGEST,
      endpointFingerprint: 'https://operator:secret@api.example.test/health?token=hidden',
      configurationFingerprint: 'api_key=hidden-config',
      details: { service: 'sidestage-api', accessToken: 'hidden-details' },
      recordedAt: new Date('2026-08-14T20:00:04Z'),
    } as const;
    await store.recordEnvironment('run-result-1', environment);
    await store.recordEnvironment('run-result-1', environment);

    const caseResult = {
      caseId: SYSTEM_TEST_SUITE_MANIFESTS.actions.cases[0]!.caseId,
      status: 'passed' as const,
      summary: 'Protocol succeeded.',
      startedAt: new Date('2026-08-14T20:00:05Z'),
      finishedAt: new Date('2026-08-14T20:00:06Z'),
    };
    await store.recordCase('run-result-1', caseResult);
    await store.recordCase('run-result-1', caseResult);

    const artifact = {
      artifactId: 'http-proof-1',
      caseId: caseResult.caseId,
      kind: 'http' as const,
      ref: 'https://operator:secret@artifacts.example.test/result.json?access_token=hidden#fragment',
      summary: 'Bearer token-value api_key=hidden-summary',
      capturedAt: new Date('2026-08-14T20:00:07Z'),
      deployedSha: SHA,
      byteSize: 512,
    };
    await store.recordArtifact('run-result-1', artifact);
    await store.recordArtifact('run-result-1', artifact);

    await store.advanceRun('run-result-1', 'collecting', { at: new Date('2026-08-14T20:00:08Z') });
    await store.advanceRun('run-result-1', 'cleaning', { at: new Date('2026-08-14T20:00:09Z') });
    await store.recordCleanup('run-result-1', {
      status: 'pending', summary: 'Teardown queued.', at: new Date('2026-08-14T20:00:10Z'),
    });
    await store.recordCleanup('run-result-1', {
      status: 'running', summary: 'Teardown running.', at: new Date('2026-08-14T20:00:11Z'),
    });
    await store.recordCleanup('run-result-1', {
      status: 'succeeded', summary: 'Resources removed.', at: new Date('2026-08-14T20:00:12Z'),
    });
    const passed = await store.advanceRun('run-result-1', 'passed', {
      reason: 'Required case evidence passed.', at: new Date('2026-08-14T20:00:13Z'),
    });

    expect(passed.run.state).toBe('passed');
    expect(passed.artifacts).toEqual([
      expect.objectContaining({
        ref: 'https://artifacts.example.test/result.json',
        summary: 'Bearer [REDACTED] api_key=[REDACTED]',
        redacted: true,
      }),
    ]);
    expect(passed.environments[0]).toMatchObject({
      endpointFingerprint: 'https://api.example.test/health',
      configurationFingerprint: 'api_key=[REDACTED]',
      details: { service: 'sidestage-api', accessToken: '[REDACTED]' },
    });
    expect(passed.cleanup).toMatchObject({ status: 'succeeded', attempts: 1 });
    await expect(store.advanceRun('run-result-1', 'running')).rejects.toBeInstanceOf(SystemTestRunConflictError);

    const cleanupFailed = await store.recordCleanup('run-result-1', {
      status: 'failed', summary: 'Network removal failed.', at: new Date('2026-08-14T20:00:14Z'),
    });
    expect(cleanupFailed.run.state).toBe('cleanup-failed');
    expect(cleanupFailed.cleanup.status).toBe('failed');
    expect(cleanupFailed.transitions.at(-1)).toMatchObject({
      fromState: 'passed',
      toState: 'cleanup-failed',
    });
  });

  it('records cancellation separately and only the worker acknowledgement makes it terminal', async () => {
    await store.createRun(launch('run-cancel-1', 'launch-cancel-1'));
    const requested = await store.requestCancellation('run-cancel-1', {
      requestedBy: { id: 'operator-integration', role: 'operator' },
      reason: 'Operator stopped the run.',
      at: new Date('2026-08-14T20:10:00Z'),
    });
    expect(requested.run.state).toBe('queued');
    expect(requested.cancellation).toMatchObject({ acknowledgedAt: null });

    const acknowledged = await store.acknowledgeCancellation(
      'run-cancel-1',
      new Date('2026-08-14T20:10:01Z'),
    );
    expect(acknowledged.run.state).toBe('cancelled');
    expect(acknowledged.cancellation?.acknowledgedAt).toBe('2026-08-14T20:10:01.000Z');
  });

  it('atomically enforces the global queue cap and preserves event scope for retry', async () => {
    await store.createRun({
      ...launch('run-claim-1', 'launch-claim-1'),
      request: { ...launch('ignored', 'ignored').request, eventId: 'fixture-event-claim' },
    });
    await store.createRun(launch('run-claim-2', 'launch-claim-2'));

    const first = await store.claimNextRun({ maxConcurrentRuns: 1, now: new Date('2026-08-14T20:20:00Z') });
    const capped = await store.claimNextRun({ maxConcurrentRuns: 1, now: new Date('2026-08-14T20:20:01Z') });

    expect(first?.run).toMatchObject({ id: 'run-claim-1', state: 'provisioning', eventId: 'fixture-event-claim' });
    expect(capped).toBeNull();

    await store.advanceRun('run-claim-1', 'blocked', { reason: 'Executor unavailable.' });
    const second = await store.claimNextRun({ maxConcurrentRuns: 1, now: new Date('2026-08-14T20:20:02Z') });
    expect(second?.run).toMatchObject({ id: 'run-claim-2', state: 'provisioning' });
  });

  it('lists only the requesting operator runs while a release principal can inspect all', async () => {
    await store.createRun({ ...launch('run-list-a', 'launch-list-a'), actor: { id: 'operator-a', role: 'operator' } });
    await store.createRun({ ...launch('run-list-b', 'launch-list-b'), actor: { id: 'operator-b', role: 'operator' } });

    const operator = await store.listRuns({ actor: { id: 'operator-a', role: 'operator' }, limit: 100 });
    const release = await store.listRuns({ actor: { id: 'release-bot', role: 'release' }, limit: 100 });

    expect(operator.map((entry) => entry.run.id)).toContain('run-list-a');
    expect(operator.map((entry) => entry.run.id)).not.toContain('run-list-b');
    expect(release.map((entry) => entry.run.id)).toEqual(expect.arrayContaining(['run-list-a', 'run-list-b']));
  });

  it('recovers stale nonterminal rows to timed-out with cleanup pending', async () => {
    await store.createRun(launch('run-stale-1', 'launch-stale-1', new Date('2026-08-01T00:00:00Z')));
    await store.advanceRun('run-stale-1', 'provisioning', { at: new Date('2026-08-01T00:00:01Z') });

    const recovered = await store.recoverStaleRuns(
      new Date('2026-08-01T00:01:00Z'),
      new Date('2026-08-14T21:00:00Z'),
    );
    expect(recovered).toContain('run-stale-1');
    const snapshot = await store.requireRun('run-stale-1');
    expect(snapshot.run.state).toBe('timed-out');
    expect(snapshot.cleanup.status).toBe('pending');
    expect(snapshot.transitions.at(-1)).toMatchObject({
      fromState: 'provisioning',
      toState: 'timed-out',
    });
  });

  it('purges expired artifacts before terminal run records and leaves live runs intact', async () => {
    await store.createRun(launch('run-purge-1', 'launch-purge-1'));
    await store.setDeploymentEvidence('run-purge-1', SHA);
    await store.recordArtifact('run-purge-1', {
      artifactId: 'purge-proof-1',
      kind: 'log',
      ref: 'artifact://run-purge-1/log',
      summary: 'Retained log.',
      capturedAt: BASE_TIME,
      deployedSha: SHA,
    });
    await pool.query(
      `UPDATE system_test_retention
          SET artifacts_expires_at = $2, results_expires_at = $2
        WHERE run_id = $1`,
      ['run-purge-1', new Date('2026-08-14T19:00:00Z')],
    );

    const livePurge = await store.purgeExpired(BASE_TIME);
    expect(livePurge).toEqual({ artifacts: 1, runs: 0 });
    expect(await store.getRun('run-purge-1')).not.toBeNull();

    await store.advanceRun('run-purge-1', 'blocked', {
      reason: 'Prerequisite unavailable.', at: new Date('2026-08-14T20:00:01Z'),
    });
    const terminalPurge = await store.purgeExpired(new Date('2026-08-14T20:00:02Z'));
    expect(terminalPurge).toEqual({ artifacts: 0, runs: 1 });
    expect(await store.getRun('run-purge-1')).toBeNull();
  });
});
