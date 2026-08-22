import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WI-39866 — the libs/** typecheck rail. Sibling of libs-test-coverage.test.mjs
 * (WI-39875); same failure shape, one layer up.
 *
 * The root script is `npm run typecheck --workspaces --if-present`. That
 * `--if-present` is the whole defect: a workspace with no `typecheck` script is
 * SILENTLY SKIPPED, not flagged, so `npm run typecheck` exits 0 while never
 * looking at that package at all. libs/sync sat uncovered that way carrying a
 * real TS2769, and nothing gated it — apps/web's own tsc never reached the file.
 *
 * A near-miss NAME fails exactly the same way and is harder to spot by eye:
 * libs/dock-workbench had `type-check` (hyphenated), which the root sweep does
 * not invoke. So this asserts the canonical key, not merely "something typecheck-ish".
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
const TS_SOURCE = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', '_retired']);
const PROJECT_FLAG = /(?:^|[\s'"])(?:-p|--project)(?=$|[\s='"])/;

function countTsFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) n += countTsFiles(full);
    else if (TS_SOURCE.test(entry.name)) n += 1;
  }
  return n;
}

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
      // libs/papergrid is a CONTAINER; its sources live in sub-workspaces that
      // are enumerated separately and must not be counted twice.
      const isContainer = LIB_CONTAINERS.includes(join(container, name));
      found.push({
        rel: join(container, name),
        dir,
        pkg: JSON.parse(readFileSync(pkgPath, 'utf8')),
        tsFiles: isContainer ? 0 : countTsFiles(dir),
      });
    }
  }
  return found;
}

const workspaces = libWorkspaces();
const withSource = workspaces.filter((w) => w.tsFiles > 0);

describe('libs/** typecheck coverage rail (WI-39866)', () => {
  it('finds the libs workspaces at all — positive control for the walker', () => {
    // An empty population is a broken INSTRUMENT, not a clean bill of health:
    // without this, every assertion below passes vacuously if the walk breaks.
    expect(workspaces.length).toBeGreaterThan(10);
    expect(withSource.length).toBeGreaterThan(10);
  });

  it('gives every libs workspace with TypeScript source a `typecheck` script', () => {
    const uncovered = withSource
      .filter((w) => !w.pkg.scripts?.typecheck)
      .map((w) => `${w.rel} (${w.tsFiles} .ts/.tsx files)`);
    // `npm run typecheck --workspaces --if-present` SKIPS these silently.
    expect(uncovered).toEqual([]);
  });

  it('rejects a near-miss script name the root sweep would not invoke', () => {
    // `type-check`/`typeCheck`/`tsc` all look right in a package.json and are all
    // invisible to `npm run typecheck --workspaces`.
    const nearMisses = [];
    for (const w of workspaces) {
      for (const key of Object.keys(w.pkg.scripts ?? {})) {
        if (key === 'typecheck') continue;
        if (/^(type-check|typeCheck|type_check|tsc|check-types|checkTypes)$/.test(key)) {
          nearMisses.push(`${w.rel} declares '${key}' — the root sweep only invokes 'typecheck'`);
        }
      }
    }
    expect(nearMisses).toEqual([]);
  });

  it('keeps every typecheck script actually type-checking (--noEmit, project-scoped)', () => {
    // A `typecheck` that emits, or that has no -p/--project, is not checking what
    // the workspace declares — it silently checks a default file set instead.
    // Accept both shell tokens (`tsc -p tsconfig.json`) and quoted argv entries
    // (`spawnSync(node, [compiler, '-p', 'tsconfig.json'])`); the latter is how a
    // workspace selects a pinned compiler without trusting the ambient .bin.
    const malformed = withSource
      .filter((w) => w.pkg.scripts?.typecheck)
      .filter((w) => {
        const s = w.pkg.scripts.typecheck;
        return !s.includes('--noEmit') || !PROJECT_FLAG.test(s);
      })
      .map((w) => `${w.rel}: ${w.pkg.scripts.typecheck}`);
    expect(malformed).toEqual([]);
  });
});
