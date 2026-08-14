import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadAppModule, loadRepoEnv } from './bootstrap-env';

// Load the repo-root .env (cp .env.example .env per the README) without a
// dotenv dependency; already-set variables win, matching dotenv semantics.
loadRepoEnv();

async function bootstrap() {
  // AppModule reaches config-backed packages during module evaluation. Import it
  // only after loading the repo env so those packages observe the intended values.
  const AppModule = await loadAppModule();
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true, credentials: true });
  // Production routes the API behind one hostname under /api (API_PREFIX=api);
  // local dev keeps bare paths on :3100. healthz stays unprefixed for probes.
  const prefix = (process.env.API_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (prefix) app.setGlobalPrefix(prefix, { exclude: ['healthz'] });
  const port = Number(process.env.API_PORT ?? 3100);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
