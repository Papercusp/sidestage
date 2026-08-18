import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { computeTreeState } from './tree-state.mjs';

// Anchored to THIS FILE, not process.cwd(): vitest runs this project from the
// repository root and from apps/api, and a cwd-relative resolve turns the file
// red purely because of where the runner started (EI-20431188762724365).
const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tree-state.mjs');
const temporaryRoots = [];

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', cwd, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'tree-state-test@example.com',
      GIT_AUTHOR_NAME: 'Tree State Test',
      GIT_COMMITTER_EMAIL: 'tree-state-test@example.com',
      GIT_COMMITTER_NAME: 'Tree State Test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The hand-rolled check this module replaces: superproject HEAD, porcelain and
 * diff. Present as a POSITIVE CONTROL. Every assertion that the new digest
 * catches a mutation is paired with an assertion that THIS stays blind to it —
 * otherwise a test claiming the guard works would also pass against a guard
 * that merely hashes a timestamp, and the bug it was written for would be
 * unproven.
 */
function superprojectOnlyFingerprint(repository) {
  const parts = [
    git(repository, 'rev-parse', 'HEAD'),
    git(repository, 'status', '--porcelain'),
    git(repository, 'diff'),
  ].join('');
  return createHash('sha256').update(parts).digest('hex');
}

function initializeRepository(directory) {
  mkdirSync(directory, { recursive: true });
  git(directory, 'init', '--quiet', '--initial-branch=main');
  git(directory, 'config', 'user.email', 'tree-state-test@example.com');
  git(directory, 'config', 'user.name', 'Tree State Test');
}

/** Superproject with one submodule at libs/sub, both committed and clean. */
function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tree-state-fixture.'));
  temporaryRoots.push(root);

  const submodule = path.join(root, 'sub');
  initializeRepository(submodule);
  writeFileSync(path.join(submodule, 'lib.txt'), 'original\n');
  git(submodule, 'add', '-A');
  git(submodule, 'commit', '--quiet', '-m', 'init');

  const parent = path.join(root, 'parent');
  initializeRepository(parent);
  writeFileSync(path.join(parent, 'top.txt'), 'top\n');
  git(parent, 'add', '-A');
  git(parent, 'commit', '--quiet', '-m', 'init');
  git(parent, 'submodule', 'add', '--quiet', submodule, 'libs/sub');
  git(parent, 'commit', '--quiet', '-m', 'add submodule');

  return { root, parent, submodulePath: path.join(parent, 'libs/sub') };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('tree-state fingerprint', () => {
  it('is stable when nothing changes', () => {
    const { parent } = createFixture();
    expect(computeTreeState(parent).digest).toBe(computeTreeState(parent).digest);
  });

  it('does not disturb the repository it measures', () => {
    const { parent, submodulePath } = createFixture();
    writeFileSync(path.join(submodulePath, 'lib.txt'), 'dirty\n');

    const statusBefore = git(parent, 'status', '--porcelain');
    const submoduleStatusBefore = git(submodulePath, 'status', '--porcelain');
    computeTreeState(parent);

    expect(git(parent, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(submodulePath, 'status', '--porcelain')).toBe(submoduleStatusBefore);
  });

  it('catches a tracked-file edit inside an ALREADY-DIRTY submodule', () => {
    // The exact 2026-08-15 shape: the tree is dirty before AND after, so the
    // superproject sees ` M libs/sub` at both ends and reports no change.
    const { parent, submodulePath } = createFixture();
    writeFileSync(path.join(submodulePath, 'lib.txt'), 'dirty\n');

    const before = computeTreeState(parent).digest;
    const controlBefore = superprojectOnlyFingerprint(parent);

    writeFileSync(path.join(submodulePath, 'lib.txt'), 'MUTATED BY THE SUITE\n');

    expect(computeTreeState(parent).digest).not.toBe(before);
    expect(superprojectOnlyFingerprint(parent)).toBe(controlBefore);
  });

  it('catches a NEW untracked file inside an already-dirty submodule', () => {
    const { parent, submodulePath } = createFixture();
    writeFileSync(path.join(submodulePath, 'lib.txt'), 'dirty\n');

    const before = computeTreeState(parent).digest;
    const controlBefore = superprojectOnlyFingerprint(parent);

    writeFileSync(path.join(submodulePath, 'leftover.txt'), 'stray build output\n');

    expect(computeTreeState(parent).digest).not.toBe(before);
    expect(superprojectOnlyFingerprint(parent)).toBe(controlBefore);
  });

  it('catches a binary change inside an already-dirty submodule', () => {
    const { parent, submodulePath } = createFixture();
    writeFileSync(path.join(submodulePath, 'blob.bin'), Buffer.from([0, 1, 2, 3]));

    const before = computeTreeState(parent).digest;
    const controlBefore = superprojectOnlyFingerprint(parent);

    writeFileSync(path.join(submodulePath, 'blob.bin'), Buffer.from([0, 1, 2, 4]));

    expect(computeTreeState(parent).digest).not.toBe(before);
    expect(superprojectOnlyFingerprint(parent)).toBe(controlBefore);
  });

  it('catches a commit inside the submodule that leaves the gitlink stale', () => {
    const { parent, submodulePath } = createFixture();
    writeFileSync(path.join(submodulePath, 'lib.txt'), 'dirty\n');

    const before = computeTreeState(parent).digest;

    git(submodulePath, 'add', '-A');
    git(submodulePath, 'commit', '--quiet', '-m', 'committed inside the submodule');

    // Content is now identical to `before`; what moved is the submodule HEAD.
    // Recording each repository's own HEAD is what makes this visible.
    expect(computeTreeState(parent).digest).not.toBe(before);
  });

  it('catches content in a NESTED submodule', () => {
    const { root, parent } = createFixture();

    const inner = path.join(root, 'inner');
    initializeRepository(inner);
    writeFileSync(path.join(inner, 'deep.txt'), 'deep\n');
    git(inner, 'add', '-A');
    git(inner, 'commit', '--quiet', '-m', 'init');

    const outerSubmodule = path.join(parent, 'libs/sub');
    git(outerSubmodule, 'submodule', 'add', '--quiet', inner, 'vendor/inner');
    git(outerSubmodule, 'commit', '--quiet', '-m', 'add nested submodule');

    const before = computeTreeState(parent).digest;
    writeFileSync(path.join(outerSubmodule, 'vendor/inner/deep.txt'), 'CHANGED TWO LEVELS DOWN\n');

    expect(computeTreeState(parent).digest).not.toBe(before);
  });

  it('still catches ordinary superproject changes', () => {
    const { parent } = createFixture();
    const before = computeTreeState(parent).digest;
    writeFileSync(path.join(parent, 'top.txt'), 'changed\n');
    expect(computeTreeState(parent).digest).not.toBe(before);
  });

  it('records an uninitialized submodule rather than skipping it', () => {
    const { parent, submodulePath } = createFixture();
    rmSync(submodulePath, { recursive: true, force: true });
    mkdirSync(submodulePath, { recursive: true });

    const state = computeTreeState(parent);
    const entry = state.repositories.find((repository) => repository.path === 'libs/sub');

    expect(entry).toBeDefined();
    expect(entry.tree).toBe('UNINITIALIZED');
  });

  it('reports every repository in the composed tree', () => {
    const { parent } = createFixture();
    const paths = computeTreeState(parent).repositories.map((repository) => repository.path);
    expect(paths).toEqual(['.', 'libs/sub']);
  });

  it('ignores an ambient GIT_INDEX_FILE in the environment', () => {
    // A caller that exports GIT_INDEX_FILE (a wrapper script, another tool
    // mid-operation) would otherwise redirect the reads meant to see the
    // repository's REAL index, and the digest would describe a stale index
    // instead of the working tree.
    const { parent, submodulePath } = createFixture();
    const clean = computeTreeState(parent).digest;

    const previous = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = path.join(tmpdir(), 'tree-state-ambient-index');
    try {
      expect(computeTreeState(parent).digest).toBe(clean);
      writeFileSync(path.join(submodulePath, 'lib.txt'), 'changed under an ambient index\n');
      expect(computeTreeState(parent).digest).not.toBe(clean);
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_INDEX_FILE;
      } else {
        process.env.GIT_INDEX_FILE = previous;
      }
    }
  });

  it('prints the digest on the command line', () => {
    const { parent } = createFixture();
    const printed = execFileSync('node', [helper, '--repo', parent], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    expect(printed).toBe(computeTreeState(parent).digest);
    expect(printed).toMatch(/^[0-9a-f]{64}$/);
  });
});
