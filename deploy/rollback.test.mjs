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

describe('rollback.sh accepts a short sha', () => {
  // REGRESSION GUARD. Image tags are full 40-char shas, but every surface an
  // operator reads mid-incident -- git log, --list, a chat message -- prints 7.
  // Before 2026-08-14 a short sha fell through to the image-presence check and
  // was rejected with "that sha is NOT rollback-able", which is false and reads
  // as "your rollback target is gone" at the worst possible moment. (The stale
  // next-action note on WI-38800 told a successor to run exactly that command.)
  it('resolves a sha prefix against the tags present on prod', () => {
    expect(rollbackSource).toMatch(/\$\{#MATCHES\[@\]\}/);
    expect(rollbackSource).toMatch(/== "\$TARGET"\*/);
  });

  it('only resolves when the target is not already a full sha', () => {
    expect(rollbackSource).toMatch(/\^\[0-9a-f\]\{40\}\$/);
  });

  it('reports ambiguity with the candidates instead of guessing', () => {
    const resolution = rollbackSource.slice(rollbackSource.indexOf('MATCHES=()'));
    expect(resolution).toMatch(/ambiguous/i);
    expect(resolution).toMatch(/printf '.*%s.*' "\$\{MATCHES\[@\]\}"/);
  });
});

describe('the rsync preserves prod-side state instead of deleting it', () => {
  // REGRESSION GUARD for a defect that made the two guards above VACUOUS.
  //
  // deploy.sh rsyncs a snapshot of the source tree to $PROD_DIR with --delete.
  // .deployed-sha and .deploy-history live in $PROD_DIR but are written BY the
  // deploy, so they are absent from that snapshot -- and --delete removed them
  // on every single deploy, moments before PREV_SHA read .deployed-sha. So
  // "captures the previous sha before overwriting it" passed on line ORDER
  // while the value read was unconditionally empty: the auto-rollback had
  // nothing to restore to, and `rollback.sh` with no --to could never find a
  // previous sha. Observed live 2026-08-14: prod's .deploy-history held
  // exactly one entry (the running deploy's own) and .deployed-sha vanished
  // between two reads five minutes apart.
  //
  // Derived rather than hardcoded: the state files are read back out of the
  // scripts, so adding a fourth one fails here until it is also excluded.

  /** Basenames of files the scripts write into $PROD_DIR. */
  function prodStateFiles(source) {
    return [...source.matchAll(/^[A-Z_]+="\$PROD_DIR\/(\.[\w.-]+)"/gm)].map((m) => m[1]);
  }

  const declared = [...new Set([...prodStateFiles(deploySource), ...prodStateFiles(rollbackSource)])];

  it('finds the prod-side state files the scripts write (guard is not vacuous)', () => {
    expect(declared).toEqual(expect.arrayContaining(['.deployed-sha', '.deploy-history']));
  });

  it('still uses --delete, so excluding is load-bearing rather than moot', () => {
    expect(deploySource).toMatch(/rsync -az --delete/);
  });

  it.each(declared)('excludes %s from the destructive rsync', (stateFile) => {
    // Either an inline --exclude='/.foo' or membership in the PROD_STATE_FILES
    // array that the excludes are built from.
    const inline = new RegExp(`--exclude=(['"]?)/${stateFile.replace('.', '\\.')}\\1`);
    const viaArray = new RegExp(`PROD_STATE_FILES=\\([^)]*${stateFile.replace('.', '\\.')}[\\s)]`);
    expect(
      inline.test(deploySource) || viaArray.test(deploySource),
      `${stateFile} is written into $PROD_DIR but is not excluded from the rsync --delete, so every deploy destroys it`,
    ).toBe(true);
  });

  it('builds the rsync excludes from that same list, not a drifting duplicate', () => {
    expect(deploySource).toMatch(/RSYNC_EXCLUDES\+=\(--exclude="\/\$state_file"\)/);
    expect(deploySource).toMatch(/rsync -az --delete "\$\{RSYNC_EXCLUDES\[@\]\}"/);
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
