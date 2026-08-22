// RECURRENCE GUARD for WI-39710 (EI-20720898577442569).
//
// 2026-08-17: docker-compose.prod.yml set `ZERO_SHARD_ID`, a key @rocicorp/zero
// REMOVED. Zero rejects it at CONFIG PARSE — before Postgres is contacted, before
// any preflight — so sidestage-zero-cache-1 crash-looped on production at exit 255.
// It shipped through a GREEN gate because nothing in any suite starts the prod
// compose file, and no test compared its zero-cache env against zero's own schema.
//
// This test closes that detector gap for the whole CLASS, not just that one key:
// it lifts the zero-cache service's `environment:` block out of the REAL prod
// compose file and feeds it to ZERO'S OWN PARSER (`parseOptions(zeroOptions)`,
// the same call `getZeroConfig` makes at container start). Any removed, renamed,
// or mistyped ZERO_* key fails here instead of on production.
//
// No Docker, no network, no Postgres — the parse is pure and runs in ~200ms.
//
// FALSIFIABILITY: `rejects a removed option` below is a permanent NEGATIVE CONTROL.
// It re-runs the identical probe with ZERO_SHARD_ID added and requires it to FAIL.
// Without it, a probe that silently parsed nothing would look exactly like a pass.
// It is an in-file control by design — it never mutates the shared tree.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');
const composeFile =
  process.env.PROBE_PROD_COMPOSE_FILE ?? path.join(repositoryRoot, 'docker-compose.prod.yml');

// A value the compose file leaves to `.env.production` (`${VAR}`, `${VAR:?msg}`).
// The parse only has to see a well-formed value of the right SHAPE; nothing here
// is a credential and nothing here is dialled.
const SUBSTITUTIONS = {
  POSTGRES_USER: 'sidestage',
  POSTGRES_PASSWORD: 'probe-placeholder',
  POSTGRES_DB: 'sidestage',
  ZERO_ADMIN_PASSWORD: 'probe-placeholder',
  SIDESTAGE_SHA: 'probe',
  PUBLIC_HOSTNAME: 'sidestage.papercusp.com',
};

/**
 * Resolve the compose-file interpolation forms `${VAR}`, `${VAR:-default}` and
 * `${VAR:?message}` the way `docker compose config` would, using SUBSTITUTIONS as
 * the stand-in environment. An unknown `${VAR}` with no default resolves to a
 * generic placeholder rather than throwing: this test judges KEY VALIDITY, and a
 * missing value is `docker compose config`'s job (deploy.sh already runs that).
 */
function interpolate(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*)|:\?[^}]*)?\}/g, (_m, name, _tail, fallback) => {
    if (SUBSTITUTIONS[name] !== undefined) return SUBSTITUTIONS[name];
    if (fallback !== undefined) return fallback;
    return 'probe-placeholder';
  });
}

function zeroCacheEnvironment() {
  const compose = parseYaml(readFileSync(composeFile, 'utf8'));
  const service = compose?.services?.['zero-cache'];
  if (!service) throw new Error(`no zero-cache service in ${composeFile}`);

  const raw = service.environment;
  const pairs = Array.isArray(raw)
    ? raw.map((entry) => {
        const at = String(entry).indexOf('=');
        return at === -1 ? [String(entry), ''] : [String(entry).slice(0, at), String(entry).slice(at + 1)];
      })
    : Object.entries(raw ?? {});

  return Object.fromEntries(pairs.map(([key, value]) => [key, interpolate(value)]));
}

// Run zero's config parser in a CHILD process: `parseOptions` reads process.env
// and can terminate the process on a bad option, so it must not run in-band.
// The env is built from scratch (no inheritance) so the ambient shell cannot
// supply a ZERO_* key the compose file does not, in either direction.
const PROBE = `
const root = process.env.PROBE_REPO_ROOT;
const { zeroOptions, ZERO_ENV_VAR_PREFIX } = await import(
  root + '/node_modules/@rocicorp/zero/out/zero-cache/src/config/zero-config.js'
);
const { parseOptions } = await import(root + '/node_modules/@rocicorp/zero/out/shared/src/options.js');
try {
  const config = parseOptions(zeroOptions, { envNamePrefix: ZERO_ENV_VAR_PREFIX, argv: [], emitDeprecationWarnings: false });
  process.stdout.write('PARSE_OK:' + String(config.enableTelemetry));
} catch (error) {
  process.stdout.write('PARSE_FAIL:' + String((error && error.message) || error).split('\\n')[0]);
  process.exitCode = 1;
}
`;

function parseWithZero(environment) {
  const zeroKeys = Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.startsWith('ZERO_')),
  );
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
    encoding: 'utf8',
    // stderr is swallowed deliberately: parseOptions dumps a full ~200-line usage
    // screen on rejection, and the one line that matters is on stdout.
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH ?? '', PROBE_REPO_ROOT: repositoryRoot, ...zeroKeys },
  });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), zeroKeys };
}

describe('docker-compose.prod.yml zero-cache env is accepted by @rocicorp/zero', () => {
  it('parses the real prod zero-cache environment with zero’s own option schema', () => {
    const { status, stdout, zeroKeys } = parseWithZero(zeroCacheEnvironment());

    // Positive control: a probe that found NO ZERO_* keys would parse clean and
    // prove nothing. The prod service genuinely sets several.
    expect(Object.keys(zeroKeys).length).toBeGreaterThan(0);
    expect(zeroKeys.ZERO_ENABLE_TELEMETRY).toBe('false');
    expect(stdout, `zero rejected the prod compose env: ${stdout}`).toBe('PARSE_OK:false');
    expect(status).toBe(0);
  });

  it('rejects a removed option — negative control, this is what WI-39710 was', () => {
    const environment = { ...zeroCacheEnvironment(), ZERO_SHARD_ID: 'sidestage' };
    const { status, stdout } = parseWithZero(environment);

    expect(status).not.toBe(0);
    expect(stdout).toContain('no longer an option');
  });

  it('keeps the prod compose free of any app/shard id — the default app id is the proven one', () => {
    // Renaming ZERO_SHARD_ID to ZERO_APP_ID would parse, and would still be wrong:
    // the app id names zero's bookkeeping schema (zero_0), and both the dev path
    // (scripts/zero-cache-start.sh) and the client (WebSocketAdapter's `new Zero`)
    // set none. Server and client must agree, so prod must not set one either.
    const environment = zeroCacheEnvironment();
    expect(Object.keys(environment)).not.toContain('ZERO_SHARD_ID');
    expect(Object.keys(environment)).not.toContain('ZERO_APP_ID');
  });
});
