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
const composeFile = path.join(here, '..', 'docker-compose.prod.yml');

const deploySource = readFileSync(deployScript, 'utf8');
const rollbackSource = readFileSync(rollbackScript, 'utf8');
const composeSource = readFileSync(composeFile, 'utf8');

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

describe('production checkout configuration fails closed', () => {
  const requiredCheckoutVariables = [
    'EASYPOST_API_KEY',
    'WAREHOUSE_FROM_STREET1',
    'WAREHOUSE_FROM_CITY',
    'WAREHOUSE_FROM_STATE',
    'WAREHOUSE_FROM_ZIP',
    'SQUARE_APP_ID',
    'SQUARE_LOCATION_ID',
    'SQUARE_ACCESS_TOKEN',
  ];

  it.each(requiredCheckoutVariables)('requires %s instead of defaulting it empty', (name) => {
    expect(composeSource).toContain(`\${${name}:?set in .env.production}`);
  });

  it('validates compose configuration before starting the build', () => {
    const configCheck = lineIndex(deploySource, /\$COMPOSE config --quiet/);
    const build = lineIndex(deploySource, /SIDESTAGE_SHA=\$SHA \$COMPOSE build --pull/);

    expect(configCheck).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(configCheck).toBeLessThan(build);
  });
});

describe('rollback.sh health check can actually pass', () => {
  // REGRESSION GUARD for the false health verdict. The api container is reached
  // through Traefik and deliberately is not published to host loopback, so the
  // public URL is the primary contract: it exercises DNS, TLS, ingress, and the
  // app. Container exec remains the diagnostic fallback, but must be reported as
  // degraded evidence rather than silently passing the full production check.
  it('probes public ingress first and retains an in-container fallback', () => {
    const probe = rollbackSource.slice(
      rollbackSource.indexOf('health_probe() {'),
      rollbackSource.indexOf('\nhealthy=false'),
    );
    expect(probe).toMatch(/curl -sf .*"\$HEALTH_URL"/);
    expect(probe, 'no in-container fallback when public ingress is unavailable').toMatch(
      /\$COMPOSE exec -T api node -e/,
    );
    expect(probe).not.toMatch(/curl -sf .*127\.0\.0\.1:3100\/healthz/);
  });
});

describe('rollback.sh trusts the running process over the recorded sha', () => {
  // REGRESSION GUARD for a deadlock. The "already the deployed sha -- nothing
  // to roll back" check compared against .deployed-sha, a claim written by the
  // last deploy. When that claim went stale (the health-check defect above did
  // exactly this), prod ran X, the file said Y, and rollback.sh refused to move
  // to Y because it believed prod was already there -- so the one tool that
  // could reconcile the drift was disabled BY the drift. Now that /healthz
  // reports the built sha, reality is observable; prefer it, and say so loudly
  // when the record disagrees rather than silently picking one.
  it('reads the running sha from the process, not just the file', () => {
    expect(rollbackSource).toMatch(/observed_sha\(\)/);
    expect(rollbackSource).toMatch(/RUNNING="\$\(observed_sha\)"/);
  });

  it('prefers observed reality over the recorded claim', () => {
    expect(rollbackSource).toMatch(/CURRENT="\$\{RUNNING:-\$RECORDED\}"/);
  });

  it('warns when the record and reality disagree instead of silently choosing', () => {
    expect(rollbackSource).toMatch(/"\$RUNNING" != "\$RECORDED"/);
    expect(rollbackSource).toMatch(/STALE/);
  });

  it('distinguishes a real mismatch from a can-not-tell reading', () => {
    // The post-rollback confirmation used to print the same reassuring
    // "expected for images built before /healthz reported a sha" line whether
    // the image simply carried no sha OR prod was serving a DIFFERENT sha than
    // the one just recorded. Those need opposite operator responses.
    const verify = rollbackSource.slice(rollbackSource.indexOf('served="$(observed_sha)"'));
    expect(verify).toMatch(/elif \[\[ -z "\$served" \]\]/);
    expect(verify).toMatch(/not serving what we just recorded/);
  });

  it('only accepts a full 40-char sha as an observed reading', () => {
    // "unknown" (an image built before the sha was baked in) must not be
    // mistaken for a real sha and compared against the record.
    expect(rollbackSource).toMatch(/\^\[0-9a-f\]\{40\}\$\/\.test/);
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
