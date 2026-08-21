/**
 * Guards the GUARD: apps/api/tsconfig.json's `paths` remap for
 * `@rocicorp/zero/server`, `@rocicorp/zero/server/adapters/pg`, and
 * `@rocicorp/zero/bindings` (see the comment directly above that block —
 * EI-20698695526784792, found serving P-011 / WI-39663).
 *
 * WHY THIS FILE EXISTS
 *   `paths` is NOT type-only. tsx — the loader `scripts/api-child-supervisor.mjs`
 *   runs for both `start:dev` and production `start` — honours tsconfig `paths`
 *   when it resolves these bare specifiers at RUNTIME, not just at typecheck
 *   time. A `paths` target that points at a `.d.ts` file passes `tsc --noEmit`
 *   (emit ignores `paths` entirely) and passes `vitest run` (vitest resolves
 *   through vite, not tsx — it never reproduces tsx's resolution), but
 *   MODULE_NOT_FOUNDs the instant a real tsx process loads the declaration
 *   file, whose re-export names a `.ts` the package does not ship. Because
 *   ZeroController sits in AppModule's dependency graph, that one import
 *   failure took down the ENTIRE API — and `bootstrapWithRetry` kept the
 *   listener alive across the failed attempts, so /healthz kept answering 200
 *   while the API served nothing.
 *
 *   `sync.controller.spec.ts`'s boot test does NOT catch this class: it
 *   bootstraps SyncModule in-process via vitest/vite, so it is exercising
 *   vite's module resolution, never tsx's. This file is the only check that
 *   actually reproduces production's loader.
 *
 * WHY IT SHELLS OUT TO A REAL `tsx` PROCESS instead of importing these
 * specifiers directly in this file, or re-parsing tsconfig.json's `paths`:
 *   this test file is itself compiled and executed by VITEST — through vite,
 *   not tsx — so an `import()` written directly here would resolve through
 *   vite's own resolver and could never reproduce a tsx-only failure. Parsing
 *   `paths` and asserting on the string would test the CONFIG'S SHAPE, not
 *   whether tsx can actually walk it — exactly the class of "passes but is
 *   wrong" this guard exists to close. Only a real, separate tsx process
 *   proves the specifiers resolve the way dev/prod boot needs them to.
 *
 * Lives under apps/api/src so the root vitest `sidestage-node` project picks
 * it up automatically (same placement rationale as
 * zero-publication-preflight.test.ts, in this same directory).
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const API_ROOT = resolve(REPO_ROOT, 'apps/api');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

/**
 * The exact bare specifiers apps/api/tsconfig.json remaps via `paths`. Keep
 * this list in sync with that block: a specifier added there without being
 * added here is a silent coverage gap, not a passing test.
 */
const REMAPPED_SPECIFIERS = [
  '@rocicorp/zero/server',
  '@rocicorp/zero/server/adapters/pg',
  '@rocicorp/zero/bindings',
] as const;

/**
 * Runs a throwaway tsx child process, from apps/api's own directory (so tsx
 * finds apps/api/tsconfig.json the same way `tsx watch src/main.ts` does),
 * that imports every remapped specifier. Returns the child's combined output
 * either way so a failure assertion can show the real resolver error instead
 * of a bare "exit code 1".
 */
function resolveUnderTsx(specifiers: readonly string[]): { ok: boolean; output: string } {
  const script = [
    `Promise.all([${specifiers.map((s) => `import(${JSON.stringify(s)})`).join(', ')}])`,
    `  .then(() => { process.exitCode = 0; })`,
    `  .catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exitCode = 1; });`,
  ].join('\n');

  try {
    const output = execFileSync(TSX_BIN, ['-e', script], {
      cwd: API_ROOT,
      encoding: 'utf8',
      timeout: 25_000,
    });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? e.message ?? String(error)}` };
  }
}

describe('apps/api/tsconfig.json paths — @rocicorp/zero runtime resolution under tsx', () => {
  it(
    'resolves every remapped @rocicorp/zero subpath under a real tsx process',
    () => {
      const result = resolveUnderTsx(REMAPPED_SPECIFIERS);
      expect(
        result.ok,
        `tsx failed to resolve one or more of: ${REMAPPED_SPECIFIERS.join(', ')}\n\n${result.output}`,
      ).toBe(true);
    },
    30_000,
  );
});
