import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';
import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import webViteConfig from './apps/web/vite.config';

const repositoryRoot = fileURLToPath(new URL('.', import.meta.url));

const sourceExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.vite/**',
  '**/.papercusp/**',
  '**/_retired/**',
];

/**
 * Root-level verification must run each workspace through the configuration
 * that owns its source. A config-less `vitest run` recursively collected stale
 * CommonJS build output under dist/, skipped the web React transform, and
 * ignored the jsdom environments declared by UI-library projects.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'sidestage-deploy',
          root: repositoryRoot,
          sequence: { groupOrder: 0 },
          environment: 'node',
          include: ['deploy/**/*.test.mjs', 'scripts/**/*.test.mjs'],
          exclude: sourceExclude,
          // Every project in this topology must agree on maxWorkers — vitest 4
          // refuses to run projects that share a sequence.groupOrder with
          // different worker caps, and the libs projects below inherit the
          // @papercusp/test-config cap.
          ...sharedHostWorkerCap(),
        },
      },
      {
        test: {
          name: 'sidestage-node',
          root: repositoryRoot,
          sequence: { groupOrder: 1 },
          environment: 'node',
          include: ['apps/api/src/**/*.{test,spec}.ts'],
          exclude: sourceExclude,
          /**
           * HERMETIC BY DEFAULT. A test that boots a real Nest module (via
           * `Test.createTestingModule({ imports: [...] })`) transitively pulls in the
           * @Global DatabaseModule, whose PG_POOL factory calls createPoolOrNull() at
           * bootstrap. In 'auto' mode that DIALS the developer's Postgres on
           * 127.0.0.1:55434 and asserts its live schema — so a unit suite's verdict
           * silently depended on a shared, externally-mutated container. Recreating
           * that volume anywhere on the box turned the release gate red on unrelated
           * code (green-checkpoint candidate d6fee86480b0: `schema drift — 39 table(s)
           * missing`, from a candidate whose diff was apps/web test files only).
           *
           * 'memory' is the affordance database.module.ts documents for exactly this
           * ("forces in-memory even with a reachable database (useful in tests)"), and
           * it matches this project's existing convention that real-Postgres coverage
           * is opt-in behind SIDESTAGE_PG_INTEGRATION=1. Those integration tests
           * construct their own `new Pool(...)` rather than going through
           * createPoolOrNull(), so they are unaffected by this setting.
           *
           * Guarded by apps/api/src/db/database.module.test.ts — removing this line
           * fails that test rather than silently re-arming the flake.
           */
          env: { DATA_BACKEND: 'memory' },
          // See the sidestage-deploy project above.
          ...sharedHostWorkerCap(),
        },
      },
      mergeConfig(webViteConfig, {
        // A reviewer's local development ports must not change deterministic
        // unit-test expectations for the default public configuration.
        envDir: false,
        test: {
          name: 'sidestage-web',
          root: path.join(repositoryRoot, 'apps/web'),
          sequence: { groupOrder: 2 },
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: sourceExclude,
          // See the sidestage-deploy project above.
          ...sharedHostWorkerCap(),
        },
      }),

      /**
       * Every workspace under libs/, via ITS OWN config file rather than a
       * project entry written out here.
       *
       * Before this, the root topology was exactly the three projects above, so
       * `npm run test:file -- libs/sync/src/useRestSyncQuery.test.tsx` answered
       * "No test files found, exiting with code 1" for 7 files that are green
       * when run through the package — a FALSE ABSENCE, and the reading an agent
       * verifying a libs edit gets. Referencing the config files keeps each
       * package's own environment and setup files (jsdom for the React hooks in
       * libs/sync, the @papercusp/test-config builder's hermetic-env and leak
       * ledger elsewhere) instead of re-declaring — and drifting from — them here.
       *
       * A new libs workspace is picked up by adding a vitest.config.ts to it;
       * without one, a workspace-local `vitest run` silently inherits THIS file
       * and runs the whole monorepo from that directory (measured: 236 files).
       */
      'libs/*/vitest.config.ts',
      'libs/papergrid/*/vitest.config.ts',
    ],
  },
});
