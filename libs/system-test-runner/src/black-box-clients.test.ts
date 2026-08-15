import type { SystemTestEvidenceKind } from '@papercusp/system-test-contract';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticatedHttpClient,
  AuthenticatedSseClient,
  AuthenticatedWebSocketClient,
  MediaMtxBlackBoxClient,
  PlaywrightBrowserEvidenceCollector,
  PostgresBlackBoxClient,
  RedisBlackBoxClient,
  SystemTestBlackBoxError,
  SystemTestEvidenceCollector,
  TypesenseBlackBoxClient,
  type PlaywrightPageLike,
  type SystemTestArtifactSink,
  type SystemTestArtifactWrite,
  type SystemTestWebSocketConnection,
  type SystemTestWebSocketDialer,
} from './black-box-clients';
import type { RecordSystemTestArtifactInput, SystemTestRunReporter } from './postgres-run-store';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

class MemoryArtifactSink implements SystemTestArtifactSink {
  readonly writes: SystemTestArtifactWrite[] = [];

  async write(input: SystemTestArtifactWrite): Promise<string> {
    this.writes.push({ ...input, bytes: new Uint8Array(input.bytes) });
    return `artifact://${input.runId}/${input.artifactId}`;
  }

  text(artifactId: string): string {
    const artifact = this.writes.find((entry) => entry.artifactId === artifactId);
    if (!artifact) throw new Error(`missing artifact ${artifactId}`);
    return Buffer.from(artifact.bytes).toString('utf8');
  }
}

class FixedBudget {
  used = 0;

  constructor(readonly limit = 10 * 1024 * 1024) {}

  chargeArtifact(bytes: number): void {
    this.used += bytes;
    if (this.used > this.limit) throw new Error('suite exceeded its artifact-byte budget');
  }
}

function collector(options: { requestedSha?: string; deployedSha?: string; limit?: number } = {}) {
  const records: RecordSystemTestArtifactInput[] = [];
  const reporter = {
    recordArtifact: vi.fn(async (_runId: string, input: RecordSystemTestArtifactInput) => {
      records.push(input);
    }),
  } as unknown as SystemTestRunReporter;
  const sink = new MemoryArtifactSink();
  const budget = new FixedBudget(options.limit);
  const evidence = new SystemTestEvidenceCollector({
    runId: 'run-black-box-1',
    requestedSha: options.requestedSha ?? SHA,
    deployedSha: options.deployedSha ?? SHA,
    reporter,
    budget,
    sink,
    now: () => new Date('2026-08-15T03:00:00.000Z'),
  });
  return { evidence, sink, budget, records, reporter };
}

const noDelay = async () => undefined;

describe('SystemTestEvidenceCollector', () => {
  it('redacts before storage and binds every ledger record to the deployed SHA', async () => {
    const { evidence, sink, records } = collector();

    const result = await evidence.captureJson({
      artifactId: 'http-secret-proof',
      caseId: 'protocol.proposal-authenticated',
      kind: 'http',
      summary: 'Bearer header.payload.signature was accepted',
      value: {
        endpoint: 'https://operator:password@example.test/action?token=top-secret',
        authorization: 'Bearer header.payload.signature',
        nested: { accessToken: 'square-secret' },
      },
    });

    const stored = sink.text('http-secret-proof');
    expect(stored).toContain('[REDACTED]');
    expect(stored).not.toMatch(/password|top-secret|header\.payload|square-secret/);
    expect(result).toMatchObject({
      ref: 'artifact://run-black-box-1/http-secret-proof',
      deployedSha: SHA,
      capturedAt: '2026-08-15T03:00:00.000Z',
    });
    expect(records[0]).toMatchObject({
      artifactId: 'http-secret-proof',
      caseId: 'protocol.proposal-authenticated',
      deployedSha: SHA,
      byteSize: Buffer.byteLength(stored),
    });
    expect(records[0]?.summary).not.toContain('header.payload.signature');
  });

  it('refuses mismatched commit provenance before writing evidence', () => {
    expect(() => collector({ deployedSha: OTHER_SHA })).toThrow(/does not match requested SHA/);
  });

  it('charges the shared suite budget before the sink or ledger can accept an oversized artifact', async () => {
    const { evidence, sink, records } = collector({ limit: 4 });

    await expect(evidence.capture({
      artifactId: 'too-large',
      kind: 'log',
      summary: 'oversized',
      contentType: 'text/plain',
      body: '12345',
    })).rejects.toThrow(/artifact-byte budget/);
    expect(sink.writes).toHaveLength(0);
    expect(records).toHaveLength(0);
  });
});

describe('authenticated protocol clients', () => {
  it('retries a lost idempotent HTTP connection and persists redacted request/response evidence', async () => {
    const { evidence, sink } = collector();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) throw new TypeError('socket reset');
      return new Response(JSON.stringify({ ok: true, accessToken: 'response-secret' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = new AuthenticatedHttpClient({
      baseUrl: 'https://acceptance.example.test',
      authentication: { authorization: 'Bearer request-secret' },
      evidence,
      fetch: fetchStub,
      maxAttempts: 2,
      retryDelay: noDelay,
    });

    const result = await client.request<{ ok: boolean }>({
      artifactId: 'http-retry',
      caseId: 'protocol.confirmed-mutation',
      method: 'POST',
      path: '/actions/confirm?token=query-secret',
      idempotencyKey: 'run-black-box-1-confirm',
      expectedStatus: 201,
      body: { password: 'body-secret', action: 'confirm' },
    });

    expect(result.attempts).toBe(2);
    expect(result.body).toEqual({ ok: true, accessToken: 'response-secret' });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe('Bearer request-secret');
    const stored = sink.text('http-retry');
    expect(stored).not.toMatch(/request-secret|response-secret|query-secret|body-secret/);
    expect(stored).toContain('"attempts": 2');
  });

  it('does not replay a non-idempotent HTTP mutation after connection loss', async () => {
    const { evidence } = collector();
    const fetchStub = vi.fn(async () => { throw new TypeError('connection lost'); }) as unknown as typeof fetch;
    const client = new AuthenticatedHttpClient({
      baseUrl: 'https://acceptance.example.test',
      authentication: { authorization: 'Bearer test-token' },
      evidence,
      fetch: fetchStub,
      maxAttempts: 3,
      retryDelay: noDelay,
    });

    await expect(client.request({
      artifactId: 'http-no-replay',
      caseId: 'protocol.confirmed-mutation',
      method: 'POST',
      path: '/actions/confirm',
    })).rejects.toThrow(/connection lost/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('reconnects a lost SSE stream with Last-Event-ID and records the real reconnect count', async () => {
    const { evidence } = collector();
    const seenLastEventIds: Array<string | null> = [];
    const responses = [
      'id: event-1\nevent: bid\ndata: {"amount":10}\n\n',
      'id: event-2\nevent: bid\ndata: {"amount":11}\n\n',
    ];
    const fetchStub = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seenLastEventIds.push(new Headers(init?.headers).get('last-event-id'));
      return new Response(responses.shift(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
    const client = new AuthenticatedSseClient({
      baseUrl: 'https://acceptance.example.test',
      authentication: { authorization: 'Bearer test-token' },
      evidence,
      fetch: fetchStub,
      maxAttempts: 2,
      retryDelay: noDelay,
    });

    const result = await client.collect({
      artifactId: 'sse-reconnect',
      caseId: 'protocol.bid-stream',
      path: '/events/bids',
      maxEvents: 2,
    });

    expect(result.events.map((event) => event.id)).toEqual(['event-1', 'event-2']);
    expect(result.reconnects).toBe(1);
    expect(seenLastEventIds).toEqual([null, 'event-1']);
  });

  it('re-dials WebSocket after a lost connection and preserves the original failure on cleanup errors', async () => {
    const { evidence } = collector();
    const closes: Array<[number | undefined, string | undefined]> = [];
    const failed: SystemTestWebSocketConnection = {
      send: vi.fn(),
      receive: vi.fn(async () => { throw new Error('peer reset'); }),
      close: vi.fn(async (code, reason) => { closes.push([code, reason]); throw new Error('close failed'); }),
    };
    const healthy: SystemTestWebSocketConnection = {
      send: vi.fn(),
      receive: vi.fn(async () => '{"type":"bid","amount":12}'),
      close: vi.fn(async (code, reason) => { closes.push([code, reason]); }),
    };
    const connections = [failed, healthy];
    const dialer: SystemTestWebSocketDialer = {
      connect: vi.fn(async () => connections.shift() ?? healthy),
    };
    const client = new AuthenticatedWebSocketClient({
      baseUrl: 'wss://acceptance.example.test',
      authentication: { authorization: 'Bearer test-token' },
      evidence,
      dialer,
      maxAttempts: 2,
      retryDelay: noDelay,
    });

    const result = await client.exchange({
      artifactId: 'websocket-retry',
      caseId: 'network.websocket-budget',
      path: '/sync/v1',
      send: ['subscribe'],
      receive: 1,
    });

    expect(result.attempts).toBe(2);
    expect(result.messages).toEqual(['{"type":"bid","amount":12}']);
    expect(dialer.connect).toHaveBeenCalledTimes(2);
    expect(closes).toContainEqual([1011, 'connection lost']);
    expect(closes).toContainEqual([1000, 'system-test evidence captured']);
  });
});

describe('persisted and subscriber-visible state probes', () => {
  it('polls PostgreSQL until persisted state is visible and rejects mutation SQL', async () => {
    const { evidence } = collector();
    const rows = [[], [{ order_id: 'order-1', access_token: 'database-secret' }]];
    const queryable = {
      query: vi.fn(async () => ({ rows: rows.shift() ?? [] })),
    };
    const client = new PostgresBlackBoxClient(
      queryable as unknown as ConstructorParameters<typeof PostgresBlackBoxClient>[0],
      evidence,
    );

    const result = await client.assert<{ order_id: string }>({
      artifactId: 'postgres-eventual',
      caseId: 'evidence.order-persisted',
      query: 'SELECT order_id, access_token FROM orders WHERE order_id = $1',
      values: ['order-1'],
      accepts: (value) => value.length === 1,
      eventually: { attempts: 2, wait: noDelay },
    });

    expect(result.attempts).toBe(2);
    expect(result.evidence.kind).toBe('postgres');
    await expect(client.assert({
      artifactId: 'postgres-write',
      caseId: 'evidence.order-persisted',
      query: 'DELETE FROM orders',
      accepts: () => true,
    })).rejects.toThrow(/SELECT or WITH/);
    await expect(client.assert({
      artifactId: 'postgres-write-cte',
      caseId: 'evidence.order-persisted',
      query: 'WITH removed AS (DELETE FROM orders RETURNING *) SELECT * FROM removed',
      accepts: () => true,
    })).rejects.toThrow(/SELECT or WITH/);
  });

  it('captures read-only Redis, Typesense, and MediaMTX assertions with typed evidence', async () => {
    const { evidence } = collector();
    const redis = new RedisBlackBoxClient({
      sendCommand: vi.fn(async () => ['buyer-1']),
    }, evidence);
    const redisResult = await redis.assert({
      artifactId: 'redis-subscribers',
      caseId: 'protocol.bid-stream',
      command: ['SMEMBERS', 'auction:run-1:subscribers'],
      accepts: (value) => Array.isArray(value) && value.includes('buyer-1'),
      eventually: { attempts: 1 },
    });
    expect(redisResult.evidence.kind).toBe('redis');
    await expect(redis.assert({
      artifactId: 'redis-write',
      caseId: 'protocol.bid-stream',
      command: ['SET', 'key', 'value'],
      accepts: () => true,
    })).rejects.toThrow(/not read-only/);

    const typesenseFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      found: 1,
      hits: [{ document: { id: 'product-1' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const typesense = new TypesenseBlackBoxClient({
      baseUrl: 'http://typesense:8108',
      apiKey: 'typesense-secret',
      evidence,
      fetch: typesenseFetch as unknown as typeof fetch,
    });
    const typesenseResult = await typesense.assert({
      artifactId: 'typesense-product',
      caseId: 'protocol.inventory-hold',
      path: '/collections/products/documents/search?q=product-1&query_by=id',
      accepts: (value) => (value as { found?: number }).found === 1,
      eventually: { attempts: 1 },
    });
    expect(typesenseResult.evidence.kind).toBe('typesense');
    expect(new Headers(typesenseFetch.mock.calls[0]?.[1]?.headers).get('x-typesense-api-key')).toBe('typesense-secret');

    const mediaFetch = vi.fn(async () => new Response(JSON.stringify({
      items: [{ name: 'run-1-stage', ready: true, readers: [{ id: 'viewer-1' }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const media = new MediaMtxBlackBoxClient({
      baseUrl: 'http://mediamtx:9997',
      evidence,
      fetch: mediaFetch,
    });
    const mediaResult = await media.assertPath({
      artifactId: 'mediamtx-stage',
      caseId: 'protocol.bid-stream',
      pathName: 'run-1-stage',
      accepts: (path) => path.ready === true,
      eventually: { attempts: 1 },
    });
    expect(mediaResult.evidence.kind).toBe('mediamtx');
  });
});

describe('PlaywrightBrowserEvidenceCollector', () => {
  it('masks secret DOM nodes and captures redacted logs, metrics, screenshots, and trace summaries', async () => {
    const { evidence, sink, records } = collector();
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const masks: unknown[][] = [];
    const page: PlaywrightPageLike = {
      url: () => 'https://acceptance.example.test/watch?token=url-secret',
      locator: (selector) => ({ selector }),
      screenshot: vi.fn(async (options) => {
        masks.push(options.mask);
        return new Uint8Array([137, 80, 78, 71]);
      }),
      on: (event, listener) => {
        const values = listeners.get(event) ?? new Set();
        values.add(listener);
        listeners.set(event, values);
      },
      off: (event, listener) => listeners.get(event)?.delete(listener),
    };
    const browser = new PlaywrightBrowserEvidenceCollector(evidence);

    const result = await browser.run({
      artifactPrefix: 'browser-watch',
      caseId: 'protocol.bid-stream',
      page,
      now: vi.fn()
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(145),
      action: async () => {
        for (const listener of listeners.get('console') ?? []) {
          listener({ text: () => 'Bearer browser.console.secret' });
        }
        return 'visible';
      },
      trace: {
        stopAndSanitise: async () => ({
          spans: [{ name: 'watch-load', durationMs: 30 }],
          authorization: 'Bearer trace.secret',
        }),
      },
    });

    expect(result.value).toBe('visible');
    expect(result.evidence).toHaveLength(4);
    expect(new Set(records.map((record) => record.kind))).toEqual(
      new Set<SystemTestEvidenceKind>(['screenshot', 'log', 'metric']),
    );
    expect(masks[0]).toHaveLength(3);
    expect(sink.text('browser-watch.browser-log')).not.toContain('browser.console.secret');
    expect(sink.text('browser-watch.trace')).not.toContain('trace.secret');
    expect(sink.text('browser-watch.browser-metric')).toContain('45');
    expect(listeners.get('console')).toHaveLength(0);
    expect(listeners.get('pageerror')).toHaveLength(0);
    expect(listeners.get('requestfailed')).toHaveLength(0);
  });

  it('rejects deployment endpoints that embed credentials or caller-controlled origins', () => {
    const { evidence } = collector();
    expect(() => new AuthenticatedHttpClient({
      baseUrl: 'https://operator:secret@acceptance.example.test',
      authentication: {},
      evidence,
    })).toThrow(SystemTestBlackBoxError);
    expect(() => new AuthenticatedHttpClient({
      baseUrl: 'https://acceptance.example.test',
      authentication: { host: 'production.example.test' },
      evidence,
    })).toThrow(/transport header/);
  });

  it('captures failure evidence before rethrowing a Playwright action error', async () => {
    const { evidence, sink } = collector();
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const page: PlaywrightPageLike = {
      url: () => 'https://acceptance.example.test/watch',
      locator: (selector) => ({ selector }),
      screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
      on: (event, listener) => {
        const values = listeners.get(event) ?? new Set();
        values.add(listener);
        listeners.set(event, values);
      },
      off: (event, listener) => listeners.get(event)?.delete(listener),
    };
    const browser = new PlaywrightBrowserEvidenceCollector(evidence);

    await expect(browser.run({
      artifactPrefix: 'browser-failure',
      caseId: 'protocol.bid-stream',
      page,
      action: async () => { throw new Error('Bearer failed.action.secret'); },
    })).rejects.toThrow('failed.action.secret');

    expect(sink.writes.map((entry) => entry.artifactId)).toEqual([
      'browser-failure.screenshot',
      'browser-failure.browser-log',
      'browser-failure.browser-metric',
    ]);
    expect(sink.text('browser-failure.browser-log')).not.toContain('failed.action.secret');
    expect(sink.text('browser-failure.browser-log')).toContain('[REDACTED]');
  });
});
