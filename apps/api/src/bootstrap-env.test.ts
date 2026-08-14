import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadAppModule, loadRepoEnv } from './bootstrap-env';

/**
 * These tests build a throwaway repo layout under the OS temp dir rather than
 * probing the real checkout. That is deliberate: the previous version asserted
 * the loaded path matched /\/sidestage\/\.env$/ and relied on a real `.env`
 * being present, so it passed only where BOTH of those local-only facts held —
 * a checkout directory literally named `sidestage`, and an untracked `.env` on
 * disk. `.env` is gitignored, so in a clean clone `loadRepoEnv` found no file,
 * returned null, and the suite went red. Deriving every expectation from the
 * temp root keeps the test hermetic and independent of the checkout's name.
 */
describe('API bootstrap environment', () => {
  function makeRepo() {
    const repoRoot = mkdtempSync(join(tmpdir(), 'sidestage-bootstrap-env-'));
    const apiCwd = join(repoRoot, 'apps', 'api');
    mkdirSync(apiCwd, { recursive: true });
    return { repoRoot, apiCwd };
  }

  it('loads the repo-root env when launched from apps/api', () => {
    const { repoRoot, apiCwd } = makeRepo();
    writeFileSync(join(repoRoot, '.env'), 'FROM_REPO_ROOT=1\n');

    try {
      const loadEnvFile = vi.fn();

      const loaded = loadRepoEnv(apiCwd, loadEnvFile);

      expect(loaded).toBe(resolve(repoRoot, '.env'));
      expect(loadEnvFile).toHaveBeenCalledOnce();
      expect(loadEnvFile.mock.calls[0]?.[0]).toBe(resolve(repoRoot, '.env'));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('prefers an env beside the app over the repo-root one', () => {
    const { repoRoot, apiCwd } = makeRepo();
    writeFileSync(join(repoRoot, '.env'), 'FROM_REPO_ROOT=1\n');
    writeFileSync(join(apiCwd, '.env'), 'FROM_APP=1\n');

    try {
      const loadEnvFile = vi.fn();

      const loaded = loadRepoEnv(apiCwd, loadEnvFile);

      expect(loaded).toBe(resolve(apiCwd, '.env'));
      expect(loadEnvFile).toHaveBeenCalledOnce();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('returns null when no env file is present', () => {
    const { repoRoot, apiCwd } = makeRepo();

    try {
      const loadEnvFile = vi.fn();

      expect(loadRepoEnv(apiCwd, loadEnvFile)).toBeNull();
      expect(loadEnvFile).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('does not import AppModule until the caller requests it', async () => {
    const importer = vi.fn(async () => ({ AppModule: class TestAppModule {} }));

    expect(importer).not.toHaveBeenCalled();
    const AppModule = await loadAppModule(importer);

    expect(importer).toHaveBeenCalledOnce();
    expect(AppModule.name).toBe('TestAppModule');
  });
});
