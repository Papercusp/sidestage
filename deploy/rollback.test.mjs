import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Anchor to THIS FILE, not process.cwd(): vitest is invoked from several
// working directories here (repo root, apps/api), and a cwd-relative resolve
// goes red purely because of where the runner was started (EI-20431188762724365).
const here = path.dirname(fileURLToPath(import.meta.url));

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh style) -- never by mutating the shared checkout,
// where git-sync would commit the mutant on its next sweep.
const deployScript = process.env.PROBE_DEPLOY_SCRIPT ?? path.join(here, 'deploy.sh');
const rollbackScript = process.env.PROBE_ROLLBACK_SCRIPT ?? path.join(here, 'rollback.sh');

const deploySource = readFileSync(deployScript, 'utf8');
const rollbackSource = readFileSync(rollbackScript, 'utf8');

/** Index of the first line matching `pattern`, or -1. */
function lineIndex(source, pattern) {
  return source.split('\n').findIndex((line) => pattern.test(line));
}

describe('deploy.sh records the deployed sha only after the health check', () => {
  // REGRESSION GUARD. Before 2026-08-14 deploy.sh wrote .deployed-sha
  // immediately after `up -d` and ran the health check afterwards. A deploy
  // that came up unhealthy therefore left prod asserting a sha it had never
  // verified -- and because .deployed-sha is what rollback.sh and every
  // operator reads to answer "what is live?", the one file you consult during
  // an incident was the one guaranteed to be wrong during an incident.
  it('writes .deployed-sha after the health-check verdict, not before', () => {
    const healthVerdict = lineIndex(deploySource, /^if ! \$healthy; then/);
    const shaWrite = lineIndex(deploySource, /> \$DEPLOYED_SHA_FILE/);

    expect(healthVerdict, 'health-check verdict block not found').toBeGreaterThan(-1);
    expect(shaWrite, '.deployed-sha write not found').toBeGreaterThan(-1);
    expect(shaWrite).toBeGreaterThan(healthVerdict);
  });

  it('captures the previous sha before overwriting it, so rollback has a target', () => {
    const prevRead = lineIndex(deploySource, /^PREV_SHA=/);
    // The REAL build invocation -- not the `[dry-run] would ... $COMPOSE build`
    // echo further up, which is a message and mutates nothing.
    const build = lineIndex(deploySource, /SIDESTAGE_SHA=\$SHA \$COMPOSE build --pull/);

    expect(prevRead).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(prevRead).toBeLessThan(build);
  });

  it('auto-rolls-back when the health check fails', () => {
    expect(deploySource).toMatch(/AUTO-ROLLBACK/);
    expect(deploySource).toMatch(/rollback\.sh" --to "\$PREV_SHA"/);
  });

  it('tags built images with the sha so the release stays recoverable', () => {
    expect(deploySource).toMatch(/SIDESTAGE_SHA=\$SHA \$COMPOSE build/);
    expect(deploySource).toMatch(/docker tag sidestage-api:\$SHA sidestage-api:latest/);
  });
});

describe('rollback.sh argument handling', () => {
  function run(args) {
    try {
      const stdout = execFileSync('bash', [rollbackScript, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  // These paths are reached before any ssh call, so they run without prod.
  it('rejects an unknown argument instead of silently ignoring it', () => {
    const { code, stderr } = run(['--bogus']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown argument/);
  });

  it('prints usage for --help without touching prod', () => {
    const { code, stdout } = run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/--to <sha>/);
  });
});

describe('rollback.sh refuses to half-run', () => {
  it('verifies the target images exist before changing anything', () => {
    const imageCheck = lineIndex(rollbackSource, /docker image inspect sidestage-api:\$TARGET/);
    const composeUp = lineIndex(rollbackSource, /\$COMPOSE up -d --no-build/);

    expect(imageCheck).toBeGreaterThan(-1);
    expect(composeUp).toBeGreaterThan(-1);
    // The existence check must gate the mutation, not follow it.
    expect(imageCheck).toBeLessThan(composeUp);
  });

  it('leaves .deployed-sha untouched when the rolled-back release is unhealthy', () => {
    const unhealthy = lineIndex(rollbackSource, /^if ! \$healthy; then/);
    const shaWrite = lineIndex(rollbackSource, /> \$DEPLOYED_SHA_FILE/);

    expect(unhealthy).toBeGreaterThan(-1);
    expect(shaWrite).toBeGreaterThan(unhealthy);
  });

  it('reports how long the rollback took, so the drill is timed', () => {
    expect(rollbackSource).toMatch(/ELAPSED=/);
    expect(rollbackSource).toMatch(/Rollback complete: .* in \$\{ELAPSED\}s/);
  });
});
