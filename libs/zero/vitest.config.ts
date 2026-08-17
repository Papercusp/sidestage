import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sidestage-zero',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
