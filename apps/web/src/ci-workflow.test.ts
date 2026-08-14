import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflowPath = new URL('../../../.github/workflows/ci.yml', import.meta.url);

describe('SideStage CI workflow', () => {
  it('can verify an exact commit even when its message skips automatic CI', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('  workflow_dispatch:');
    expect(workflow).toContain('    branches: [main]');
    expect(workflow).toContain('  pull_request:');
  });
});
