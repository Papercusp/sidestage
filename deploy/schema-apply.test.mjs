import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');
const deployScript = process.env.PROBE_DEPLOY_SCRIPT ?? path.join(here, 'deploy.sh');
const dbApplyScript = process.env.PROBE_DB_APPLY_SCRIPT ?? path.join(repositoryRoot, 'scripts', 'db-apply.sh');

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

describe('production deploy applies the idempotent schema before rollout', () => {
  it('orders config validation, schema apply, then image build', () => {
    const configCheck = lineIndex(deploySource, /\$COMPOSE config --quiet/);
    const schemaApply = lineIndex(deploySource, /SIDESTAGE_COMPOSE_FILE=docker-compose\.prod\.yml/);
    const build = lineIndex(deploySource, /SIDESTAGE_SHA=\$SHA \$COMPOSE build --pull/);

    expect(configCheck, 'production config validation not found').toBeGreaterThan(-1);
    expect(schemaApply, 'production schema apply not found').toBeGreaterThan(-1);
    expect(build, 'production image build not found').toBeGreaterThan(-1);
    expect(configCheck).toBeLessThan(schemaApply);
    expect(schemaApply).toBeLessThan(build);
  });

  it('passes the production compose file and secret env file to the shared db:apply writer', () => {
    expect(deploySource).toMatch(
      /SIDESTAGE_COMPOSE_FILE=docker-compose\.prod\.yml[\s\\]+SIDESTAGE_COMPOSE_ENV_FILE=\.env\.production[\s\\]+bash scripts\/db-apply\.sh/,
    );
  });
});

describe('db:apply production compose adapter', () => {
  it('streams schema.sql through psql using the running Postgres container identity', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sidestage-db-apply-test.'));
    temporaryDirectories.push(directory);

    const fakeDocker = path.join(directory, 'docker');
    const argvFile = path.join(directory, 'docker.argv');
    const stdinFile = path.join(directory, 'docker.stdin');
    const envFile = path.join(directory, '.env.production');
    writeFileSync(envFile, 'POSTGRES_PASSWORD=test-only\n');
    writeFileSync(
      fakeDocker,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$FAKE_DOCKER_ARGV"\ncat > "$FAKE_DOCKER_STDIN"\n',
    );
    chmodSync(fakeDocker, 0o755);

    execFileSync('bash', [dbApplyScript], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        FAKE_DOCKER_ARGV: argvFile,
        FAKE_DOCKER_STDIN: stdinFile,
        PATH: `${directory}:${process.env.PATH}`,
        SIDESTAGE_COMPOSE_ENV_FILE: envFile,
        SIDESTAGE_COMPOSE_FILE: path.join(repositoryRoot, 'docker-compose.prod.yml'),
      },
      stdio: 'pipe',
    });

    const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
    expect(argv.slice(0, 6)).toEqual([
      'compose',
      '-f',
      path.join(repositoryRoot, 'docker-compose.prod.yml'),
      '--env-file',
      envFile,
      'exec',
    ]);
    expect(argv).toEqual(
      expect.arrayContaining([
        '-T',
        'postgres',
        'sh',
        '-c',
        'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -',
      ]),
    );
    expect(readFileSync(stdinFile, 'utf8')).toContain('CREATE TABLE IF NOT EXISTS event_run_of_show');
  });
});
