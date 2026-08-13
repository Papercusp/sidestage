import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';

// Load the repo-root .env (cp .env.example .env per the README) without a
// dotenv dependency; already-set variables win, matching dotenv semantics.
for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      // An unreadable .env should not stop the API; env vars simply stay unset.
    }
    break;
  }
}

async function bootstrap() {
  // AppModule reaches config-backed packages during module evaluation. Import it
  // only after loading the repo env so those packages observe the intended values.
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  // Production routes the API behind one hostname under /api (API_PREFIX=api);
  // local dev keeps bare paths on :3100. healthz stays unprefixed for probes.
  const prefix = (process.env.API_PREFIX ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (prefix) app.setGlobalPrefix(prefix, { exclude: ['healthz'] });
  const port = Number(process.env.API_PORT ?? 3100);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
