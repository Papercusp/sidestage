// Guard for WI-39712: production must PROVISION AND VERIFY zero's logical
// replication, because the container cannot.
//
// infra/zero/Dockerfile execs `node_modules/.bin/zero-cache` directly and
// docker-compose.prod.yml overrides no command/entrypoint, so the two preflights
// in scripts/zero-cache-start.sh (wal_level=logical, live publication == declared)
// never run in production. Worse, until 2026-08-17 nothing in the deploy pipeline
// applied db/zero-publication.sql AT ALL — db-apply.sh is schema.sql only, and the
// initdb.d mount runs only on an empty volume — so prod's publication existed
// solely because an agent applied it by hand during the cutover.
//
// scripts/zero-replication-apply.sh closes that gap at deploy time. This file
// guards BOTH halves of it:
//   - WIRING: deploy.sh actually calls it, in the one position where it works.
//   - BEHAVIOUR: the script itself is EXERCISED against a stub psql, so the
//     FATAL branches are proven to fire rather than merely proven to exist.
// A wiring-only test would pass against a script whose checks silently no-op,
// which is precisely the failure mode being guarded against.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');
const deployScript = process.env.PROBE_DEPLOY_SCRIPT ?? path.join(here, 'deploy.sh');
const applyScript =
  process.env.PROBE_ZERO_REPLICATION_SCRIPT ??
  path.join(repositoryRoot, 'scripts', 'zero-replication-apply.sh');
const publicationFile = path.join(repositoryRoot, 'db', 'zero-publication.sql');

const deploySource = readFileSync(deployScript, 'utf8');
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function lineIndex(source, pattern) {
  return source.split('\n').findIndex((line) => pattern.test(line));
}

/** The declared table list, parsed exactly as the shell scripts parse it. */
function declaredTables() {
  const source = readFileSync(publicationFile, 'utf8');
  const start = source.indexOf('CREATE PUBLICATION zero_publication FOR TABLE');
  const end = source.indexOf('\n      );', start);
  const block = source.slice(start, end);
  return [...new Set([...block.matchAll(/public\.([a-z_]+)/g)].map((m) => m[1]))].sort();
}

/**
 * Run the real script through its SIDESTAGE_DATABASE_URL branch with a STUB psql
 * on PATH. Nothing here touches Docker or a real database, so the FATAL branches
 * can be exercised deterministically in milliseconds.
 */
function runApplyScript({ walLevel, liveTables, attempts = 1 }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zero-replication-probe-'));
  temporaryDirectories.push(directory);
  const applyLog = path.join(directory, 'applied.log');
  const psql = path.join(directory, 'psql');

  // The stub answers the three shapes the script issues: `-tAc 'show wal_level'`,
  // `-tAc "select tablename from pg_publication_tables ..."`, and `-f <file>`.
  writeFileSync(
    psql,
    [
      '#!/usr/bin/env bash',
      'args="$*"',
      `if [[ "$args" == *" -f "* ]]; then echo applied >> ${JSON.stringify(applyLog)}; exit 0; fi`,
      'if [[ "$args" == *"show wal_level"* ]]; then',
      `  [[ -n ${JSON.stringify(walLevel ?? '')} ]] || exit 1`,
      `  printf '%s\\n' ${JSON.stringify(walLevel ?? '')}; exit 0`,
      'fi',
      'if [[ "$args" == *"pg_publication_tables"* ]]; then',
      // %b, not %s: JSON.stringify emits the newlines as literal backslash-n, and
      // printf only expands escapes in its FORMAT string — `printf '%s'` would hand
      // the script one giant single-line "table name" and make every case read as
      // total drift.
      `  printf '%b\\n' ${JSON.stringify((liveTables ?? []).join('\\n'))}; exit 0`,
      'fi',
      'exit 0',
    ].join('\n'),
    'utf8',
  );
  chmodSync(psql, 0o755);

  const result = spawnSync('bash', [applyScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      SIDESTAGE_DATABASE_URL: 'postgresql://probe:probe@127.0.0.1:1/probe',
      ZERO_REPLICATION_PROBE_ATTEMPTS: String(attempts),
      ZERO_REPLICATION_PROBE_SLEEP: '0',
    },
  });

  let applied = false;
  try {
    applied = readFileSync(applyLog, 'utf8').includes('applied');
  } catch {
    applied = false;
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', applied };
}

describe('deploy.sh provisions and verifies zero logical replication', () => {
  it('calls the apply script AFTER compose up and BEFORE the health gate', () => {
    // Position is the whole point, not a style preference. wal_level comes from the
    // postgres `command:` flags and a compose command change does not reach an
    // already-created container, so a check placed with the schema apply would abort
    // the very deploy that fixes wal_level. Placed after the health gate, it would
    // let an unreplicated release be recorded as good.
    const composeUp = lineIndex(deploySource, /\$COMPOSE up -d --remove-orphans/);
    const zeroApply = lineIndex(deploySource, /bash scripts\/zero-replication-apply\.sh/);
    const healthCheck = lineIndex(deploySource, /^say "Health check"/);

    expect(composeUp).toBeGreaterThan(-1);
    expect(zeroApply).toBeGreaterThan(-1);
    expect(healthCheck).toBeGreaterThan(-1);
    expect(zeroApply).toBeGreaterThan(composeUp);
    expect(zeroApply).toBeLessThan(healthCheck);
  });

  it('treats a replication failure as a failed release, not a warning', () => {
    expect(deploySource).toMatch(/auto_rollback_failed_release "zero replication check"/);
  });

  it('passes prod’s compose file and env file, so it cannot target the wrong database', () => {
    const call = deploySource
      .split('\n')
      .find((line) => line.includes('scripts/zero-replication-apply.sh'));
    expect(call).toContain('SIDESTAGE_COMPOSE_FILE=docker-compose.prod.yml');
    expect(call).toContain('SIDESTAGE_COMPOSE_ENV_FILE=.env.production');
  });
});

describe('scripts/zero-replication-apply.sh', () => {
  it('parses every declared table out of db/zero-publication.sql', () => {
    // Positive control for every assertion below: a parse that found nothing would
    // make the drift check vacuously clean.
    const declared = declaredTables();
    expect(declared.length).toBeGreaterThanOrEqual(20);
    expect(declared).toContain('targeted_offer');
    expect(declared).toContain('product_catalog');
  });

  it('accepts a live publication that matches the declared one', () => {
    const result = runApplyScript({ walLevel: 'logical', liveTables: declaredTables() });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.applied).toBe(true);
    expect(result.stdout).toContain('wal_level=logical ok');
    expect(result.stdout).toContain('matches db/zero-publication.sql');
  });

  it('FATALs on wal_level != logical and applies nothing', () => {
    // This is the fault that hides: CREATE PUBLICATION succeeds under
    // wal_level=replica (Postgres only warns), so the publication looks complete
    // while nothing can ever stream. Refusing BEFORE the apply is the point.
    const result = runApplyScript({ walLevel: 'replica', liveTables: declaredTables() });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('wal_level=replica');
    expect(result.applied).toBe(false);
  });

  it('FATALs on declared-but-not-live drift and prints the exact ALTER', () => {
    // The WI-39710-adjacent class: db/zero-publication.sql guards its CREATE with
    // IF NOT EXISTS, so a table appended to the file after provisioning is never
    // added to an existing publication and clients die at CONNECT.
    const live = declaredTables().filter((table) => table !== 'targeted_offer');
    const result = runApplyScript({ walLevel: 'logical', liveTables: live });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('MISSING table(s)');
    expect(result.stderr).toContain('ALTER PUBLICATION zero_publication ADD TABLE public.targeted_offer;');
    // Applying the file first is correct and must still have happened — it is the
    // step that would have created the publication had it been absent. What must
    // NOT happen is the script calling the deploy clean.
    expect(result.applied).toBe(true);
  });

  it('warns but does not fail on live-but-not-declared drift', () => {
    // Reverse drift still replicates, so it is noise, not a stop. A script that
    // failed here would block deploys on a harmless extra table.
    const result = runApplyScript({
      walLevel: 'logical',
      liveTables: [...declaredTables(), 'some_extra_table'],
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('some_extra_table');
  });

  it('reports an unreachable database as unreachable, not as a replication fault', () => {
    // The false-fail shape this pipeline has been bitten by (WI-39708): a probe
    // reading "not yet" as "broken". Exit 1 (nothing mutated) is a different verdict
    // from exit 2 (a real replication fault) on purpose.
    const result = runApplyScript({ walLevel: '', liveTables: [] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not reachable');
    expect(result.applied).toBe(false);
  });
});
