import { describe, expect, it } from 'vitest';

import {
  projectHistoryArgs,
  projectHistoryCommand,
} from './generate-build-history-snapshot.mjs';

describe('SideStage Project History adapter', () => {
  it('uses the installed papercusp dispatcher without a source-checkout root', () => {
    expect(projectHistoryCommand({})).toBe('papercusp');
    expect(projectHistoryCommand({ PAPERCUSP_CLI: '/opt/papercusp' })).toBe('/opt/papercusp');
  });

  it('selects the complete SideStage harness and preserves caller check flags', () => {
    const args = projectHistoryArgs(['--check'], { PAPERCUSP_WORKSPACE: 'workspace-test' });
    expect(args.slice(0, 2)).toEqual(['project-history', 'generate']);
    expect(args).toContain('--prefix=');
    expect(args).toContain('--check');
    expect(args.slice(args.indexOf('--harness'), args.indexOf('--harness') + 2)).toEqual([
      '--harness',
      'sidestage',
    ]);
    expect(args.slice(args.indexOf('--workspace'), args.indexOf('--workspace') + 2)).toEqual([
      '--workspace',
      'workspace-test',
    ]);
  });
});
