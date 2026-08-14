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
          include: ['deploy/**/*.test.mjs'],
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
        },
      },
      mergeConfig(webViteConfig, {
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
