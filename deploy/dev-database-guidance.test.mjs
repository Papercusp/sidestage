// RECURRENCE GUARD for WI-39266 defect 3 — "documented placeholders complete the walkthrough".
//
// 2026-08-17: README.md, docs/submission.md, and the API's own unreachable-Postgres
// warning all told a fresh clone to run `docker compose up -d` to get persistence.
// That is the ROOT compose file: it publishes 5432 and mounts no initdb scripts.
// `.env.example` (and `DEFAULT_DATABASE_URL`) dial 127.0.0.1:55434, which only
// infra/docker-compose.data.yml publishes — and only that stack applies
// db/schema.sql + db/seed/demo.sql. So a reviewer following the documented path
// got a Postgres nothing dialled, silently fell back to the in-memory stores, and
// was told by the log to re-run the very command that could not fix it.
//
// Nothing caught it because no suite compares the ADVICE against the STACK. This
// test closes that detector gap for the whole class: it derives the required port
// from DEFAULT_DATABASE_URL, finds which compose file actually serves it, and then
// requires every human-facing instruction to name that file.
//
// No Docker, no network, no Postgres — pure file reads.
//
// FALSIFIABILITY: `the root stack cannot serve DEFAULT_DATABASE_URL` below is a
// permanent NEGATIVE CONTROL. It is the reason the guidance has to be specific at
// all. If someone later teaches the root stack to publish that port AND mount the
// schema, that test fails on purpose — the advice becomes re-reviewable rather
// than silently correct-by-accident.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');

const read = (relative) => readFileSync(path.join(repositoryRoot, relative), 'utf8');

const DATA_STACK = 'infra/docker-compose.data.yml';
const ROOT_STACK = 'docker-compose.yml';

/** Resolve `${VAR:-default}` / `${VAR}` the way `docker compose config` would. */
function interpolate(value) {
  return String(value).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, _name, fallback) => fallback ?? '',
  );
}

/**
 * The HOST port a compose `ports:` entry publishes. Compose accepts
 * "host:container" and "ip:host:container"; the host port is always the segment
 * immediately before the container port.
 */
function publishedHostPorts(service) {
  return (service?.ports ?? []).map((entry) => {
    if (entry && typeof entry === 'object') return String(interpolate(entry.published ?? ''));
    const segments = interpolate(entry).split(':');
    return segments.length >= 2 ? segments[segments.length - 2] : '';
  });
}

function initdbMounts(service) {
  return (service?.volumes ?? [])
    .map((entry) => (entry && typeof entry === 'object' ? `${entry.source}:${entry.target}` : String(entry)))
    .filter((entry) => entry.includes('/docker-entrypoint-initdb.d/'));
}

function postgresService(relativeComposeFile) {
  const compose = parseYaml(read(relativeComposeFile));
  const service = compose?.services?.postgres;
  if (!service) throw new Error(`no postgres service in ${relativeComposeFile}`);
  return service;
}

/** The port the application dials when DATABASE_URL is unset. */
function defaultDatabasePort() {
  const source = read('apps/api/src/db/database.module.ts');
  const match = source.match(/DEFAULT_DATABASE_URL\s*=\s*'([^']+)'/);
  if (!match) throw new Error('DEFAULT_DATABASE_URL not found in database.module.ts');
  return new URL(match[1].replace(/^postgresql:/, 'http:')).port;
}

describe('the documented way to start the dev database is the stack that actually serves it', () => {
  it('DEFAULT_DATABASE_URL is served by the data stack, schema and seed included', () => {
    const port = defaultDatabasePort();

    // Positive control: a probe that parsed no port would pass everything below
    // vacuously.
    expect(port).toMatch(/^\d+$/);

    const postgres = postgresService(DATA_STACK);
    expect(publishedHostPorts(postgres), `${DATA_STACK} must publish ${port}`).toContain(port);

    const mounts = initdbMounts(postgres).join('\n');
    expect(mounts).toContain('db/schema.sql');
    expect(mounts).toContain('db/seed/demo.sql');
  });

  it('.env.example dials that same port, so the documented placeholders agree with the code', () => {
    const line = read('.env.example')
      .split('\n')
      .find((entry) => entry.startsWith('DATABASE_URL='));
    expect(line, '.env.example must set DATABASE_URL').toBeTruthy();
    expect(new URL(line.slice('DATABASE_URL='.length).replace(/^postgresql:/, 'http:')).port).toBe(
      defaultDatabasePort(),
    );
  });

  it('the root stack cannot serve DEFAULT_DATABASE_URL — negative control, this is what WI-39266 was', () => {
    const postgres = postgresService(ROOT_STACK);
    const port = defaultDatabasePort();

    // If BOTH of these ever become false, `docker compose up -d` would genuinely
    // work and the guidance below should be revisited — deliberately fail here so
    // that is a decision someone makes, not a drift nobody notices.
    const servesPort = publishedHostPorts(postgres).includes(port);
    const appliesSchema = initdbMounts(postgres).length > 0;
    expect(
      servesPort && appliesSchema,
      'the root stack now serves the default database — re-review the docs that steer readers away from it',
    ).toBe(false);
  });

  it('every human-facing database instruction names the data stack, never a bare `docker compose up -d`', () => {
    const surfaces = {
      'README.md': read('README.md'),
      'docs/submission.md': read('docs/submission.md'),
      'apps/api/src/db/database.module.ts': read('apps/api/src/db/database.module.ts'),
    };

    for (const [name, text] of Object.entries(surfaces)) {
      expect(text, `${name} must name ${DATA_STACK} as the database stack`).toContain(DATA_STACK);

      // A bare `docker compose up -d` with no service list is the defective advice:
      // it starts the root postgres. Naming services (`... up -d typesense redis`)
      // is fine — those really do live in the root stack.
      const bare = text.match(/docker compose up -d\s*$/gm) ?? [];
      expect(bare, `${name} still tells the reader to run a bare \`docker compose up -d\``).toEqual([]);
    }
  });
});
