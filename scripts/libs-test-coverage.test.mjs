import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WI-39875 — the libs/** test-coverage rails.
 *
 * The defect this guards was silent in BOTH directions, which is why it survived
 * for so long:
 *
 *  - The root topology declared three projects (`sidestage-deploy`,
 *    `sidestage-node`, `sidestage-web`) and none matched `libs/**`, so
 *    `npm run test:file -- libs/sync/src/useRestSyncQuery.test.tsx` answered
 *    "No test files found, exiting with code 1" for a file with 7 GREEN tests.
 *    A FALSE ABSENCE is the worst possible reading for an agent verifying a libs
 *    edit — indistinguishable from "this code has no tests".
 *
 *  - A libs package with NO vitest config of its own does not fail loudly. Vitest
 *    walks UP and finds the repository root config, so `npm test` in that package
 *    ran the ENTIRE monorepo from that directory — measured at 236 files / 2,118
 *    tests, exiting 1 on two apps/web tests that resolved fixtures from cwd.
 *
 * These assertions are STRUCTURAL: they read the real tree, so a newly added libs
 * workspace is covered the moment it exists rather than when someone remembers.
 */

/**
 * Defaults to the real repository. Overridable ONLY so this guard's own
 * falsifiability can be demonstrated against a fixture tree OUTSIDE the
 * checkout — mutating the shared tree to prove a guard bites is unsafe here
 * (git-sync sweeps every few minutes and would commit the mutant).
 */
const repoRoot = process.env.SIDESTAGE_LIBS_GUARD_ROOT
  ? resolve(process.env.SIDESTAGE_LIBS_GUARD_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB_CONTAINERS = ['libs', join('libs', 'papergrid')];
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', '_retired']);

function countTestFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) n += countTestFiles(full);
    else if (TEST_FILE.test(entry.name)) n += 1;
  }
  return n;
}

/** Every libs workspace (a directory with a package.json), with its test-file count. */
function libWorkspaces() {
  const found = [];
  for (const container of LIB_CONTAINERS) {
    const containerPath = join(repoRoot, container);
    if (!existsSync(containerPath)) continue;
    for (const name of readdirSync(containerPath)) {
      if (SKIP_DIRS.has(name)) continue;
      const dir = join(containerPath, name);
      if (!statSync(dir).isDirectory()) continue;
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      // libs/papergrid is a CONTAINER whose own tests live in its sub-workspaces;
      // those are enumerated separately and must not be double-counted here.
      const isContainer = LIB_CONTAINERS.includes(join(container, name));
      found.push({
        rel: join(container, name),
        dir,
        pkg: JSON.parse(readFileSync(pkgPath, 'utf8')),
        testFiles: isContainer ? 0 : countTestFiles(dir),
      });
    }
  }
  return found;
}

const workspaces = libWorkspaces();
const withTests = workspaces.filter((w) => w.testFiles > 0);

describe('libs/** test coverage rails (WI-39875)', () => {
  it('finds the libs workspaces at all — positive control for the walker', () => {
    // Without this, every assertion below passes vacuously if the walk breaks or
    // the tree is restructured. An empty population is a broken INSTRUMENT, not
    // a clean bill of health.
    expect(workspaces.length).toBeGreaterThan(10);
    expect(withTests.length).toBeGreaterThan(10);
  });

  it('gives every libs workspace that has tests its own vitest config', () => {
    const orphaned = withTests
      .filter(
        (w) =>
          !['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js'].some((f) =>
            existsSync(join(w.dir, f)),
          ),
      )
      .map((w) => `${w.rel} (${w.testFiles} test files)`);
    // Without a config of its own, this package's `vitest run` silently inherits
    // the repository root config and runs the WHOLE monorepo from its directory.
    expect(orphaned).toEqual([]);
  });

  it('reaches every libs config from the root topology project globs', () => {
    const rootConfig = readFileSync(join(repoRoot, 'vitest.config.mts'), 'utf8');
    for (const container of LIB_CONTAINERS) {
      const glob = `'${container.split('\\').join('/')}/*/vitest.config.ts'`;
      expect(rootConfig).toContain(glob);
    }
  });

  it('keeps libs project names out of the `sidestage-*` app namespace', () => {
    // `npm run test:libs` selects `--project '!sidestage-*'`. A libs config that
    // names its project `sidestage-<x>` is therefore EXCLUDED from the libs lane
    // while looking perfectly configured — libs/zero shipped exactly that.
    const offenders = [];
    for (const w of workspaces) {
      const configPath = join(w.dir, 'vitest.config.ts');
      if (!existsSync(configPath)) continue;
      const declared = /\bname:\s*'([^']+)'/.exec(readFileSync(configPath, 'utf8'));
      if (declared && declared[1].startsWith('sidestage-')) {
        offenders.push(`${w.rel} declares project name '${declared[1]}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never lets a libs package with tests hide behind --passWithNoTests', () => {
    // The flag turns "my config matched nothing" into a silent green. It is
    // legitimate only for a package that genuinely has no test files yet.
    const falseGreens = withTests
      .filter((w) => (w.pkg.scripts?.test ?? '').includes('--passWithNoTests'))
      .map((w) => `${w.rel} (${w.testFiles} test files)`);
    expect(falseGreens).toEqual([]);
  });
});
