import {
  SYSTEM_TEST_CONTRACT_VERSION,
  SYSTEM_TEST_SUITE_MANIFESTS,
  type SystemTestRunState,
} from '@papercusp/system-test-contract';
import {
  SystemTestExecutionBudget,
  type StoredSystemTestRunSnapshot,
  type SystemTestArtifactSink,
  type SystemTestPostgresQuery,
  type SystemTestRunReporter,
  type SystemTestSuiteExecutionContext,
} from '@papercusp/system-test-runner';
import { describe, expect, it, vi } from 'vitest';

import { createActionsSuiteExecutor } from './actions-suite-executor';

const SHA = 'a'.repeat(40);

function snapshot(): StoredSystemTestRunSnapshot {
  const manifest = SYSTEM_TEST_SUITE_MANIFESTS.actions;
  const now = new Date().toISOString();
  return {
    run: {
      id: 'run-actions-1', idempotencyKey: 'actions-1', contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
      suiteId: 'actions', suiteVersion: manifest.suiteVersion, profile: 'smoke',
      actor: { id: 'demo-seller', role: 'operator' }, requestedSha: SHA, eventId: null,
      deployedSha: null, state: 'provisioning', blockedReasons: [], summary: '',
      createdAt: now, updatedAt: now, heartbeatAt: now, startedAt: now, finishedAt: null,
    },
    suite: {
      suiteId: 'actions', suiteVersion: manifest.suiteVersion, profile: 'smoke',
      title: manifest.title, manifest: { ...manifest },
    },
    cases: [], artifacts: [], environments: [], transitions: [], cancellation: null,
    retention: { resultsExpiresAt: now, artifactsExpiresAt: now },
    cleanup: {
      status: 'not-started', summary: '', attempts: 0,
      requestedAt: null, startedAt: null, finishedAt: null, updatedAt: now,
    },
  };
}

function harness() {
  const run = snapshot();
  const states: SystemTestRunState[] = [];
  const cases = new Map<string, string>();
  const summaries = new Map<string, string>();
  const artifacts: string[] = [];
  const reporter = {
    setDeploymentEvidence: vi.fn(async (_runId: string, sha: string) => { run.run.deployedSha = sha; }),
    recordEnvironment: vi.fn(async () => undefined),
    recordCase: vi.fn(async (_runId: string, input: { caseId: string; status: string; summary: string }) => {
      cases.set(input.caseId, input.status);
      summaries.set(input.caseId, input.summary);
    }),
    recordArtifact: vi.fn(async (_runId: string, input: { artifactId: string }) => {
      artifacts.push(input.artifactId);
    }),
    recordCleanup: vi.fn(async () => run),
    advanceRun: vi.fn(async (_runId: string, state: SystemTestRunState) => {
      run.run.state = state;
      states.push(state);
      return run;
    }),
    heartbeat: vi.fn(async () => undefined),
    getRun: vi.fn(async () => run),
    createRun: vi.fn(), requestCancellation: vi.fn(), acknowledgeCancellation: vi.fn(),
  } as unknown as SystemTestRunReporter;
  const context: SystemTestSuiteExecutionContext = {
    run,
    manifest: SYSTEM_TEST_SUITE_MANIFESTS.actions,
    reporter,
    signal: new AbortController().signal,
    attempt: 1,
    budget: new SystemTestExecutionBudget(SYSTEM_TEST_SUITE_MANIFESTS.actions.budget),
  };
  return { context, reporter, states, cases, summaries, artifacts };
}

function fixture() {
  let price = 2_400;
  let auditCount = 0;
  let rolledBack = false;
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/healthz') {
      return Response.json({ status: 'ok', service: 'sidestage-api', sha: SHA });
    }
    if (url.pathname === '/api/sync/sse') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(encoder.encode('id: heartbeat-1\nevent: heartbeat\ndata: {"tsMs":1}\n\n'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname.endsWith('/config')) return Response.json({ eventId: 'created' });
    if (url.pathname.endsWith('/register')) return Response.json({ items: [{}] }, { status: 201 });
    if (url.pathname.endsWith('/execute')) {
      const body = JSON.parse(String(init?.body)) as { action: { priceCents: number } };
      if (body.action.priceCents === 1_000) {
        return Response.json({ code: 'price-floor' }, { status: 400 });
      }
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      price = 2_200;
      auditCount = 1;
      stream?.enqueue(encoder.encode(
        'id: invalidate-1\nevent: invalidate\ndata: {"name":"event.lineup.items","args":{"eventId":"sst-actions-run-actions-1"}}\n\n',
      ));
      stream?.close();
      return Response.json({ auditId: 'audit-allowed', state: { priceCents: price } }, { status: 201 });
    }
    if (url.pathname.endsWith('/rollback')) {
      price = 2_400;
      auditCount = 2;
      rolledBack = true;
      return Response.json({
        auditId: 'audit-rollback', rolledBackAuditId: 'audit-allowed', state: { priceCents: price },
      }, { status: 201 });
    }
    throw new Error(`unexpected URL ${url.pathname}`);
  }) as unknown as typeof fetch;

  const queryable: SystemTestPostgresQuery = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT 1')) return { rows: [{ acceptance_ready: 1 }] };
      if (sql.includes('audit.client_request_id')) {
        return { rows: [{
          audit_id: 'audit-allowed', actor_id: 'demo-seller', kind: 'markdown',
          client_request_id: 'run-actions-1-allowed', current_price_cents: price,
        }] };
      }
      if (sql.includes('audit_count')) return { rows: [{ current_price_cents: price, audit_count: auditCount }] };
      if (sql.includes('rollback.kind')) return { rows: [{
        rolled_back_at: rolledBack ? new Date().toISOString() : null,
        rollback_id: 'audit-rollback', rollback_kind: 'rollback', current_price_cents: price,
      }] };
      throw new Error('unexpected query');
    }) as unknown as SystemTestPostgresQuery['query'],
  };
  const artifactSink: SystemTestArtifactSink = {
    write: vi.fn(async ({ runId, artifactId }) => `artifact://${runId}/${artifactId}`),
  };
  return { fetch: fetchStub, queryable, artifactSink };
}

const environment = {
  SYSTEM_TEST_API_URL: 'http://api:3100',
  SYSTEM_TEST_DATABASE_URL: 'postgresql://acceptance:secret@postgres:5432/acceptance_actions',
  SYSTEM_TEST_ARTIFACT_ROOT: '/tmp/sidestage-system-test-artifacts',
  SIDESTAGE_SHA: SHA,
};

describe('Actions system-test executor', () => {
  it('runs the allowed, invalidation, audit, forbidden, and rollback proof to a durable pass', async () => {
    const { context, states, cases, summaries, artifacts } = harness();
    const dependencies = fixture();

    await createActionsSuiteExecutor(environment, dependencies)(context);

    expect(states, JSON.stringify([...summaries])).toEqual(['running', 'collecting', 'cleaning', 'passed']);
    expect([...cases]).toEqual(SYSTEM_TEST_SUITE_MANIFESTS.actions.cases.map(({ caseId }) => [caseId, 'passed']));
    expect(artifacts).toEqual(expect.arrayContaining([
      'actions.allowed.http',
      'actions.subscriber.sse',
      'actions.allowed.postgres',
      'actions.forbidden.postgres',
      'actions.rollback.postgres',
    ]));
  });

  it('records every case blocked when the allow-listed internal configuration is absent or unsafe', async () => {
    const missing = harness();
    await createActionsSuiteExecutor({})(missing.context);
    expect(missing.states).toEqual(['blocked']);
    expect([...missing.cases.values()]).toEqual(Array(5).fill('blocked'));

    const external = harness();
    await createActionsSuiteExecutor({ ...environment, SYSTEM_TEST_API_URL: 'https://sidestage.buyrestart.com' })(
      external.context,
    );
    expect(external.states).toEqual(['blocked']);
    expect([...external.cases.values()]).toEqual(Array(5).fill('blocked'));
  });
});
