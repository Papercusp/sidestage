import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const apiPackage = JSON.parse(readFileSync(resolve(repoRoot, 'apps/api/package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const installSafeShim = readFileSync(resolve(repoRoot, 'scripts/install-safe.mjs'), 'utf8');

describe('shared-checkout install safety (EI-20412068513394843)', () => {
  it('routes SideStage installs through the root-targetable Papercusp mutex', () => {
    // EI-20489608849476121: the direct "$PAPERCUSP_REPO_ROOT/..." form died
    // MODULE_NOT_FOUND whenever the env var was unset, so installs silently
    // raced the gate. install:safe now goes through the local shim, which must
    // still resolve the SHARED Papercusp helper (env override first, known
    // checkouts as fallback), hand off root-targeted, and refuse to fall back
    // to a bare npm install — the mutex implementation is never forked here.
    expect(rootPackage.scripts['install:safe']).toBe('node scripts/install-safe.mjs --');
    expect(installSafeShim).toContain("join('scripts', 'npm-install-safe.mjs')");
    expect(installSafeShim).toContain('env.PAPERCUSP_REPO_ROOT');
    expect(installSafeShim).toContain("'--repo-root'");
    expect(installSafeShim).toContain('Refusing to fall back');
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
