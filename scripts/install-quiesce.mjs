#!/usr/bin/env node
/**
 * EI-20489608849476121 — the release gate must never read a half-installed
 * shared `node_modules`.
 *
 * THE FAILURE THIS EXISTS FOR. At 2026-08-14 23:51 EDT the composed tree had
 * just run focused Vitest 17/17 green; the immediately following `npm run
 * check` failed because `node_modules/.bin/tsc` was ABSENT and several
 * workspaces could not resolve vitest types. Ninety seconds later the same
 * binaries were back with a fresh mtime and `npm ls` was healthy — with NO
 * manifest or lockfile diff. Nothing was wrong with the code. A concurrent
 * install had briefly emptied the very directory the gate was reading.
 *
 * WHY A WRITER-SIDE MUTEX WAS NOT ENOUGH. `scripts/npm-install-safe.mjs` in
 * the papercusp repo already serializes install-vs-install on a mkdir mutex
 * keyed to the repo root's real path (EI-18662389554660036). But this failure
 * is READER-vs-writer: the gate is not an install and never took part in that
 * protocol, so a perfectly serialized install still corrupts a concurrent
 * read. Papercusp's reader side only WARNS (`warnIfInstallInFlight`, wired to
 * be diagnostic and "must never affect the real run"), and sidestage had no
 * reader-side awareness at all.
 *
 * WHY THIS FILE DUPLICATES THE LOCK NAMING INSTEAD OF IMPORTING IT. The gate
 * must not gain a hard dependency on a sibling checkout being present — if
 * papercusp is missing the gate should still run, not crash. So the lock
 * ADDRESS is recomputed here from primitives (tmpdir + sha1 of the repo
 * root's realpath) rather than imported. That address is the contract, and it
 * is asserted against the real papercusp helper in the tests: a barrier that
 * computed a DIFFERENT lock name would silently never rendezvous with the
 * installer and would look like it worked, which is the failure mode this
 * comment exists to prevent.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Binaries the gate itself needs; their absence IS the observed symptom. */
export const CRITICAL_BINS = ['tsc', 'vitest'];

/** Mirrors fs-mutex.mjs `lockRoot()` — read at call time so tests can redirect it. */
export function lockRoot() {
  return resolve(process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR ?? join(tmpdir(), 'pcv', 'fs-mutex-locks'));
}

/** Mirrors fs-mutex.mjs `safeName()`. */
function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Mirrors npm-install-safe.mjs `repoLockName()`. realpath so a symlinked path
 * and the canonical path resolve to the IDENTICAL lock, while a genuinely
 * different checkout gets its own and is never blocked by this one.
 */
export function repoLockName(repoRoot = REPO_ROOT) {
  const real = realpathSync(resolve(repoRoot));
  const digest = createHash('sha1').update(real).digest('hex').slice(0, 12);
  return `npm-install-${digest}`;
}

export function installLockDir(repoRoot = REPO_ROOT) {
  return join(lockRoot(), `${safeName(repoLockName(repoRoot))}.lock`);
}

/** Non-blocking read of the installer's mutex. Never throws. */
export function peekInstallLock(repoRoot = REPO_ROOT) {
  const lockDir = installLockDir(repoRoot);
  try {
    return { held: true, owner: JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')), lockDir };
  } catch {
    return { held: false, lockDir };
  }
}

export function missingCriticalBins(repoRoot = REPO_ROOT) {
  return CRITICAL_BINS.filter((bin) => !existsSync(join(repoRoot, 'node_modules', '.bin', bin)));
}

const defaultSleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * Block until no install is in flight, then confirm the tree is actually
 * usable.
 *
 * Returns a verdict rather than throwing, so the caller decides the exit code:
 *   { ok: true,  waited, reason: 'clear' | 'waited' }
 *   { ok: false, reason: 'timeout' | 'incomplete-node-modules', ... }
 *
 * `incomplete-node-modules` is deliberately a FAILURE and not a warning: it is
 * the exact state that produced the original spurious red, and reporting it
 * plainly beats letting tsc fail later with a message that looks like a code
 * bug.
 */
export async function awaitInstallQuiesce(options = {}) {
  const {
    repoRoot = REPO_ROOT,
    timeoutMs = 300_000,
    pollMs = 500,
    now = () => Date.now(),
    sleep = defaultSleep,
    log = () => {},
  } = options;

  const started = now();
  let announced = false;
  let waited = 0;

  for (;;) {
    let peek;
    try {
      peek = peekInstallLock(repoRoot);
    } catch {
      // Never let a diagnostic defect block a legitimate gate run.
      return { ok: true, waited, reason: 'clear' };
    }
    if (!peek.held) break;

    if (!announced) {
      announced = true;
      const owner = peek.owner ?? {};
      log(
        `INSTALL_QUIESCE_WAITING an \`npm install\` holds ${peek.lockDir}` +
          `${owner.pid ? ` (pid ${owner.pid}${owner.host ? `@${owner.host}` : ''})` : ''}` +
          `${owner.startedAt ? ` since ${owner.startedAt}` : ''} — ` +
          'waiting for it to finish so this gate does not read a partial node_modules (EI-20489608849476121).',
      );
    }

    waited = now() - started;
    if (waited >= timeoutMs) {
      return { ok: false, reason: 'timeout', waited, owner: peek.owner, lockDir: peek.lockDir };
    }
    await sleep(pollMs);
    waited = now() - started;
  }

  const missing = missingCriticalBins(repoRoot);
  if (missing.length > 0) {
    return { ok: false, reason: 'incomplete-node-modules', waited, missing };
  }
  return { ok: true, waited, reason: announced ? 'waited' : 'clear' };
}

export function formatVerdict(verdict) {
  if (verdict.ok) {
    return verdict.reason === 'waited'
      ? `INSTALL_QUIESCE_OK install finished after ${verdict.waited}ms; node_modules is complete.`
      : 'INSTALL_QUIESCE_OK no install in flight.';
  }
  if (verdict.reason === 'timeout') {
    const owner = verdict.owner ?? {};
    return (
      `INSTALL_QUIESCE_TIMEOUT an install still holds ${verdict.lockDir} after ${verdict.waited}ms` +
      `${owner.pid ? ` (pid ${owner.pid})` : ''}. Refusing to run the gate against a tree being rewritten. ` +
      'Check `ps aux | grep "npm install"`, then retry once it finishes.'
    );
  }
  return (
    `INSTALL_QUIESCE_INCOMPLETE node_modules is missing ${verdict.missing.join(', ')} ` +
    '— this tree is partially installed, so any typecheck/test failure now would be an ARTEFACT, not a code defect ' +
    '(EI-20489608849476121). Run `npm run install:safe` and retry.'
  );
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const verdict = await awaitInstallQuiesce({ log: (line) => console.error(line) });
  console.error(formatVerdict(verdict));
  process.exit(verdict.ok ? 0 : 1);
}
