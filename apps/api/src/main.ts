import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadAppModule, loadRepoEnv } from './bootstrap-env';
import { bootstrapWithRetry } from './bootstrap-retry';

// Load the repo-root .env (cp .env.example .env per the README) without a
// dotenv dependency; already-set variables win, matching dotenv semantics.
loadRepoEnv();

async function bootstrap() {
  // AppModule reaches config-backed packages during module evaluation. Import it
  // only after loading the repo env so those packages observe the intended values.
  const AppModule = await loadAppModule();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // EI-20739798038041966: SIGTERM/SIGINT must run app.close(), which is what ends
  // the pg Pool (PgPoolLifecycle owns that). `tsx watch` signals the child on every
  // reload, so without this each reload abandoned its connections to the server's
  // idle timeout instead of closing them.
  app.enableShutdownHooks();
  try {
    app.enableCors({ origin: true, credentials: true });
    // Production routes the API behind one hostname under /api (API_PREFIX=api);
    // local dev keeps bare paths on :3100. healthz stays unprefixed for probes.
    const prefix = (process.env.API_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (prefix) app.setGlobalPrefix(prefix, { exclude: ['healthz'] });
    const port = Number(process.env.API_PORT ?? 3100);
    await app.listen(port, '0.0.0.0');
  } catch (error) {
    // EI-20739798038041966: bootstrapWithRetry re-runs this WHOLE function, so an
    // attempt that dies after NestFactory.create() must hand back everything it
    // built. Leaving the app open stranded one live 10-connection pool per attempt
    // inside a single process — ~100 of them exhausted the dev server's
    // max_connections and turned every DB-backed probe on the box into a false
    // negative. app.listen() raising EADDRINUSE is the common way in.
    await app.close().catch(() => undefined);
    throw error;
  }
}

// EI-20491819050412730: a bare `void bootstrap()` turned a RECOVERABLE dependency
// failure (Postgres unreachable / schema drift) into a permanently dead :3100 —
// the rejection killed the process, and the `tsx watch` parent only re-runs on a
// file change, so repairing the database never brought the listener back.
void bootstrapWithRetry(bootstrap).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  new Logger('Bootstrap').error(`API failed to start: ${message}`);
  process.exitCode = 1;
});
