import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { loadAppModule, loadRepoEnv } from './bootstrap-env';

describe('API bootstrap environment', () => {
  it('loads the repo-root env when launched from apps/api', () => {
    const loadEnvFile = vi.fn();
    const apiCwd = process.cwd().endsWith('/apps/api')
      ? process.cwd()
      : resolve(process.cwd(), 'apps/api');

    const loaded = loadRepoEnv(apiCwd, loadEnvFile);

    expect(loaded).toBeTruthy();
    expect(loadEnvFile).toHaveBeenCalledOnce();
    expect(loadEnvFile.mock.calls[0]?.[0]).toMatch(/\/sidestage\/\.env$/);
  });

  it('does not import AppModule until the caller requests it', async () => {
    const importer = vi.fn(async () => ({ AppModule: class TestAppModule {} }));

    expect(importer).not.toHaveBeenCalled();
    const AppModule = await loadAppModule(importer);

    expect(importer).toHaveBeenCalledOnce();
    expect(AppModule.name).toBe('TestAppModule');
  });
});
