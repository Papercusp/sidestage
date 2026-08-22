/**
 * EI-20489608849476121 (writer half) — the previous `install:safe` expanded an
 * UNSET env var into node "/scripts/npm-install-safe.mjs" and died
 * MODULE_NOT_FOUND, so the only serialized install path never ran. These tests
 * pin the resolution order and, above all, that a missing helper REFUSES
 * rather than silently degrading to an unserialized `npm install`.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOT_FOUND_MESSAGE, helperCandidates, resolveHelper } from './install-safe.mjs';

const HOME = '/home/agent';
const has = (set) => (candidate) => set.includes(candidate);
const realHelper = resolveHelper();
const hostHelperTest = realHelper ? it : it.skip;

describe('helper resolution', () => {
  it('prefers PAPERCUSP_REPO_ROOT when it is set', () => {
    const env = { PAPERCUSP_REPO_ROOT: '/opt/pc' };
    expect(helperCandidates(env, HOME)[0]).toBe('/opt/pc/scripts/npm-install-safe.mjs');
  });

  it('still resolves when the env var is UNSET — the exact break being fixed', () => {
    const fallback = `${HOME}/papercupai-workspace/papercusp/scripts/npm-install-safe.mjs`;
    expect(resolveHelper({}, HOME, has([fallback]))).toBe(fallback);
  });

  it('ignores an empty or whitespace env var instead of building "/scripts/..."', () => {
    // The original bug in one line: an unset/blank root must never produce an
    // absolute-root path that resolves to nothing.
    for (const blank of ['', '   ']) {
      expect(helperCandidates({ PAPERCUSP_REPO_ROOT: blank }, HOME))
        .not.toContain('/scripts/npm-install-safe.mjs');
    }
  });

  it('REFUSES rather than falling back to an unserialized npm install', () => {
    expect(resolveHelper({}, HOME, () => false)).toBeNull();
    expect(NOT_FOUND_MESSAGE).toMatch(/Refusing to fall back/);
  });

  hostHelperTest('resolves to a real helper when this host has a papercusp checkout', () => {
    expect(realHelper).not.toBeNull();
    expect(existsSync(realHelper)).toBe(true);
  });
});
