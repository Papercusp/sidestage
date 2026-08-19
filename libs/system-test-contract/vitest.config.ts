import { sharedHostWorkerCap } from '@papercusp/test-config/vitest-config';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // See libs/sync/vitest.config.ts — every project in the root topology must
    // agree on maxWorkers or vitest 4 refuses the run.
    ...sharedHostWorkerCap(),
  },
});
