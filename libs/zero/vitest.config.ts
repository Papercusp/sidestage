import { sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Deliberately UNNAMED, so the project inherits its package name
    // (@papercusp/sidestage-zero). The old explicit `sidestage-zero` collided
    // with the root topology's `sidestage-*` app-project namespace, which
    // `npm run test:libs` selects AGAINST — so any test added here would have
    // been silently excluded from the libs run.
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // See libs/sync/vitest.config.ts — every project in the root topology must
    // agree on maxWorkers or vitest 4 refuses the run.
    ...sharedHostWorkerCap(),
  },
});
