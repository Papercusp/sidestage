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

  it('warms the ephemeral runner before grading exactly three public Lighthouse reports', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const warmup = workflow.indexOf('--output-path="$report_dir/warmup.json"');
    const measuredRuns = workflow.indexOf('for run in 1 2 3; do');

    expect(warmup).toBeGreaterThan(-1);
    expect(measuredRuns).toBeGreaterThan(warmup);
    expect(workflow).toContain("' \"$report_dir\"/run-*.json");
    expect(workflow).toContain('length == 3 and all(.[];');
  });
});
