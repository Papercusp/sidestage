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
const composeFile =
  process.env.PROBE_COMPOSE_FILE ?? path.join(here, '..', 'docker-compose.prod.yml');

const deploySource = readFileSync(deployScript, 'utf8');
// deploy.sh with comment lines stripped. Source-text guards MUST assert on this
// rather than on deploySource: the script's own header quotes the retired
// argument-parsing idiom verbatim so the next reader knows what was wrong, and
// a guard that cannot tell code from prose either goes red against a correct
// script or -- worse -- is satisfied by a comment DESCRIBING the behaviour it
// is supposed to be proving. Both happened here (WI-38905).
const deployCode = deploySource
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
const rollbackSource = readFileSync(rollbackScript, 'utf8');
const composeSource = readFileSync(composeFile, 'utf8');

/** Index of the first line matching `pattern`, or -1. */
function lineIndex(source, pattern) {
  return source.split('\n').findIndex((line) => pattern.test(line));
}

function shellFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`${name} function not found`);
  return source.slice(start, end + 3);
}

/**
 * Drive the scripts' real health_probe with a stubbed curl/ssh.
 *
 * `publicStatus` / `publicBody` express what the PUBLIC url actually answered,
 * which is the distinction WI-39708 turned on: the old stub could only say
 * "a 200 carrying sha X" or "nothing", so a 3xx — the state prod was actually
 * in — was inexpressible and therefore untested. The stub mimics
 * `curl -w '\n%{http_code}'`: body, newline, status code.
 */
function runHealthProbe(
  source,
  { publicSha, publicStatus, publicBody, containerSha },
  target = '547c47e4dac6b10e8c9c164b1e73275744b34712',
) {
  const bodyCheck = shellFunction(source, 'health_body_reports_sha');
  const publicLeg = shellFunction(source, 'public_health_body');
  const probe = shellFunction(source, 'health_probe');
  const stubBody = publicBody ?? (publicSha ? `{"sha":"${publicSha}"}` : '');
  // No status at all == curl itself failed to get a response (exit 7), which
  // is a DIFFERENT thing from an HTTP error and must stay distinguishable.
  const stubCode = publicStatus ?? (publicSha ? '200' : '');
  return execFileSync('bash', ['-c', `
    set -euo pipefail
    HEALTH_URL=https://sidestage.example/healthz
    PROD_DIR=/opt/SideStage
    COMPOSE='docker compose -f docker-compose.prod.yml'
    TARGET=${target}
    curl() {
      [[ -n '${stubCode}' ]] || return 7
      printf '%s\\n%s' '${stubBody}' '${stubCode}'
    }
    ssh_stub() {
      [[ -n "${containerSha ?? ''}" ]] || return 22
      printf '{"sha":"%s"}' '${containerSha ?? ''}'
    }
    SSH=(ssh_stub)
    HEALTH_LEG=none
    HEALTH_BODY=''
    ${bodyCheck}
    ${publicLeg}
    ${probe}
    if health_probe "$TARGET"; then result=ok; else result=failed; fi
    printf '%s\n%s\n%s\n' "$result" "$HEALTH_LEG" "$HEALTH_BODY"
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

describe.each([
  ['deploy.sh', deploySource],
  ['rollback.sh', rollbackSource],
])('%s preserves the health-probe result in the caller shell', (_name, source) => {
  it('reports the public leg and body', () => {
    expect(runHealthProbe(source, {
      publicSha: '547c47e4dac6b10e8c9c164b1e73275744b34712',
    })).toBe(
      'ok\npublic\n{"sha":"547c47e4dac6b10e8c9c164b1e73275744b34712"}\n',
    );
  });

  it('reports the container fallback and body', () => {
    expect(runHealthProbe(source, {
      containerSha: '547c47e4dac6b10e8c9c164b1e73275744b34712',
    })).toBe(
      'ok\ncontainer\n{"sha":"547c47e4dac6b10e8c9c164b1e73275744b34712"}\n',
    );
  });

  it('rejects a public 200 from the wrong release and uses the target container', () => {
    expect(runHealthProbe(source, {
      publicSha: 'eae0aa0b5eafc0a12e7efe527744fb8d42c4d293',
      containerSha: '547c47e4dac6b10e8c9c164b1e73275744b34712',
    })).toBe(
      'ok\ncontainer\n{"sha":"547c47e4dac6b10e8c9c164b1e73275744b34712"}\n',
    );
  });

  it('rejects an HTTP 200 body that does not report the target sha', () => {
    expect(runHealthProbe(source, {
      publicSha: 'eae0aa0b5eafc0a12e7efe527744fb8d42c4d293',
    })).toBe(
      'failed\npublic\n{"sha":"eae0aa0b5eafc0a12e7efe527744fb8d42c4d293"}\n',
    );
  });

  // WI-39708 REGRESSION GUARD. `curl -sf` fails only on >= 400, so a 3xx
  // SUCCEEDED and handed the redirect body back as if it were /healthz output.
  // Live on 2026-08-17: prod moved to sidestage.papercusp.com, the stale
  // sidestage.buyrestart.com default 301'd there, and the probe compared the
  // literal string "Moved Permanently" against the expected sha -- so a
  // perfectly healthy deploy reported a sha MISMATCH. The old harness could
  // not even express this case, which is why it shipped.
  it('does not accept a 3xx redirect body as the public health body', () => {
    expect(runHealthProbe(source, {
      publicStatus: '301',
      publicBody: 'Moved Permanently',
    })).toBe('failed\nnone\n\n');
  });

  it('falls back to the container leg when the public url only redirects', () => {
    expect(runHealthProbe(source, {
      publicStatus: '301',
      publicBody: 'Moved Permanently',
      containerSha: '547c47e4dac6b10e8c9c164b1e73275744b34712',
    })).toBe(
      'ok\ncontainer\n{"sha":"547c47e4dac6b10e8c9c164b1e73275744b34712"}\n',
    );
  });

  it('does not accept a 500 body as the public health body', () => {
    expect(runHealthProbe(source, {
      publicStatus: '500',
      publicBody: '{"sha":"547c47e4dac6b10e8c9c164b1e73275744b34712"}',
    })).toBe('failed\nnone\n\n');
  });

  it('gates the public leg on a 2xx status rather than on curl --fail', () => {
    const probeCode = shellFunction(source, 'public_health_body')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(probeCode).not.toMatch(/curl\s+-sf/);
    expect(probeCode).toMatch(/%\{http_code\}/);
    // -L would follow the redirect and report a DIFFERENT host's health as
    // ours -- a quieter failure than the one being fixed, not a fix.
    expect(probeCode).not.toMatch(/curl\s[^\n]*-L\b/);
  });

  it('never calls health_probe through command substitution', () => {
    expect(source).not.toMatch(/[A-Z_a-z]+="\$\(health_probe(?: [^)]*)?\)"/);
    expect(source).toMatch(/if health_probe/);
  });
});

// WI-39708. The probe url must name the host PROD serves. Both scripts used to
// hardcode a local default under a comment asserting prod does not define
// PUBLIC_HOSTNAME -- prod does (verified 2026-08-17 by reading
// /opt/SideStage/.env.production: PUBLIC_HOSTNAME=sidestage.papercusp.com), and
// the stale default 301'd, which is what made the redirect body reachable at
// all. A constant restating prod config is the defect class, so the guard is
// that the scripts RESOLVE it rather than that they hold the right constant.
describe.each([
  ['deploy.sh', deploySource],
  ['rollback.sh', rollbackSource],
])('%s resolves the public hostname from prod, not from a local constant', (_name, source) => {
  it('reads PUBLIC_HOSTNAME out of prod .env.production', () => {
    const resolver = shellFunction(source, 'resolve_public_hostname');
    expect(resolver).toMatch(/PUBLIC_HOSTNAME=/);
    expect(resolver).toMatch(/\.env\.production/);
  });

  it('still honours an explicit PUBLIC_HOSTNAME override', () => {
    const resolver = shellFunction(source, 'resolve_public_hostname');
    expect(resolver).toMatch(/\$\{PUBLIC_HOSTNAME:-\}/);
  });

  // Deliberately asserted on CODE, not on prose: both scripts quote the
  // retired "prod does not define PUBLIC_HOSTNAME" claim verbatim in their
  // history comments so the next reader knows what was wrong, and a guard that
  // cannot tell code from prose goes red against a correct script (the same
  // lesson deployCode exists for). The defect was never the sentence -- it was
  // a hardcoded hostname being used as the probe target.
  it('does not default PUBLIC_HOSTNAME to a hardcoded hostname in code', () => {
    const code = source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/PUBLIC_HOSTNAME="\$\{PUBLIC_HOSTNAME:-[^}]+\}"/);
  });

  // The last-resort fallback is the ONE constant left. Pin it to compose's own
  // default so the two can never disagree about what an unconfigured prod gets.
  it('pins its fallback to docker-compose.prod.yml’s own default', () => {
    const scriptFallback = source.match(/^COMPOSE_DEFAULT_PUBLIC_HOSTNAME=(\S+)$/m)?.[1];
    const composeDefault = composeSource.match(
      /\$\{PUBLIC_HOSTNAME:-([^}]+)\}/,
    )?.[1];
    expect(scriptFallback).toBeTruthy();
    expect(composeDefault).toBeTruthy();
    expect(scriptFallback).toBe(composeDefault);
  });
});

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
    // SEAM, not spelling (EI-20721172349887197): what has to be true is that
    // `latest` is moved onto the SHA-TAGGED image, so the previous sha stays
    // recoverable. Pinning the literal `docker tag ...` invocation made the
    // correct fix present as a test failure — the shape that kept the `curl -sf`
    // bug alive in this same file. This still fails if the two refs stop being
    // tagged together, but survives `docker image tag`, buildx, or podman.
    expect(deploySource).toMatch(/sidestage-api:\$SHA\s+sidestage-api:latest/);
  });
});

describe('production checkout configuration fails closed', () => {
  const requiredCheckoutVariables = [
    'EASYPOST_API_KEY',
    'WAREHOUSE_FROM_STREET1',
    'WAREHOUSE_FROM_CITY',
    'WAREHOUSE_FROM_STATE',
    'WAREHOUSE_FROM_ZIP',
    'STRIPE_SECRET_KEY',
    'STRIPE_PUBLISHABLE_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'DEEPGRAM_API_KEY',
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

  it('does not retain the retired Square credential contract', () => {
    expect(composeSource).not.toMatch(/\bSQUARE_[A-Z_]+\b/);
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
    // Was `curl -sf "$HEALTH_URL"` inline until WI-39708. The public leg now
    // goes through public_health_body, which gates on a 2xx, so a 3xx can no
    // longer be handed back as a health body. Asserting the OLD spelling here
    // would pin the defect in place -- which is exactly what this line did.
    expect(probe).toMatch(/if body="\$\(public_health_body\)"/);
    expect(rollbackSource, 'the public leg must read the status, not trust curl --fail')
      .toMatch(/%\{http_code\}/);
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
    expect(rollbackSource).toMatch(/\$\{RUNNING:-\$\{CONTAINER_SHA:-\$RECORDED\}\}/);
  });

  it('uses the selected container image when a failed API cannot report its sha', () => {
    const select = shellFunction(rollbackSource, 'select_current_sha');
    const selected = execFileSync('bash', ['-c', `
      set -euo pipefail
      RUNNING=''
      CONTAINER_SHA=68874fae50c66990bc498ff9f2bed6b8ab679e77
      RECORDED=eae0aa0b5eafc0a12e7efe527744fb8d42c4d293
      ${select}
      select_current_sha
    `], { encoding: 'utf8' });

    expect(selected).toBe('68874fae50c66990bc498ff9f2bed6b8ab679e77');
    // The line above already proves the BEHAVIOUR by executing select_current_sha
    // and checking what it returns, so this assertion only has to pin the DATA
    // SOURCE — that the sha is recovered from the container's configured image.
    // It previously pinned `docker inspect --format '{{...}}'` verbatim, which
    // would go red for `-f`, a different template spelling, or podman, none of
    // which changes the behaviour the test above actually verified
    // (EI-20721172349887197).
    expect(rollbackSource).toMatch(/\.Config\.Image/);
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
    // `--delete` is the load-bearing flag this test is NAMED for; `-az` is
    // incidental transport tuning that has nothing to do with the property being
    // guarded. Pinning both meant a change to compression or archive flags read
    // as breaking the exclusion guarantee (EI-20721172349887197).
    //
    // ⚠ ANCHORED to the start of a line ON PURPOSE. The obvious broadening,
    // /rsync[^\n]*--delete/, is VACUOUS here: deploy.sh carries the comment
    // "# ... so `rsync --delete` deletes every one of them unless excluded",
    // which satisfies it even when the real invocation loses the flag. Measured,
    // not assumed — a copy-out mutation stripping --delete from the actual rsync
    // SURVIVED the unanchored form and is CAUGHT by this one. That is the same
    // comment-satisfiable trap WI-38905 found in this file; keep the anchor.
    expect(deploySource).toMatch(/^\s*rsync[^\n]*--delete/m);
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
    // The property is that the SAME array the loop builds is what reaches rsync
    // (not a hand-maintained duplicate that drifts from it). Flag spelling and
    // argument order are not part of that property, so they are no longer pinned
    // (EI-20721172349887197).
    // Line-anchored for the same reason as the --delete guard above: an
    // unanchored source-text match can be satisfied by prose describing the
    // behaviour instead of the code performing it.
    expect(deploySource).toMatch(/^\s*rsync[^\n]*"\$\{RSYNC_EXCLUDES\[@\]\}"/m);
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

/** The post-deploy sha verification block, between its own banner and the record step. */
function shaVerificationBlock() {
  const start = deploySource.indexOf('say "Verifying /healthz reports the sha we just shipped"');
  const end = deploySource.indexOf('say "Recording deployed sha');
  return start > -1 && end > start ? deploySource.slice(start, end) : '';
}

describe('deploy.sh proves what it shipped before recording it', () => {
  // REGRESSION GUARD for a VACUOUS CHECK -- the most dangerous defect class,
  // because success and "never actually ran" are indistinguishable from the
  // output. Until 2026-08-14 this block curl'd an unpublished host loopback
  // port with a trailing `|| true`, so `served` was UNCONDITIONALLY empty, the
  // case statement ALWAYS fell to a WARN branch whose text pre-excused its own
  // failure ("Expected on the first deploy after the sha-reporting change"),
  // and the deploy exited 0. It never once compared a sha to anything, on any
  // run it ever made, while printing a benign-looking message every time.

  it('reads the sha through the reported-leg probe, never a swallowed failure', () => {
    const verify = shaVerificationBlock();
    expect(verify, 'sha verification block not found in deploy.sh').not.toBe('');
    expect(verify, 'must read the body through health_probe so the leg is known').toMatch(
      /health_probe "\$SHA"/,
    );
    expect(verify, '`|| true` swallows the read and makes the comparison vacuous').not.toMatch(
      /\|\|\s*true/,
    );
  });

  it('fails the deploy on a mismatch instead of warning and exiting 0', () => {
    const verify = shaVerificationBlock();
    expect(verify, 'a mismatch must invoke the guarded rollback path').toMatch(
      /auto_rollback_failed_release "sha verification" 5/,
    );
    expect(verify, 'a branch that pre-excuses its own failure cannot detect one').not.toMatch(
      /Expected on the first deploy/,
    );
  });

  it('verifies BEFORE recording, so .deployed-sha never names an unproven sha', () => {
    const verifyIndex = lineIndex(deploySource, /Verifying \/healthz reports the sha/);
    const recordIndex = lineIndex(deploySource, /Recording deployed sha/);

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(recordIndex).toBeGreaterThan(-1);
    expect(verifyIndex, 'recording an unverified sha is what makes prod and the file disagree')
      .toBeLessThan(recordIndex);
  });

  it('probes public ingress first and retains an in-container fallback', () => {
    const probe = deploySource.slice(
      deploySource.indexOf('health_probe() {'),
      deploySource.indexOf('\nSNAPSHOT_DIR='),
    );
    // Was `curl -sf "$HEALTH_URL"` inline until WI-39708 -- see rollback.sh's
    // copy of this guard. Pinning the old spelling pinned the defect.
    expect(probe).toMatch(/if body="\$\(public_health_body\)"/);
    expect(deploySource, 'the public leg must read the status, not trust curl --fail')
      .toMatch(/%\{http_code\}/);
    expect(probe, 'no in-container fallback when public ingress is unavailable').toMatch(
      /\$COMPOSE exec -T api node -e/,
    );
    expect(probe, 'the host loopback port is never published; this leg can only ever fail')
      .not.toMatch(/curl -sf .*127\.0\.0\.1:3100\/healthz/);
  });

  it('says which leg answered, so a fallback is never mistaken for a full pass', () => {
    expect(deploySource).toMatch(/HEALTH_LEG=/);
    expect(deploySource).toMatch(/API healthy via \$HEALTH_LEG leg/);
    expect(deploySource, 'falling back to the container leg leaves ingress unverified').toMatch(
      /ingress is NOT verified/,
    );
  });
});

describe('docker-compose.prod.yml keeps the api unpublished', () => {
  // REGRESSION GUARD for a fix that manufactures its own confirmation. On
  // 2026-08-14 a `ports: - "127.0.0.1:3100:3100"` mapping was committed to make
  // the three dead loopback probes pass. It would have worked -- and that is
  // precisely the danger: it turns every red probe green while adding host
  // surface the architecture deliberately avoids. The api is EXPOSED, not
  // PUBLISHED; Traefik reaches it over the `coolify` docker network.
  it('never publishes container port 3100 to the host', () => {
    expect(composeSource).not.toMatch(/^\s*-\s*"?127\.0\.0\.1:3100:3100"?/m);
  });

  it('still routes to 3100 through traefik, which is how it is actually reached', () => {
    expect(composeSource).toMatch(/loadbalancer\.server\.port=3100/);
  });
});

describe('deploy.sh argument handling', () => {
  // REGRESSION GUARD (WI-38905). Until 2026-08-14 deploy.sh parsed arguments
  // with a single exact-match test on $1:
  //     [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true
  // Every OTHER argument was silently ignored and fell through into a REAL
  // PRODUCTION DEPLOY. `deploy.sh --help` -- the universal safe-probe reflex --
  // was run on 2026-08-14T17:20Z believing it printed usage; it rsync'd 748
  // files to /opt/SideStage and applied prod schema before being killed, which
  // in turn aborted a concurrent deploy with `tuple concurrently updated`
  // (WI-38904). rollback.sh had had the correct case-loop guard all along;
  // deploy.sh, the more destructive of the pair, never did.
  //
  // SAFETY OF THIS BLOCK: these tests EXECUTE deploy.sh with arguments, which
  // is only safe while the guard under test is intact -- exactly what a
  // regression removes. So PROD_HOST is pinned to 192.0.2.1 (RFC5737
  // TEST-NET-1, guaranteed unroutable). If the guard is ever deleted, these
  // calls fail here on an unroutable connect instead of shipping to real prod.
  function run(args) {
    try {
      const stdout = execFileSync('bash', [deployScript, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PROD_HOST: '192.0.2.1' },
        timeout: 30_000,
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  it('refuses an unknown argument instead of silently deploying', () => {
    const { code, stderr } = run(['--bogus']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown argument/);
  });

  it('refuses a TYPO of the safe flag rather than treating it as a deploy', () => {
    // `deploy.sh --dry-runn` was a full production deploy before this guard.
    const { code, stderr } = run(['--dry-runn']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown argument/);
  });

  it('prints usage for --help without touching prod', () => {
    const { code, stdout } = run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/--dry-run/);
  });

  it('prints the WHOLE header for --help, not a hardcoded line range', () => {
    // The first version of this guard printed `sed -n '2,18p'`, which silently
    // truncated the Requirements section the moment the usage block grew by
    // three lines. The range is now derived from the `set -euo pipefail` line.
    const { stdout } = run(['--help']);
    expect(stdout).toMatch(/Requirements on the dev box/);
  });

  it('parses flags in a loop, so a safe flag is honoured in any position', () => {
    // Asserted on the parser rather than by execution: with only one valid
    // flag there is no two-valid-flag invocation to demonstrate positional
    // independence behaviourally. The old idiom read $1 and nothing else.
    //
    // Assert on CODE, not raw source. deploy.sh's own comment block quotes the
    // retired idiom verbatim so the next reader knows what was wrong -- and the
    // first version of this test matched that citation and went red against a
    // correct script. A source-text guard that cannot tell code from prose
    // punishes documenting the very fix it protects. (deployCode is hoisted to
    // module scope so every source-text guard in this file shares it.)

    expect(deployCode).not.toMatch(/\[\[\s*"\$\{1:-\}"\s*==\s*"--dry-run"\s*\]\]/);
    expect(deployCode).toMatch(/while\s*\[\[\s*\$#\s*-gt\s*0\s*\]\]/);
  });

  it('refuses rather than ignores — the unknown-arg branch exits non-zero', () => {
    // Guard against a "fix" that prints a warning and deploys anyway.
    //
    // Asserted on the CATCH-ALL BRANCH, not on the whole file. The first
    // version of this guard tested `deploySource` for /unknown argument/ and
    // /exit 2/ anywhere in the script, and a mutation probe proved it VACUOUS
    // against the very regression it names: replacing this branch's `exit 2`
    // with `shift` -- warn, then deploy anyway -- left it GREEN, because
    // /exit 2/ was still satisfied by the header comment that DESCRIBES the
    // refusal and by an unrelated `exit 2` further down. A guard that a
    // comment can satisfy is prose, not a guard. Scope it to the branch.
    const argLoop = deployCode.slice(deployCode.indexOf('while [[ $# -gt 0 ]]'));
    const catchAll = argLoop.slice(argLoop.indexOf('*)'), argLoop.indexOf('esac'));

    // Guard is not vacuous: the slice really is the catch-all branch.
    expect(catchAll).toMatch(/unknown argument/);
    expect(catchAll.length).toBeGreaterThan(0);
    // The branch must LEAVE the script non-zero, not fall through to a deploy.
    expect(catchAll).toMatch(/\bexit\s+[1-9]\d*/);
  });
});
