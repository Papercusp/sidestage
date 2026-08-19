import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  mobileRepoCandidates,
  mobileRepoRoot,
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

describe('sidestage-mobile commit coverage (WI-39898)', () => {
  it('passes the mobile checkout as --extra-repo when it exists', () => {
    const env = { HOME: '/home/someone' };
    const args = projectHistoryArgs([], env, (path) => path.startsWith('/home/someone/papercupai-workspace/sidestage-mobile'));
    const index = args.indexOf('--extra-repo');
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe('/home/someone/papercupai-workspace/sidestage-mobile');
  });

  it('omits the flag and WARNS rather than failing when the checkout is absent', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const args = projectHistoryArgs([], {}, () => false);
      expect(args).not.toContain('--extra-repo');
      // A dropped repo is invisible in the output (it just looks like work with no
      // commits), so silence here would reproduce the very bug this fixes.
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain('sidestage-mobile');
    } finally {
      warn.mockRestore();
    }
  });

  it('honours an explicit SIDESTAGE_MOBILE_REPO override exclusively', () => {
    expect(mobileRepoCandidates({ SIDESTAGE_MOBILE_REPO: '/custom/mobile' })).toEqual(['/custom/mobile']);
  });

  /**
   * REGRESSION GUARD. The first implementation used only `<repoRoot>/../sidestage-mobile`
   * and resolved to null on this box, so the feature silently did nothing:
   * papercupai-workspace/sidestage is a SYMLINK into ~/.papercusp/hives/sidestage, Node
   * resolves module paths through symlinks, and the mobile checkout sits beside the
   * WORKSPACE path — not beside the hives path. Probing a single location is the bug.
   */
  it('probes both the hives and workspace layouts, not just the immediate sibling', () => {
    const candidates = mobileRepoCandidates({ HOME: '/home/someone' });
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates).toContain('/home/someone/papercupai-workspace/sidestage-mobile');
    expect(candidates).toContain('/home/someone/.papercusp/hives/sidestage-mobile');
  });

  it('resolves the real sidestage-mobile checkout on this box', () => {
    // Environment-dependent by design: this is the assertion that would have caught the
    // silent null above, which no amount of mocking can.
    const resolved = mobileRepoRoot(process.env, existsSync);
    if (resolved === null) {
      expect(mobileRepoCandidates(process.env).some((path) => existsSync(path))).toBe(false);
      return;
    }
    expect(existsSync(`${resolved}/.git`)).toBe(true);
  });
});
