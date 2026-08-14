import { createServer } from 'node:http';
import { Pool } from 'pg';

import { PostgresSystemTestRunStore, SystemTestQueueWorker } from '@papercusp/system-test-runner';

const port = Number(process.env.ACCEPTANCE_WORKER_PORT ?? 3101);
const runId = process.env.ACCEPTANCE_RUN_ID ?? 'unknown';
const sha = process.env.SIDESTAGE_SHA ?? 'unknown';
const databaseUrl = process.env.SYSTEM_TEST_DATABASE_URL?.trim();
const queueState = { enabled: Boolean(databaseUrl), running: false, lastError: '' };

let pool: Pool | null = null;
let timer: NodeJS.Timeout | null = null;
if (databaseUrl) {
  pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 2_000 });
  const queue = new SystemTestQueueWorker(new PostgresSystemTestRunStore(pool), {}, {
    maxConcurrentRuns: Number(process.env.SYSTEM_TEST_MAX_CONCURRENT_RUNS ?? 1),
    maxAttempts: Number(process.env.SYSTEM_TEST_MAX_ATTEMPTS ?? 2),
  });
  timer = setInterval(() => {
    if (queueState.running) return;
    queueState.running = true;
    void queue.runNext().catch((error: unknown) => {
      queueState.lastError = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[system-test-worker] ${queueState.lastError}\n`);
    }).finally(() => {
      queueState.running = false;
    });
  }, 1_000);
  timer.unref();
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      service: 'sidestage-acceptance-worker',
      runId,
      sha,
      queue: queueState.enabled ? (queueState.lastError ? 'degraded' : 'ready') : 'disabled',
    }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, '0.0.0.0');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (timer) clearInterval(timer);
    server.close(() => void pool?.end().finally(() => process.exit(0)));
  });
}
