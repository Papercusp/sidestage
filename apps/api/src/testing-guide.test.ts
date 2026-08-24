import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const guidePath = resolve(repoRoot, 'apps/api/TESTING.md');

describe('API testing guide contract', () => {
  it('keeps the per-project guide present and operational', () => {
    expect(existsSync(guidePath), 'apps/api must ship TESTING.md').toBe(true);

    const guide = readFileSync(guidePath, 'utf8');
    const requiredSections = [
      '## What this project\'s tests cover',
      "## What they don't cover",
      '## Run after editing',
      '## Local dev',
      '## Docker runtime smoke',
    ];

    // Calibration keeps a broken extractor from making an empty guide look valid.
    expect(requiredSections.length).toBe(5);
    for (const section of requiredSections) {
      expect(guide, `TESTING.md must retain ${section}`).toContain(section);
    }

    for (const command of [
      'npm run test:file -- apps/api/src/path/to/file.test.ts',
      'npm run test --workspace @papercusp/sidestage-api',
      'npm run typecheck --workspace @papercusp/sidestage-api',
      'npm run test:file -- apps/api/src/runtime-workspaces.test.ts apps/api/src/vertex-env-wiring.test.ts',
      'npm run check',
      'npm run build',
      'docker-compose.acceptance.yml',
      'export ACCEPTANCE_RUN_ID=',
      'export POSTGRES_USER=',
      'export POSTGRES_PASSWORD=',
      'export POSTGRES_DB=',
      '/healthz',
    ]) {
      expect(guide, `TESTING.md must document ${command}`).toContain(command);
    }
  });
});
