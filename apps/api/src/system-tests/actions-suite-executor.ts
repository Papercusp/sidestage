import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';

import {
  AuthenticatedHttpClient,
  AuthenticatedSseClient,
  FileSystemSystemTestArtifactSink,
  PostgresBlackBoxClient,
  SystemTestEvidenceCollector,
  type SystemTestArtifactSink,
  type SystemTestPostgresQuery,
  type SystemTestSuiteExecutionContext,
  type SystemTestSuiteExecutor,
} from '@papercusp/system-test-runner';
import { Pool } from 'pg';

const SELLER_ID = 'demo-seller';
const PRODUCT_ID = 'stoneware-mug-matte-12oz';
const REFERENCE_PRICE_CENTS = 2_400;
const ALLOWED_PRICE_CENTS = 2_200;
const FORBIDDEN_PRICE_CENTS = 1_000;
const CASE_IDS = [
  'protocol.allowed-action',
  'protocol.subscriber-invalidated',
  'evidence.audit-persisted',
  'protocol.forbidden-no-side-effect',
  'protocol.rollback-restored',
] as const;

type ActionsCaseId = (typeof CASE_IDS)[number];

interface ActionsSuiteConfiguration {
  apiUrl: URL;
  databaseUrl: string;
  artifactRoot: string;
  deployedSha: string;
}

interface CloseableQuery extends SystemTestPostgresQuery {
  end(): Promise<void>;
}

export interface ActionsSuiteExecutorDependencies {
  fetch?: typeof fetch;
  queryable?: SystemTestPostgresQuery;
  artifactSink?: SystemTestArtifactSink;
  now?: () => Date;
}

class ActionsSuiteConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionsSuiteConfigurationError';
  }
}

class ActionsSuiteCaseError extends Error {
  constructor(readonly caseId: ActionsCaseId, cause: unknown) {
    super(`${caseId}: ${errorText(cause)}`, { cause });
    this.name = 'ActionsSuiteCaseError';
  }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-postgres-url]').slice(0, 500);
}

function requireEnvironment(
  environment: NodeJS.ProcessEnv,
  name: 'SYSTEM_TEST_API_URL' | 'SYSTEM_TEST_DATABASE_URL' | 'SYSTEM_TEST_ARTIFACT_ROOT' | 'SIDESTAGE_SHA',
): string {
  const value = environment[name]?.trim();
  if (!value) throw new ActionsSuiteConfigurationError(`${name} is required`);
  return value;
}

function isInternalHost(hostname: string, service: 'api' | 'postgres'): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === service
    || normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1';
}

function parseConfiguration(environment: NodeJS.ProcessEnv): ActionsSuiteConfiguration {
  const apiValue = requireEnvironment(environment, 'SYSTEM_TEST_API_URL');
  const databaseValue = requireEnvironment(environment, 'SYSTEM_TEST_DATABASE_URL');
  const artifactValue = requireEnvironment(environment, 'SYSTEM_TEST_ARTIFACT_ROOT');
  const deployedSha = requireEnvironment(environment, 'SIDESTAGE_SHA');

  let apiUrl: URL;
  let databaseUrl: URL;
  try {
    apiUrl = new URL(apiValue);
  } catch {
    throw new ActionsSuiteConfigurationError('SYSTEM_TEST_API_URL must be an absolute URL');
  }
  try {
    databaseUrl = new URL(databaseValue);
  } catch {
    throw new ActionsSuiteConfigurationError('SYSTEM_TEST_DATABASE_URL must be an absolute PostgreSQL URL');
  }
  if (apiUrl.protocol !== 'http:' || !isInternalHost(apiUrl.hostname, 'api')) {
    throw new ActionsSuiteConfigurationError('SYSTEM_TEST_API_URL must target the internal API or loopback over HTTP');
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash || !['', '/'].includes(apiUrl.pathname)) {
    throw new ActionsSuiteConfigurationError('SYSTEM_TEST_API_URL cannot contain credentials, query, fragment, or a path prefix');
  }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
    || !isInternalHost(databaseUrl.hostname, 'postgres')) {
    throw new ActionsSuiteConfigurationError(
      'SYSTEM_TEST_DATABASE_URL must target the internal PostgreSQL service or loopback',
    );
  }
  if (!databaseUrl.pathname || databaseUrl.pathname === '/' || databaseUrl.search || databaseUrl.hash) {
    throw new ActionsSuiteConfigurationError('SYSTEM_TEST_DATABASE_URL must name one isolated database');
  }
  if (!isAbsolute(artifactValue)) {
    throw new ActionsSuiteConfigurationError('SYSTEM_TEST_ARTIFACT_ROOT must be absolute');
  }
  const artifactRoot = resolve(artifactValue);
  if (artifactRoot === sep || /(?:^|\/)opt\/sidestage(?:\/|$)/i.test(artifactRoot)) {
    throw new ActionsSuiteConfigurationError('SYSTEM_TEST_ARTIFACT_ROOT must be an isolated non-production directory');
  }
  if (!/^[0-9a-f]{40}$/.test(deployedSha)) {
    throw new ActionsSuiteConfigurationError('SIDESTAGE_SHA must be a full lowercase git SHA');
  }
  return { apiUrl, databaseUrl: databaseValue, artifactRoot, deployedSha };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function databaseFingerprint(value: string): string {
  const url = new URL(value);
  return fingerprint(`${url.protocol}//${url.hostname}:${url.port}${url.pathname}`);
}

function eventIdFor(runId: string): string {
  return `sst-actions-${runId}`.slice(0, 64);
}

function assertion(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function abortableFetch(
  fetchImpl: typeof fetch,
  url: URL,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('acceptance API health check timed out')), timeoutMs);
  return fetchImpl(url, {
    headers: { 'x-demo-principal': SELLER_ID },
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  });
}

async function blockSuite(
  context: SystemTestSuiteExecutionContext,
  reason: string,
  now: () => Date,
): Promise<void> {
  for (const testCase of context.manifest.cases) {
    await context.reporter.recordCase(context.run.run.id, {
      caseId: testCase.caseId,
      status: 'blocked',
      summary: reason,
      startedAt: now(),
      finishedAt: now(),
    });
  }
  await context.reporter.advanceRun(context.run.run.id, 'blocked', { reason, at: now() });
}

function invalidatedLineup(data: string, eventId: string): boolean {
  try {
    const value = JSON.parse(data) as { name?: unknown; args?: { eventId?: unknown } };
    return value.name === 'event.lineup.items' && value.args?.eventId === eventId;
  } catch {
    return false;
  }
}

/**
 * Trusted, allow-listed black-box executor for the Actions suite. All mutable
 * setup and assertions cross the deployed HTTP/API and PostgreSQL seams; no
 * production endpoint or in-process domain service is reachable from here.
 */
export function createActionsSuiteExecutor(
  environment: NodeJS.ProcessEnv,
  dependencies: ActionsSuiteExecutorDependencies = {},
): SystemTestSuiteExecutor {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return async (context) => {
    const runId = context.run.run.id;
    let configuration: ActionsSuiteConfiguration;
    try {
      configuration = parseConfiguration(environment);
      if (configuration.deployedSha !== context.run.run.requestedSha) {
        throw new ActionsSuiteConfigurationError('worker SHA does not match the run requested SHA');
      }
    } catch (error) {
      const reason = `Actions suite prerequisites are blocked: ${errorText(error)}`;
      await blockSuite(context, reason, now);
      return;
    }

    let ownedPool: CloseableQuery | null = null;
    const queryable = dependencies.queryable ?? (() => {
      const pool = new Pool({
        connectionString: configuration.databaseUrl,
        max: 2,
        connectionTimeoutMillis: 2_000,
      });
      ownedPool = pool;
      return pool;
    })();

    try {
      const healthUrl = new URL('/healthz', configuration.apiUrl);
      const [healthResponse] = await Promise.all([
        abortableFetch(fetchImpl, healthUrl, context.signal),
        queryable.query('SELECT 1 AS acceptance_ready'),
      ]);
      const health = await healthResponse.json() as { status?: unknown; service?: unknown; sha?: unknown };
      assertion(healthResponse.ok, 'acceptance API health endpoint was unavailable');
      assertion(health.status === 'ok' && health.service === 'sidestage-api', 'acceptance API health payload was invalid');
      assertion(health.sha === context.run.run.requestedSha, 'acceptance API did not prove the requested SHA');
    } catch (error) {
      await ownedPool?.end().catch(() => undefined);
      ownedPool = null;
      await blockSuite(
        context,
        `Actions suite prerequisites are blocked: isolated API or PostgreSQL is unavailable (${errorText(error)}).`,
        now,
      );
      return;
    }

    await context.reporter.setDeploymentEvidence(runId, configuration.deployedSha, now());
    await Promise.all([
      context.reporter.recordEnvironment(runId, {
        environmentId: 'actions-api',
        kind: 'http-api',
        status: 'ready',
        endpointFingerprint: fingerprint(configuration.apiUrl.origin),
        configurationFingerprint: fingerprint(configuration.deployedSha),
        details: { internal: true, shaVerified: true },
        recordedAt: now(),
      }),
      context.reporter.recordEnvironment(runId, {
        environmentId: 'actions-postgres',
        kind: 'postgresql',
        status: 'ready',
        endpointFingerprint: databaseFingerprint(configuration.databaseUrl),
        configurationFingerprint: fingerprint(configuration.artifactRoot),
        details: { internal: true, isolated: true },
        recordedAt: now(),
      }),
    ]);
    await context.reporter.advanceRun(runId, 'running', {
      reason: 'Isolated Actions dependencies and requested SHA verified.',
      at: now(),
    });

    const evidence = new SystemTestEvidenceCollector({
      runId,
      requestedSha: context.run.run.requestedSha,
      deployedSha: configuration.deployedSha,
      reporter: context.reporter,
      budget: context.budget,
      sink: dependencies.artifactSink ?? new FileSystemSystemTestArtifactSink(configuration.artifactRoot),
      now,
    });
    const authentication = { 'x-demo-principal': SELLER_ID } as const;
    const http = new AuthenticatedHttpClient({
      baseUrl: configuration.apiUrl.origin,
      authentication,
      evidence,
      fetch: fetchImpl,
      maxAttempts: 2,
    });
    const sse = new AuthenticatedSseClient({
      baseUrl: configuration.apiUrl.origin,
      authentication,
      evidence,
      fetch: fetchImpl,
      maxAttempts: 2,
    });
    const postgres = new PostgresBlackBoxClient(queryable, evidence);
    const eventId = eventIdFor(runId);
    const clientRequestId = `${runId}-allowed`;
    let allowedAuditId = '';
    let sseOutcome: Promise<
      | { ok: true; value: Awaited<ReturnType<AuthenticatedSseClient['collect']>> }
      | { ok: false; error: unknown }
    > | null = null;

    const runCase = async (caseId: ActionsCaseId, work: () => Promise<string>): Promise<void> => {
      const startedAt = now();
      try {
        const summary = await work();
        await context.reporter.recordCase(runId, {
          caseId,
          status: 'passed',
          summary,
          startedAt,
          finishedAt: now(),
        });
      } catch (error) {
        await context.reporter.recordCase(runId, {
          caseId,
          status: 'failed',
          summary: errorText(error),
          startedAt,
          finishedAt: now(),
        });
        throw new ActionsSuiteCaseError(caseId, error);
      }
    };

    try {
      await runCase('protocol.allowed-action', async () => {
        await http.request({
          artifactId: 'actions.config.http',
          caseId: 'protocol.allowed-action',
          method: 'PUT',
          path: `/api/events/${eventId}/config`,
          body: {
            name: `Actions acceptance ${runId}`,
            replyTone: 'warm',
            guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
          },
          expectedStatus: 200,
        });
        await http.request({
          artifactId: 'actions.register.http',
          caseId: 'protocol.allowed-action',
          method: 'POST',
          path: `/api/actions/events/${eventId}/register`,
          body: {
            policy: {
              automationLevel: 'confirm',
              allowAutoActions: false,
              priceFloorCentsByProduct: { [PRODUCT_ID]: 1_680 },
              maxMarkdownPercent: 30,
              blockedActionKinds: [],
              tone: 'warm',
            },
            items: [{
              eventId,
              eventItemId: `${eventId}-mug`,
              productId: PRODUCT_ID,
              title: 'Matte stoneware mug, 12 ounces',
              priceCents: REFERENCE_PRICE_CENTS,
              referencePriceCents: REFERENCE_PRICE_CENTS,
              availableQty: 12,
              quantity: 12,
              position: 0,
              stageState: 'queued',
              attributes: { finish: 'matte', capacity: '12oz' },
            }],
          },
          expectedStatus: 201,
        });

        let connected!: () => void;
        const ready = new Promise<void>((resolveReady) => { connected = resolveReady; });
        sseOutcome = sse.collect({
          artifactId: 'actions.subscriber.sse',
          caseId: 'protocol.subscriber-invalidated',
          path: `/api/sync/sse?eventId=${encodeURIComponent(eventId)}&demoPrincipal=${SELLER_ID}`,
          maxEvents: 2,
          timeoutMs: 20_000,
          signal: context.signal,
          onConnected: connected,
        }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await Promise.race([
          ready,
          sseOutcome.then((outcome) => {
            if (!outcome.ok) throw outcome.error;
          }),
        ]);

        const allowed = await http.request<{ auditId?: unknown; state?: { priceCents?: unknown } }>({
          artifactId: 'actions.allowed.http',
          caseId: 'protocol.allowed-action',
          method: 'POST',
          path: `/api/actions/events/${eventId}/execute`,
          body: {
            action: {
              kind: 'markdown',
              productId: PRODUCT_ID,
              priceCents: ALLOWED_PRICE_CENTS,
              reason: 'Acceptance allowed markdown',
            },
            clientRequestId,
          },
          idempotencyKey: clientRequestId,
          expectedStatus: 201,
        });
        assertion(typeof allowed.body.auditId === 'string' && allowed.body.auditId.length > 0, 'allowed action returned no audit id');
        assertion(allowed.body.state?.priceCents === ALLOWED_PRICE_CENTS, 'allowed action did not return the applied price');
        allowedAuditId = allowed.body.auditId;
        return 'Allowed markdown crossed the authenticated API and returned its durable audit identity.';
      });

      await runCase('protocol.subscriber-invalidated', async () => {
        assertion(sseOutcome, 'subscriber was not started before the mutation');
        const outcome = await sseOutcome;
        if (!outcome.ok) throw outcome.error;
        assertion(
          outcome.value.events.some((event) => event.event === 'invalidate' && invalidatedLineup(event.data, eventId)),
          'subscriber did not receive the event.lineup.items invalidation',
        );
        return 'A connected seller subscriber observed the event lineup invalidation.';
      });

      await runCase('evidence.audit-persisted', async () => {
        await postgres.assert<{
          audit_id: string;
          actor_id: string;
          kind: string;
          client_request_id: string;
          current_price_cents: number | string;
        }>({
          artifactId: 'actions.allowed.postgres',
          caseId: 'evidence.audit-persisted',
          query: `SELECT audit.id AS audit_id, audit.actor_id, audit.kind, audit.client_request_id,
                         item.current_price_cents
                    FROM action_audit_entry AS audit
                    JOIN event_lineup_item AS item
                      ON item.event_id = audit.event_id AND item.product_id = audit.product_id
                   WHERE audit.event_id = $1 AND audit.client_request_id = $2`,
          values: [eventId, clientRequestId],
          accepts: (rows) => rows.length === 1
            && rows[0]?.audit_id === allowedAuditId
            && rows[0]?.actor_id === SELLER_ID
            && rows[0]?.kind === 'markdown'
            && rows[0]?.client_request_id === clientRequestId
            && Number(rows[0]?.current_price_cents) === ALLOWED_PRICE_CENTS,
        });
        return 'PostgreSQL contains the attributable audit and matching lineup mutation.';
      });

      await runCase('protocol.forbidden-no-side-effect', async () => {
        const forbiddenRequestId = `${runId}-forbidden`;
        const forbidden = await http.request({
          artifactId: 'actions.forbidden.http',
          caseId: 'protocol.forbidden-no-side-effect',
          method: 'POST',
          path: `/api/actions/events/${eventId}/execute`,
          body: {
            action: {
              kind: 'markdown',
              productId: PRODUCT_ID,
              priceCents: FORBIDDEN_PRICE_CENTS,
              reason: 'Acceptance forbidden markdown',
            },
            clientRequestId: forbiddenRequestId,
          },
          idempotencyKey: forbiddenRequestId,
          expectedStatus: 400,
        });
        assertion(forbidden.status === 400, 'forbidden markdown was not rejected');
        await postgres.assert<{ current_price_cents: number | string; audit_count: number | string }>({
          artifactId: 'actions.forbidden.postgres',
          caseId: 'protocol.forbidden-no-side-effect',
          query: `SELECT item.current_price_cents,
                         (SELECT count(*)::int FROM action_audit_entry WHERE event_id = $1) AS audit_count
                    FROM event_lineup_item AS item
                   WHERE item.event_id = $1 AND item.product_id = $2`,
          values: [eventId, PRODUCT_ID],
          accepts: (rows) => rows.length === 1
            && Number(rows[0]?.current_price_cents) === ALLOWED_PRICE_CENTS
            && Number(rows[0]?.audit_count) === 1,
        });
        return 'Below-floor markdown returned 400 and changed neither price nor audit count.';
      });

      await runCase('protocol.rollback-restored', async () => {
        const rollback = await http.request<{
          auditId?: unknown;
          rolledBackAuditId?: unknown;
          state?: { priceCents?: unknown };
        }>({
          artifactId: 'actions.rollback.http',
          caseId: 'protocol.rollback-restored',
          method: 'POST',
          path: `/api/actions/audit/${allowedAuditId}/rollback`,
          body: { reason: 'Acceptance rollback' },
          expectedStatus: 201,
        });
        assertion(rollback.body.rolledBackAuditId === allowedAuditId, 'rollback did not identify the original audit');
        assertion(rollback.body.state?.priceCents === REFERENCE_PRICE_CENTS, 'rollback response did not restore the reference price');
        const rollbackAuditId = rollback.body.auditId;
        assertion(typeof rollbackAuditId === 'string' && rollbackAuditId.length > 0, 'rollback returned no audit id');
        await postgres.assert<{
          rolled_back_at: Date | string | null;
          rollback_id: string;
          rollback_kind: string;
          current_price_cents: number | string;
        }>({
          artifactId: 'actions.rollback.postgres',
          caseId: 'protocol.rollback-restored',
          query: `SELECT original.rolled_back_at, rollback.id AS rollback_id,
                         rollback.kind AS rollback_kind, item.current_price_cents
                    FROM action_audit_entry AS original
                    JOIN action_audit_entry AS rollback ON rollback.rollback_of = original.id
                    JOIN event_lineup_item AS item
                      ON item.event_id = original.event_id AND item.product_id = original.product_id
                   WHERE original.event_id = $1 AND original.id = $2`,
          values: [eventId, allowedAuditId],
          accepts: (rows) => rows.length === 1
            && rows[0]?.rolled_back_at !== null
            && rows[0]?.rollback_id === rollbackAuditId
            && rows[0]?.rollback_kind === 'rollback'
            && Number(rows[0]?.current_price_cents) === REFERENCE_PRICE_CENTS,
        });
        return 'Rollback restored the reference price and persisted one linked rollback audit.';
      });

      await context.reporter.advanceRun(runId, 'collecting', {
        reason: 'All Actions assertions passed; evidence collection is complete.',
        at: now(),
      });
      await context.reporter.recordCleanup(runId, {
        status: 'running',
        summary: 'Closing executor-owned acceptance clients.',
        at: now(),
      });
      await context.reporter.advanceRun(runId, 'cleaning', {
        reason: 'Executor-owned acceptance clients are closing.',
        at: now(),
      });
      await ownedPool?.end();
      ownedPool = null;
      await context.reporter.recordCleanup(runId, {
        status: 'succeeded',
        summary: 'Executor-owned clients closed; isolated Compose teardown owns fixture destruction.',
        at: now(),
      });
      await context.reporter.advanceRun(runId, 'passed', {
        reason: 'Every required Actions case passed with retained black-box evidence.',
        at: now(),
      });
    } catch (error) {
      try {
        await ownedPool?.end();
        ownedPool = null;
        await context.reporter.recordCleanup(runId, {
          status: 'succeeded',
          summary: 'Executor-owned clients closed after an Actions case failure.',
          at: now(),
        });
        await context.reporter.advanceRun(runId, 'failed', { reason: errorText(error), at: now() });
      } catch (cleanupError) {
        await context.reporter.recordCleanup(runId, {
          status: 'failed',
          summary: errorText(cleanupError),
          at: now(),
        });
        await context.reporter.advanceRun(runId, 'cleanup-failed', {
          reason: `Actions failure cleanup failed: ${errorText(cleanupError)}`,
          at: now(),
        });
      }
    }
  };
}
