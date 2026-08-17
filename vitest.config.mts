import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
        },
      }),

    ],
  },
});
