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

describe('shared-checkout install safety (EI-20412068513394843)', () => {
  it('routes SideStage installs through the root-targetable Papercusp mutex', () => {
    expect(rootPackage.scripts['install:safe']).toBe(
      'node "$PAPERCUSP_REPO_ROOT/scripts/npm-install-safe.mjs" --repo-root . --',
    );
  });

  it('excludes the hoisted parent node_modules before tsx starts watching the API entrypoint', () => {
    const command = apiPackage.scripts['start:dev'];
    expect(command).toContain("tsx watch --exclude '../../node_modules/**' src/main.ts");
    expect(command.indexOf('--exclude')).toBeLessThan(command.indexOf('src/main.ts'));
  });
});
