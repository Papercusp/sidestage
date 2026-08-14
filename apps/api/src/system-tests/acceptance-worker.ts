import { createServer } from 'node:http';

const port = Number(process.env.ACCEPTANCE_WORKER_PORT ?? 3101);
const runId = process.env.ACCEPTANCE_RUN_ID ?? 'unknown';
const sha = process.env.SIDESTAGE_SHA ?? 'unknown';

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      service: 'sidestage-acceptance-worker',
      runId,
      sha,
    }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, '0.0.0.0');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
