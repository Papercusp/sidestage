import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { SystemTestEvidence, SystemTestEvidenceKind } from '@papercusp/system-test-contract';

import {
  redactSystemTestJson,
  redactSystemTestText,
  type SystemTestRunReporter,
} from './postgres-run-store';

const ARTIFACT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const RUN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REDIS_READ_COMMANDS = new Set([
  'EXISTS', 'GET', 'HGET', 'HGETALL', 'MGET', 'SCARD', 'SMEMBERS', 'TTL', 'XRANGE', 'ZRANGE',
]);

export class SystemTestBlackBoxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SystemTestBlackBoxError';
  }
}

export class SystemTestProtocolError extends SystemTestBlackBoxError {
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, options: ErrorOptions & { retryable?: boolean; status?: number } = {}) {
    super(message, options);
    this.name = 'SystemTestProtocolError';
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

export interface SystemTestArtifactBudget {
  chargeArtifact(bytes: number): void;
}

export interface SystemTestArtifactWrite {
  runId: string;
  artifactId: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface SystemTestArtifactSink {
  write(input: SystemTestArtifactWrite): Promise<string>;
}

/**
 * Filesystem sink for the trusted worker. The configured root is fixed by the
 * operator; run and artifact identifiers can never escape it.
 */
export class FileSystemSystemTestArtifactSink implements SystemTestArtifactSink {
  readonly #root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new SystemTestBlackBoxError('artifact root must be absolute');
    this.#root = resolve(root);
    if (this.#root === sep) throw new SystemTestBlackBoxError('artifact root cannot be the filesystem root');
  }

  async write(input: SystemTestArtifactWrite): Promise<string> {
    requireIdentifier(input.runId, 'runId', RUN_ID_PATTERN);
    requireIdentifier(input.artifactId, 'artifactId');
    const directory = resolve(this.#root, input.runId);
    const path = resolve(directory, input.artifactId);
    assertDescendant(this.#root, directory);
    assertDescendant(directory, path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, input.bytes, { flag: 'wx', mode: 0o600 });
    } catch (cause) {
      const existing = await readFile(path).catch(() => null);
      if (!existing || !existing.equals(Buffer.from(input.bytes))) {
        throw new SystemTestBlackBoxError(`artifact ${input.artifactId} already contains different evidence`, {
          cause,
        });
      }
    }
    return `artifact://${input.runId}/${input.artifactId}`;
  }
}

export interface SystemTestEvidenceCollectorOptions {
  runId: string;
  requestedSha: string;
  deployedSha: string;
  reporter: SystemTestRunReporter;
  budget: SystemTestArtifactBudget;
  sink: SystemTestArtifactSink;
  now?: () => Date;
}

export interface CaptureSystemTestEvidenceInput {
  artifactId: string;
  caseId?: string;
  kind: SystemTestEvidenceKind;
  summary: string;
  contentType: string;
  body: string | Uint8Array | unknown;
}

/**
 * The one artifact/provenance seam used by every black-box protocol client.
 * Text and JSON are redacted before storage, byte budgets are charged before
 * writing, and the normalized run ledger remains the durable index.
 */
export class SystemTestEvidenceCollector {
  readonly #runId: string;
  readonly #deployedSha: string;
  readonly #reporter: SystemTestRunReporter;
  readonly #budget: SystemTestArtifactBudget;
  readonly #sink: SystemTestArtifactSink;
  readonly #now: () => Date;

  constructor(options: SystemTestEvidenceCollectorOptions) {
    requireIdentifier(options.runId, 'runId', RUN_ID_PATTERN);
    requireSha(options.requestedSha, 'requestedSha');
    requireSha(options.deployedSha, 'deployedSha');
    if (options.requestedSha !== options.deployedSha) {
      throw new SystemTestBlackBoxError(
        `evidence SHA ${options.deployedSha} does not match requested SHA ${options.requestedSha}`,
      );
    }
    this.#runId = options.runId;
    this.#deployedSha = options.deployedSha;
    this.#reporter = options.reporter;
    this.#budget = options.budget;
    this.#sink = options.sink;
    this.#now = options.now ?? (() => new Date());
  }

  async capture(input: CaptureSystemTestEvidenceInput): Promise<SystemTestEvidence> {
    requireIdentifier(input.artifactId, 'artifactId');
    if (input.caseId) requireIdentifier(input.caseId, 'caseId');
    const bytes = sanitiseArtifact(input.body, input.contentType);
    this.#budget.chargeArtifact(bytes.byteLength);
    const ref = await this.#sink.write({
      runId: this.#runId,
      artifactId: input.artifactId,
      contentType: input.contentType,
      bytes,
    });
    const capturedAt = this.#now();
    const summary = redactSystemTestText(input.summary);
    await this.#reporter.recordArtifact(this.#runId, {
      artifactId: input.artifactId,
      caseId: input.caseId,
      kind: input.kind,
      ref,
      summary,
      capturedAt,
      deployedSha: this.#deployedSha,
      byteSize: bytes.byteLength,
    });
    return {
      id: input.artifactId,
      kind: input.kind,
      ref,
      summary,
      capturedAt: capturedAt.toISOString(),
      deployedSha: this.#deployedSha,
    };
  }

  captureJson(
    input: Omit<CaptureSystemTestEvidenceInput, 'contentType' | 'body'> & { value: unknown },
  ): Promise<SystemTestEvidence> {
    return this.capture({ ...input, contentType: 'application/json', body: input.value });
  }

  captureLog(
    input: Omit<CaptureSystemTestEvidenceInput, 'kind' | 'contentType' | 'body'> & { text: string },
  ): Promise<SystemTestEvidence> {
    return this.capture({ ...input, kind: 'log', contentType: 'text/plain', body: input.text });
  }

  captureMetric(
    input: Omit<CaptureSystemTestEvidenceInput, 'kind' | 'contentType' | 'body'> & { value: unknown },
  ): Promise<SystemTestEvidence> {
    return this.capture({ ...input, kind: 'metric', contentType: 'application/json', body: input.value });
  }
}

export interface AuthenticatedHttpClientOptions {
  baseUrl: string;
  authentication: Readonly<Record<string, string>>;
  evidence: SystemTestEvidenceCollector;
  fetch?: typeof fetch;
  maxAttempts?: number;
  maxResponseBytes?: number;
  retryDelay?: (attempt: number, signal?: AbortSignal) => Promise<void>;
}

export interface AuthenticatedHttpRequest {
  artifactId: string;
  caseId: string;
  method: string;
  path: string;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  idempotencyKey?: string;
  expectedStatus?: number | readonly number[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AuthenticatedHttpResult<T = unknown> {
  status: number;
  body: T;
  attempts: number;
  evidence: SystemTestEvidence;
}

/** Fixed-origin authenticated HTTP client with bounded retries and evidence. */
export class AuthenticatedHttpClient {
  readonly #endpoint: FixedProtocolEndpoint;
  readonly #evidence: SystemTestEvidenceCollector;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #maxResponseBytes: number;
  readonly #retryDelay: (attempt: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: AuthenticatedHttpClientOptions) {
    this.#endpoint = new FixedProtocolEndpoint(options.baseUrl, options.authentication, ['http:', 'https:']);
    this.#evidence = options.evidence;
    this.#fetch = options.fetch ?? fetch;
    this.#maxAttempts = boundedInteger(options.maxAttempts ?? 3, 'maxAttempts', 1, 5);
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? 2 * 1024 * 1024,
      'maxResponseBytes',
      1,
      20 * 1024 * 1024,
    );
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  async request<T = unknown>(input: AuthenticatedHttpRequest): Promise<AuthenticatedHttpResult<T>> {
    const method = input.method.toUpperCase();
    const url = this.#endpoint.url(input.path);
    const expected = new Set(Array.isArray(input.expectedStatus)
      ? input.expectedStatus
      : [input.expectedStatus ?? 200]);
    const retryableMethod = ['GET', 'HEAD', 'OPTIONS'].includes(method) || Boolean(input.idempotencyKey);
    const requestHeaders = this.#endpoint.headers(input.headers);
    if (input.idempotencyKey) requestHeaders.set('idempotency-key', input.idempotencyKey);
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const signal = deadlineSignal(input.timeoutMs ?? 15_000, input.signal);
        const response = await this.#fetch(url, {
          method,
          headers: requestHeaders,
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          signal,
        });
        const bytes = await readBoundedBody(response, this.#maxResponseBytes);
        const body = parseResponseBody(bytes, response.headers.get('content-type')) as T;
        const accepted = expected.has(response.status);
        const retryableStatus = [408, 425, 429, 502, 503, 504].includes(response.status);
        if (!accepted && retryableMethod && retryableStatus && attempt < this.#maxAttempts) {
          await this.#retryDelay(attempt, input.signal);
          continue;
        }
        const evidence = await this.#evidence.captureJson({
          artifactId: input.artifactId,
          caseId: input.caseId,
          kind: 'http',
          summary: `${method} ${url.pathname} returned ${response.status} after ${attempt} attempt(s)`,
          value: {
            request: { method, path: url.pathname, body: input.body ?? null },
            response: { status: response.status, body },
            attempts: attempt,
          },
        });
        if (!accepted) {
          throw new SystemTestProtocolError(
            `${method} ${url.pathname} returned ${response.status}; expected ${[...expected].join(' or ')}`,
            { status: response.status, retryable: retryableStatus },
          );
        }
        return { status: response.status, body, attempts: attempt, evidence };
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof SystemTestProtocolError) || error.retryable;
        if (!retryableMethod || !retryable || attempt >= this.#maxAttempts || input.signal?.aborted) throw error;
        await this.#retryDelay(attempt, input.signal);
      }
    }
    throw new SystemTestProtocolError(`${method} ${url.pathname} exhausted retries`, { cause: lastError });
  }
}

export interface SystemTestSseEvent {
  id: string | null;
  event: string;
  data: string;
}

export interface AuthenticatedSseClientOptions extends Omit<AuthenticatedHttpClientOptions, 'maxResponseBytes'> {
  maxEventBytes?: number;
}

/** SSE subscriber that reconnects with Last-Event-ID after a lost stream. */
export class AuthenticatedSseClient {
  readonly #endpoint: FixedProtocolEndpoint;
  readonly #evidence: SystemTestEvidenceCollector;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #maxEventBytes: number;
  readonly #retryDelay: (attempt: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: AuthenticatedSseClientOptions) {
    this.#endpoint = new FixedProtocolEndpoint(options.baseUrl, options.authentication, ['http:', 'https:']);
    this.#evidence = options.evidence;
    this.#fetch = options.fetch ?? fetch;
    this.#maxAttempts = boundedInteger(options.maxAttempts ?? 3, 'maxAttempts', 1, 5);
    this.#maxEventBytes = boundedInteger(options.maxEventBytes ?? 256 * 1024, 'maxEventBytes', 1, 2 * 1024 * 1024);
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  async collect(input: {
    artifactId: string;
    caseId: string;
    path: string;
    maxEvents: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ events: SystemTestSseEvent[]; reconnects: number; evidence: SystemTestEvidence }> {
    const url = this.#endpoint.url(input.path);
    const maxEvents = boundedInteger(input.maxEvents, 'maxEvents', 1, 1_000);
    const events: SystemTestSseEvent[] = [];
    let lastEventId: string | null = null;
    let lastError: unknown;
    let attemptsUsed = 0;

    for (let attempt = 1; attempt <= this.#maxAttempts && events.length < maxEvents; attempt += 1) {
      attemptsUsed = attempt;
      try {
        const headers = this.#endpoint.headers({ accept: 'text/event-stream' });
        if (lastEventId) headers.set('last-event-id', lastEventId);
        const response = await this.#fetch(url, {
          method: 'GET',
          headers,
          signal: deadlineSignal(input.timeoutMs ?? 30_000, input.signal),
        });
        if (!response.ok || !response.body) {
          throw new SystemTestProtocolError(`SSE ${url.pathname} returned ${response.status}`, {
            status: response.status,
            retryable: [408, 425, 429, 502, 503, 504].includes(response.status),
          });
        }
        await consumeSse(response.body, this.#maxEventBytes, (event) => {
          events.push(event);
          if (event.id) lastEventId = event.id;
          return events.length >= maxEvents;
        });
        if (events.length >= maxEvents) break;
        throw new SystemTestProtocolError('SSE stream ended before the expected events arrived', { retryable: true });
      } catch (error) {
        lastError = error;
        if (error instanceof SystemTestProtocolError && !error.retryable) throw error;
        if (attempt >= this.#maxAttempts || input.signal?.aborted) break;
        await this.#retryDelay(attempt, input.signal);
      }
    }
    if (events.length < maxEvents) {
      throw new SystemTestProtocolError(
        `SSE ${url.pathname} delivered ${events.length}/${maxEvents} events before retries were exhausted`,
        { cause: lastError },
      );
    }
    const reconnects = Math.max(0, attemptsUsed - 1);
    const evidence = await this.#evidence.captureJson({
      artifactId: input.artifactId,
      caseId: input.caseId,
      kind: 'sse',
      summary: `SSE ${url.pathname} delivered ${events.length} event(s) with resumable IDs`,
      value: { path: url.pathname, reconnects, events },
    });
    return { events, reconnects, evidence };
  }
}

export interface SystemTestWebSocketConnection {
  send(data: string | Uint8Array): Promise<void> | void;
  receive(signal?: AbortSignal): Promise<string | Uint8Array>;
  close(code?: number, reason?: string): Promise<void> | void;
}

export interface SystemTestWebSocketDialer {
  connect(input: {
    url: URL;
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }): Promise<SystemTestWebSocketConnection>;
}

/** Server-side WebSocket exchange with a replaceable real network dialer. */
export class AuthenticatedWebSocketClient {
  readonly #endpoint: FixedProtocolEndpoint;
  readonly #evidence: SystemTestEvidenceCollector;
  readonly #dialer: SystemTestWebSocketDialer;
  readonly #maxAttempts: number;
  readonly #retryDelay: (attempt: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: {
    baseUrl: string;
    authentication: Readonly<Record<string, string>>;
    evidence: SystemTestEvidenceCollector;
    dialer: SystemTestWebSocketDialer;
    maxAttempts?: number;
    retryDelay?: (attempt: number, signal?: AbortSignal) => Promise<void>;
  }) {
    this.#endpoint = new FixedProtocolEndpoint(options.baseUrl, options.authentication, ['ws:', 'wss:']);
    this.#evidence = options.evidence;
    this.#dialer = options.dialer;
    this.#maxAttempts = boundedInteger(options.maxAttempts ?? 3, 'maxAttempts', 1, 5);
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  async exchange(input: {
    artifactId: string;
    caseId: string;
    path: string;
    send?: readonly (string | Uint8Array)[];
    receive: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ messages: string[]; attempts: number; evidence: SystemTestEvidence }> {
    const url = this.#endpoint.url(input.path);
    const expected = boundedInteger(input.receive, 'receive', 1, 1_000);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let connection: SystemTestWebSocketConnection | null = null;
      try {
        const signal = deadlineSignal(input.timeoutMs ?? 30_000, input.signal);
        connection = await this.#dialer.connect({
          url,
          headers: Object.freeze(Object.fromEntries(this.#endpoint.headers())),
          signal,
        });
        for (const message of input.send ?? []) await connection.send(message);
        const messages: string[] = [];
        while (messages.length < expected) messages.push(messageText(await connection.receive(signal)));
        await connection.close(1000, 'system-test evidence captured');
        const evidence = await this.#evidence.captureJson({
          artifactId: input.artifactId,
          caseId: input.caseId,
          kind: 'websocket',
          summary: `WebSocket ${url.pathname} exchanged ${messages.length} message(s) after ${attempt} attempt(s)`,
          value: { path: url.pathname, attempts: attempt, messages },
        });
        return { messages, attempts: attempt, evidence };
      } catch (error) {
        lastError = error;
        try {
          await connection?.close(1011, 'connection lost');
        } catch {
          // Preserve the exchange failure when best-effort cleanup also fails.
        }
        if (error instanceof SystemTestProtocolError && !error.retryable) throw error;
        if (attempt >= this.#maxAttempts || input.signal?.aborted) throw error;
        await this.#retryDelay(attempt, input.signal);
      }
    }
    throw new SystemTestProtocolError(`WebSocket ${url.pathname} exhausted retries`, { cause: lastError });
  }
}

export interface EventuallyOptions {
  attempts?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  wait?: (attempt: number, signal?: AbortSignal) => Promise<void>;
}

export interface EventuallyResult<T> {
  value: T;
  attempts: number;
}

/** Retry an assertion against subscriber-visible or persisted state. */
export async function eventually<T>(
  probe: () => Promise<T>,
  accepts: (value: T) => boolean,
  options: EventuallyOptions = {},
): Promise<EventuallyResult<T>> {
  const attempts = boundedInteger(options.attempts ?? 5, 'attempts', 1, 20);
  const wait = options.wait ?? ((attempt, signal) => defaultRetryDelay(attempt, signal, options.intervalMs ?? 100));
  let lastValue: T | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      lastValue = await probe();
      if (accepts(lastValue)) return { value: lastValue, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (error instanceof SystemTestProtocolError && !error.retryable) throw error;
    }
    if (attempt < attempts) await wait(attempt, options.signal);
  }
  throw new SystemTestBlackBoxError(
    `state assertion did not pass after ${attempts} attempt(s); last value: ${safeSummary(lastValue)}`,
    { cause: lastError },
  );
}

export interface SystemTestPostgresQuery {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export class PostgresBlackBoxClient {
  constructor(
    readonly queryable: SystemTestPostgresQuery,
    readonly evidence: SystemTestEvidenceCollector,
  ) {}

  async assert<T extends Record<string, unknown>>(input: {
    artifactId: string;
    caseId: string;
    query: string;
    values?: readonly unknown[];
    accepts: (rows: T[]) => boolean;
    eventually?: EventuallyOptions;
  }): Promise<EventuallyResult<T[]> & { evidence: SystemTestEvidence }> {
    assertReadOnlySql(input.query);
    const result = await eventually(
      async () => (await this.queryable.query<T>(input.query, input.values)).rows,
      input.accepts,
      input.eventually,
    );
    const evidence = await this.evidence.captureJson({
      artifactId: input.artifactId,
      caseId: input.caseId,
      kind: 'postgres',
      summary: `PostgreSQL assertion passed after ${result.attempts} attempt(s)`,
      value: { queryFingerprint: fingerprint(input.query), attempts: result.attempts, rows: result.value },
    });
    return { ...result, evidence };
  }
}

export interface SystemTestRedisClient {
  sendCommand(command: readonly string[]): Promise<unknown>;
}

export class RedisBlackBoxClient {
  constructor(
    readonly client: SystemTestRedisClient,
    readonly evidence: SystemTestEvidenceCollector,
  ) {}

  async assert(input: {
    artifactId: string;
    caseId: string;
    command: readonly string[];
    accepts: (value: unknown) => boolean;
    eventually?: EventuallyOptions;
  }): Promise<EventuallyResult<unknown> & { evidence: SystemTestEvidence }> {
    const name = input.command[0]?.toUpperCase() ?? '';
    if (!REDIS_READ_COMMANDS.has(name)) {
      throw new SystemTestBlackBoxError(`Redis evidence command ${name || '(empty)'} is not read-only`);
    }
    const result = await eventually(
      () => this.client.sendCommand(input.command),
      input.accepts,
      input.eventually,
    );
    const evidence = await this.evidence.captureJson({
      artifactId: input.artifactId,
      caseId: input.caseId,
      kind: 'redis',
      summary: `Redis ${name} assertion passed after ${result.attempts} attempt(s)`,
      value: { command: name, keyFingerprint: fingerprint(input.command[1] ?? ''), value: result.value },
    });
    return { ...result, evidence };
  }
}

export class TypesenseBlackBoxClient {
  readonly #endpoint: FixedProtocolEndpoint;
  readonly #evidence: SystemTestEvidenceCollector;
  readonly #fetch: typeof fetch;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    evidence: SystemTestEvidenceCollector;
    fetch?: typeof fetch;
  }) {
    this.#endpoint = new FixedProtocolEndpoint(
      options.baseUrl,
      { 'x-typesense-api-key': options.apiKey },
      ['http:', 'https:'],
    );
    this.#evidence = options.evidence;
    this.#fetch = options.fetch ?? fetch;
  }

  async assert(input: {
    artifactId: string;
    caseId: string;
    path: string;
    accepts: (value: unknown) => boolean;
    eventually?: EventuallyOptions;
  }): Promise<EventuallyResult<unknown> & { evidence: SystemTestEvidence }> {
    const url = this.#endpoint.url(input.path);
    const result = await eventually(async () => {
      const response = await this.#fetch(url, { headers: this.#endpoint.headers() });
      if (!response.ok) throw new SystemTestProtocolError(`Typesense returned ${response.status}`, {
        status: response.status,
        retryable: response.status >= 500,
      });
      return response.json() as Promise<unknown>;
    }, input.accepts, input.eventually);
    const evidence = await this.#evidence.captureJson({
      artifactId: input.artifactId,
      caseId: input.caseId,
      kind: 'typesense',
      summary: `Typesense ${url.pathname} assertion passed after ${result.attempts} attempt(s)`,
      value: { path: url.pathname, attempts: result.attempts, value: result.value },
    });
    return { ...result, evidence };
  }
}

export class MediaMtxBlackBoxClient {
  readonly #endpoint: FixedProtocolEndpoint;
  readonly #evidence: SystemTestEvidenceCollector;
  readonly #fetch: typeof fetch;

  constructor(options: {
    baseUrl: string;
    authentication?: Readonly<Record<string, string>>;
    evidence: SystemTestEvidenceCollector;
    fetch?: typeof fetch;
  }) {
    this.#endpoint = new FixedProtocolEndpoint(
      options.baseUrl,
      options.authentication ?? {},
      ['http:', 'https:'],
    );
    this.#evidence = options.evidence;
    this.#fetch = options.fetch ?? fetch;
  }

  async assertPath(input: {
    artifactId: string;
    caseId: string;
    pathName: string;
    accepts?: (path: Record<string, unknown>) => boolean;
    eventually?: EventuallyOptions;
  }): Promise<EventuallyResult<Record<string, unknown>> & { evidence: SystemTestEvidence }> {
    const url = this.#endpoint.url('/v3/paths/list');
    const result = await eventually(async () => {
      const response = await this.#fetch(url, { headers: this.#endpoint.headers() });
      if (!response.ok) throw new SystemTestProtocolError(`MediaMTX returned ${response.status}`, {
        status: response.status,
        retryable: response.status >= 500,
      });
      const payload = await response.json() as Record<string, unknown>;
      const items = Array.isArray(payload.items) ? payload.items : [];
      const path = items.find((entry) => (
        entry && typeof entry === 'object' && (entry as Record<string, unknown>).name === input.pathName
      ));
      return (path as Record<string, unknown> | undefined) ?? {};
    }, (path) => Boolean(path.name) && (input.accepts?.(path) ?? true), input.eventually);
    const evidence = await this.#evidence.captureJson({
      artifactId: input.artifactId,
      caseId: input.caseId,
      kind: 'mediamtx',
      summary: `MediaMTX path ${input.pathName} was visible after ${result.attempts} attempt(s)`,
      value: { pathName: input.pathName, attempts: result.attempts, path: result.value },
    });
    return { ...result, evidence };
  }
}

export interface PlaywrightPageLike {
  url(): string;
  locator(selector: string): unknown;
  screenshot(options: { fullPage: boolean; mask: unknown[] }): Promise<Uint8Array>;
  on(event: string, listener: (value: unknown) => void): void;
  off(event: string, listener: (value: unknown) => void): void;
}

export interface PlaywrightTraceSource {
  /** Return a structured, already-bounded trace summary; raw trace archives can contain credentials. */
  stopAndSanitise(): Promise<unknown>;
}

/**
 * Playwright-compatible browser evidence capture. Password/secret elements are
 * masked before pixels leave the browser, and console/page errors are redacted.
 */
export class PlaywrightBrowserEvidenceCollector {
  constructor(readonly evidence: SystemTestEvidenceCollector) {}

  async run<T>(input: {
    artifactPrefix: string;
    caseId: string;
    page: PlaywrightPageLike;
    action: (page: PlaywrightPageLike) => Promise<T>;
    trace?: PlaywrightTraceSource;
    now?: () => number;
  }): Promise<{ value: T; evidence: SystemTestEvidence[] }> {
    requireIdentifier(input.artifactPrefix, 'artifactPrefix');
    const log: string[] = [];
    const consoleListener = (value: unknown) => log.push(`console: ${eventText(value)}`);
    const errorListener = (value: unknown) => log.push(`pageerror: ${eventText(value)}`);
    const requestListener = (value: unknown) => log.push(`requestfailed: ${eventText(value)}`);
    input.page.on('console', consoleListener);
    input.page.on('pageerror', errorListener);
    input.page.on('requestfailed', requestListener);
    const now = input.now ?? (() => Date.now());
    const started = now();
    try {
      let value: T | undefined;
      let actionError: unknown;
      let actionFailed = false;
      try {
        value = await input.action(input.page);
      } catch (error) {
        actionFailed = true;
        actionError = error;
        log.push(`actionerror: ${eventText(error)}`);
      }
      const durationMs = Math.max(0, now() - started);
      const mask = [
        input.page.locator('input[type="password"]'),
        input.page.locator('[data-system-test-secret]'),
        input.page.locator('[autocomplete="current-password"]'),
      ];
      const screenshot = await input.page.screenshot({ fullPage: true, mask });
      const artifacts = await Promise.all([
        this.evidence.capture({
          artifactId: `${input.artifactPrefix}.screenshot`,
          caseId: input.caseId,
          kind: 'screenshot',
          summary: `Masked Playwright screenshot of ${safePagePath(input.page.url())}`,
          contentType: 'image/png',
          body: screenshot,
        }),
        this.evidence.captureLog({
          artifactId: `${input.artifactPrefix}.browser-log`,
          caseId: input.caseId,
          summary: `Playwright console and page errors for ${safePagePath(input.page.url())}`,
          text: log.join('\n') || '(no browser messages)',
        }),
        this.evidence.captureMetric({
          artifactId: `${input.artifactPrefix}.browser-metric`,
          caseId: input.caseId,
          summary: `Playwright action duration for ${safePagePath(input.page.url())}`,
          value: { durationMs },
        }),
      ]);
      if (input.trace) {
        artifacts.push(await this.evidence.captureJson({
          artifactId: `${input.artifactPrefix}.trace`,
          caseId: input.caseId,
          kind: 'log',
          summary: `Sanitised Playwright trace summary for ${safePagePath(input.page.url())}`,
          value: await input.trace.stopAndSanitise(),
        }));
      }
      if (actionFailed) throw actionError;
      return { value: value as T, evidence: artifacts };
    } finally {
      input.page.off('console', consoleListener);
      input.page.off('pageerror', errorListener);
      input.page.off('requestfailed', requestListener);
    }
  }
}

class FixedProtocolEndpoint {
  readonly #base: URL;
  readonly #authentication: Readonly<Record<string, string>>;

  constructor(baseUrl: string, authentication: Readonly<Record<string, string>>, protocols: readonly string[]) {
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch (cause) {
      throw new SystemTestBlackBoxError('protocol baseUrl must be an absolute URL', { cause });
    }
    if (!protocols.includes(base.protocol)) {
      throw new SystemTestBlackBoxError(`protocol baseUrl must use ${protocols.join(' or ')}`);
    }
    if (base.username || base.password || base.search || base.hash) {
      throw new SystemTestBlackBoxError('protocol baseUrl cannot contain credentials, query, or fragment');
    }
    this.#base = new URL(base.pathname.endsWith('/') ? base : new URL(`${base.pathname}/`, base));
    this.#authentication = Object.freeze({ ...authentication });
    for (const [name, value] of Object.entries(this.#authentication)) {
      if (!name.trim() || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        throw new SystemTestBlackBoxError('authentication headers contain an invalid name or value');
      }
      if (['host', 'content-length', 'connection', 'transfer-encoding'].includes(name.toLowerCase())) {
        throw new SystemTestBlackBoxError(`authentication cannot set transport header ${name}`);
      }
    }
  }

  url(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) {
      throw new SystemTestBlackBoxError('protocol path must be a root-relative path');
    }
    const url = new URL(path, this.#base);
    if (url.origin !== this.#base.origin || url.username || url.password || url.hash) {
      throw new SystemTestBlackBoxError('protocol path escaped the fixed deployment origin');
    }
    return url;
  }

  headers(extra: Readonly<Record<string, string>> = {}): Headers {
    const headers = new Headers(this.#authentication);
    for (const [name, value] of Object.entries(extra)) {
      if (['authorization', 'cookie', 'host', 'x-typesense-api-key'].includes(name.toLowerCase())) {
        throw new SystemTestBlackBoxError(`caller cannot override protected header ${name}`);
      }
      headers.set(name, value);
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return headers;
  }
}

function sanitiseArtifact(body: string | Uint8Array | unknown, contentType: string): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (/json/i.test(contentType)) {
    return Buffer.from(`${JSON.stringify(redactSystemTestJson(body), null, 2)}\n`, 'utf8');
  }
  return Buffer.from(redactSystemTestText(String(body)), 'utf8');
}

function requireIdentifier(value: string, label: string, pattern = ARTIFACT_ID_PATTERN): void {
  if (!pattern.test(value)) throw new SystemTestBlackBoxError(`${label} has an invalid format`);
}

function requireSha(value: string, label: string): void {
  if (!SHA_PATTERN.test(value)) throw new SystemTestBlackBoxError(`${label} must be a full lowercase git SHA`);
}

function assertDescendant(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    if (candidate !== root) throw new SystemTestBlackBoxError('artifact path escaped its configured root');
  }
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new SystemTestBlackBoxError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new SystemTestProtocolError(`response exceeded ${maxBytes} bytes`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
}

function parseResponseBody(bytes: Uint8Array, contentType: string | null): unknown {
  const text = Buffer.from(bytes).toString('utf8');
  if (/json/i.test(contentType ?? '')) {
    try {
      return text ? JSON.parse(text) : null;
    } catch (cause) {
      throw new SystemTestProtocolError('response declared JSON but was not valid JSON', { cause });
    }
  }
  return text;
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  maxEventBytes: number,
  onEvent: (event: SystemTestSseEvent) => boolean,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      while (/\r?\n\r?\n/.test(buffer)) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (Buffer.byteLength(block) > maxEventBytes) {
          throw new SystemTestProtocolError(`SSE event exceeded ${maxEventBytes} bytes`);
        }
        const event = parseSseBlock(block);
        if (event && onEvent(event)) {
          await reader.cancel();
          return;
        }
      }
      if (Buffer.byteLength(buffer) > maxEventBytes) {
        throw new SystemTestProtocolError(`SSE event exceeded ${maxEventBytes} bytes`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): SystemTestSseEvent | null {
  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'event') event = value || 'message';
    else if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { id, event, data: data.join('\n') } : null;
}

function messageText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
}

function deadlineSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  boundedInteger(timeoutMs, 'timeoutMs', 1, 15 * 60_000);
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function defaultRetryDelay(attempt: number, signal?: AbortSignal, baseMs = 100): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, Math.min(baseMs * (2 ** (attempt - 1)), 2_000));
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new SystemTestBlackBoxError('operation was aborted');
}

function assertReadOnlySql(query: string): void {
  const trimmed = query.trim();
  const writes = /\b(?:insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|call|do)\b/i;
  if (!/^(?:select|with)\b/i.test(trimmed) || /;\s*\S/.test(trimmed) || writes.test(trimmed)) {
    throw new SystemTestBlackBoxError('PostgreSQL evidence queries must be one SELECT or WITH statement');
  }
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function safeSummary(value: unknown): string {
  const redacted = redactSystemTestJson(value);
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  return (text ?? 'undefined').slice(0, 500);
}

function eventText(value: unknown): string {
  if (value instanceof Error) return redactSystemTestText(value.message);
  if (value && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'function') {
      try {
        return redactSystemTestText(String(text.call(value)));
      } catch {
        return '[unreadable event]';
      }
    }
    if (typeof text === 'string') return redactSystemTestText(text);
    const url = (value as { url?: unknown }).url;
    if (typeof url === 'function') {
      try {
        return redactSystemTestText(String(url.call(value)));
      } catch {
        return '[unreadable event]';
      }
    }
  }
  return redactSystemTestText(String(value));
}

function safePagePath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redactSystemTestText(value);
  }
}
