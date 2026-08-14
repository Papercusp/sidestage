import { defineConfig } from 'vitest/config';

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
          name: 'sidestage-node',
          root: '.',
          sequence: { groupOrder: 1 },
          environment: 'node',
          include: [
            'apps/api/src/**/*.{test,spec}.ts',
            'libs/module-singleton/src/**/*.{test,spec}.ts',
            'libs/typesense/src/**/*.{test,spec}.ts',
          ],
          exclude: sourceExclude,
        },
      },
      {
        extends: './apps/web/vite.config.ts',
        test: {
          name: 'sidestage-web',
          root: './apps/web',
          sequence: { groupOrder: 2 },
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: sourceExclude,
        },
      },
      { extends: './libs/agent-chat/vitest.config.ts', test: { sequence: { groupOrder: 3 } } },
      { extends: './libs/dock-workbench/vitest.config.ts', test: { sequence: { groupOrder: 4 } } },
      { extends: './libs/sse/vitest.config.ts', test: { sequence: { groupOrder: 5 } } },
      { extends: './libs/sync/vitest.config.ts', test: { sequence: { groupOrder: 6 } } },
      { extends: './libs/test-config/vitest.config.ts', test: { sequence: { groupOrder: 7 } } },
      { extends: './libs/ui-primitives/vitest.config.ts', test: { sequence: { groupOrder: 8 } } },
      { extends: './libs/papergrid/bloom-grid/vitest.config.ts', test: { sequence: { groupOrder: 9 } } },
      { extends: './libs/papergrid/grid/vitest.config.ts', test: { sequence: { groupOrder: 10 } } },
      { extends: './libs/papergrid/grid-core/vitest.config.ts', test: { sequence: { groupOrder: 11 } } },
      { extends: './libs/papergrid/kv-persist/vitest.config.ts', test: { sequence: { groupOrder: 12 } } },
      {
        extends: './libs/papergrid/kv-persist-indexeddb/vitest.config.ts',
        test: { sequence: { groupOrder: 13 } },
      },
    ],
  },
});
