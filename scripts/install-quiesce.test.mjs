/**
 * EI-20489608849476121 — regression guard for the gate reading a partially
 * installed shared node_modules.
 *
 * The load-bearing test here is `waits while an install holds the lock`. If
 * the barrier is ever reduced back to a warn-only diagnostic (which is what
 * papercusp's reader side does, and what let this bug through), that test
 * fails: it asserts the gate actually BLOCKS, not merely that it printed.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CRITICAL_BINS,
  awaitInstallQuiesce,
  installLockDir,
  missingCriticalBins,
  peekInstallLock,
  repoLockName,
} from './install-quiesce.mjs';

let lockHome;
let repoRoot;

function makeRepo({ complete = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quiesce-repo-'));
  if (complete) {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    for (const bin of CRITICAL_BINS) writeFileSync(join(root, 'node_modules', '.bin', bin), '');
  }
  return root;
}

function holdLock(root) {
  const dir = installLockDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 4242, host: 'test-host', startedAt: 'now' }));
  return dir;
}

beforeEach(() => {
  lockHome = mkdtempSync(join(tmpdir(), 'quiesce-locks-'));
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = lockHome;
  repoRoot = makeRepo();
});

afterEach(() => {
  delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  rmSync(lockHome, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('lock address contract', () => {
  // A barrier that computes a DIFFERENT lock name than the installer would
  // never rendezvous, yet every test of its own behaviour would still pass.
  it('is sha1(realpath(repoRoot)) truncated to 12 hex, prefixed npm-install-', () => {
    const expected = createHash('sha1').update(realpathSync(repoRoot)).digest('hex').slice(0, 12);
    expect(repoLockName(repoRoot)).toBe(`npm-install-${expected}`);
  });

  it('agrees with the real papercusp installer when that checkout is present', async () => {
    const helper = '/home/marsh-office/papercupai-workspace/papercusp/scripts/npm-install-safe.mjs';
    if (!existsSync(helper)) return; // sibling checkout absent — algorithm is pinned by the test above
    const real = await import(helper);
    expect(repoLockName(repoRoot)).toBe(real.repoLockName(repoRoot));
  });

  it('gives a genuinely different checkout its own lock', () => {
    const other = makeRepo();
    try {
      expect(repoLockName(other)).not.toBe(repoLockName(repoRoot));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('peekInstallLock', () => {
  it('reports not-held when no install is running', () => {
    expect(peekInstallLock(repoRoot).held).toBe(false);
  });

  it('reports held, with the owner, while an install holds the mutex', () => {
    holdLock(repoRoot);
    const peek = peekInstallLock(repoRoot);
    expect(peek.held).toBe(true);
    expect(peek.owner.pid).toBe(4242);
  });
});

describe('awaitInstallQuiesce', () => {
  it('returns immediately when nothing is installing', async () => {
    const verdict = await awaitInstallQuiesce({ repoRoot, sleep: async () => {} });
    expect(verdict).toMatchObject({ ok: true, reason: 'clear' });
  });

  it('WAITS while an install holds the lock, then proceeds once it is released', async () => {
    const dir = holdLock(repoRoot);
    let polls = 0;
    const verdict = await awaitInstallQuiesce({
      repoRoot,
      sleep: async () => {
        polls += 1;
        if (polls === 3) rmSync(dir, { recursive: true, force: true }); // the install finishes
      },
    });
    expect(polls).toBe(3); // it really blocked rather than sailing past
    expect(verdict).toMatchObject({ ok: true, reason: 'waited' });
  });

  it('fails with a timeout rather than running against a tree being rewritten', async () => {
    holdLock(repoRoot);
    let clock = 0;
    const verdict = await awaitInstallQuiesce({
      repoRoot,
      timeoutMs: 1_000,
      now: () => clock,
      sleep: async () => { clock += 400; },
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('fails loudly when node_modules is missing a critical binary', async () => {
    const partial = makeRepo({ complete: false });
    try {
      const verdict = await awaitInstallQuiesce({ repoRoot: partial, sleep: async () => {} });
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe('incomplete-node-modules');
      expect(verdict.missing).toEqual(CRITICAL_BINS);
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  });

  it('detects exactly the binary the original incident lost (tsc)', () => {
    rmSync(join(repoRoot, 'node_modules', '.bin', 'tsc'));
    expect(missingCriticalBins(repoRoot)).toEqual(['tsc']);
  });
});
