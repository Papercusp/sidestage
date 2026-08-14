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
          name: 'sidestage-deploy',
          root: '.',
          sequence: { groupOrder: 0 },
          environment: 'node',
          include: ['deploy/**/*.test.mjs'],
          exclude: sourceExclude,
        },
      },
      {
        test: {
          name: 'sidestage-node',
          root: '.',
          sequence: { groupOrder: 1 },
          environment: 'node',
          include: ['apps/api/src/**/*.{test,spec}.ts'],
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

    ],
  },
});
