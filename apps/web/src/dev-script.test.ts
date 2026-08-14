import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootPackage = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('root dev:web script', () => {
  it('forwards an explicit Vite port after the npm separator and keeps it strict', () => {
    expect(rootPackage.scripts?.['dev:web']).toBe(
      'npm run dev --workspace @papercusp/sidestage-web -- --strictPort',
    );
  });
});
