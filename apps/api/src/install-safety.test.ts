import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const apiPackage = JSON.parse(readFileSync(resolve(repoRoot, 'apps/api/package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const installSafeEntrypoint = resolve(repoRoot, 'scripts/install-safe.mjs');
const loadInstallSafe = () =>
  import(pathToFileURL(installSafeEntrypoint).href) as Promise<{
    helperCandidates: (env?: NodeJS.ProcessEnv, home?: string) => string[];
    resolveHelper: (
      env?: NodeJS.ProcessEnv,
      home?: string,
      exists?: (p: string) => boolean,
    ) => string | null;
    NOT_FOUND_MESSAGE: string;
  }>;

describe('shared-checkout install safety (EI-20412068513394843)', () => {
  // WHY THIS ASSERTS BEHAVIOUR AND NOT A LITERAL STRING (EI-20489608849476121):
  // this guard used to pin the exact command
  //   node "$PAPERCUSP_REPO_ROOT/scripts/npm-install-safe.mjs" --repo-root . --
  // PAPERCUSP_REPO_ROOT is not set in the agent environment, so that expanded to
  // node "/scripts/npm-install-safe.mjs" and died MODULE_NOT_FOUND. The guard
  // passed the whole time, because a string comparison cannot tell you the
  // string names a path that does not exist. The one serialized install path
  // this repo had therefore never ran once, while its guard stayed green.
  // These tests assert the PROPERTY the guard exists to protect instead.

  it('routes SideStage installs through the root-targetable Papercusp mutex', async () => {
    const command = rootPackage.scripts['install:safe'];
    expect(command).toBe('node scripts/install-safe.mjs --');
    expect(existsSync(installSafeEntrypoint)).toBe(true);

    const { helperCandidates } = await loadInstallSafe();
    const candidates = helperCandidates({ PAPERCUSP_REPO_ROOT: '/opt/pc' }, '/home/agent');

    // Every candidate must target the SHARED helper — the mutex, its stale-owner
    // reclaim and its post-install verification must never be forked or reimplemented.
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.endsWith(join('scripts', 'npm-install-safe.mjs'))).toBe(true);
    }
    // The env var stays the supported override, and stays FIRST.
    expect(candidates[0]).toBe(resolve('/opt/pc', 'scripts/npm-install-safe.mjs'));
  });

  it('does not depend on an environment variable that is silently empty when unset', () => {
    // THE RECURRENCE GUARD for the original defect. An unset shell variable does
    // not fail loudly, it expands to '' and yields a plausible-looking dead path.
    // install:safe must resolve its target in code, where a miss can be detected.
    const command = rootPackage.scripts['install:safe'];
    expect(command).not.toMatch(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/);
  });

  it('refuses to degrade to an unserialized install when the helper is missing', async () => {
    const { resolveHelper, NOT_FOUND_MESSAGE } = await loadInstallSafe();

    // Nothing on disk -> null, so the caller must fail loudly. Injecting `exists`
    // keeps this independent of whether a papercusp checkout exists on THIS box.
    expect(resolveHelper({ PAPERCUSP_REPO_ROOT: '/opt/pc' }, '/home/agent', () => false)).toBe(
      null,
    );
    // Present -> the override wins.
    expect(resolveHelper({ PAPERCUSP_REPO_ROOT: '/opt/pc' }, '/home/agent', () => true)).toBe(
      resolve('/opt/pc', 'scripts/npm-install-safe.mjs'),
    );
    // A bare `npm install` fallback would restore the exact race this item fixed.
    // (No whole-source not.toMatch(/npm install/) here on purpose: the entrypoint
    // legitimately says "npm install" in prose — its shim comment and
    // NOT_FOUND_MESSAGE — so that regex fails on documentation, not behaviour.
    // The null-return + NOT_FOUND_MESSAGE assertions above pin the property.)
    expect(NOT_FOUND_MESSAGE).toContain('Refusing to fall back');
  });

  it('excludes generated dependency trees before tsx starts watching the API entrypoint', () => {
    const command = apiPackage.scripts['start:dev'];
    expect(command).toContain("tsx watch --exclude '../../node_modules/**'");
    expect(command).toContain("--exclude '../../libs/**/dist/**' src/main.ts");
    expect(command.indexOf("--exclude '../../node_modules/**'")).toBeLessThan(
      command.indexOf('src/main.ts'),
    );
    expect(command.indexOf("--exclude '../../libs/**/dist/**'")).toBeLessThan(
      command.indexOf('src/main.ts'),
    );
  });
});
