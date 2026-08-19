import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  generateBuildHistorySnapshot,
  mobileRepoCandidates,
  mobileRepoRoot,
  projectHistoryArgs,
  projectHistoryCommand,
  rejectedExtraRepo,
  withoutExtraRepo,
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

  it('strips only the --extra-repo pair, in both spellings', () => {
    expect(withoutExtraRepo(['--repo', '/a', '--extra-repo', '/b', '--format', 'json']))
      .toEqual(['--repo', '/a', '--format', 'json']);
    expect(withoutExtraRepo(['--extra-repo=/b', '--format', 'json']))
      .toEqual(['--format', 'json']);
  });

  it('recognises the released CLI refusal it must recover from', () => {
    expect(rejectedExtraRepo('fatal: project-history generate: unknown argument --extra-repo')).toBe(true);
    expect(rejectedExtraRepo('fatal: something else entirely')).toBe(false);
    expect(rejectedExtraRepo(undefined)).toBe(false);
  });

  /**
   * THE GUARD THAT MATTERS. `papercusp project-history` dispatches into papercup-release,
   * so this repo's generator upgrades before the CLI does. Verified live 2026-08-19: the
   * released CLI answers `unknown argument --extra-repo` and exits non-zero. Without this
   * retry the periodic snapshot refresh would break outright during the skew window.
   */
  it('retries WITHOUT --extra-repo when the installed CLI predates the flag', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const calls = [];
    const run = (_command, args) => {
      calls.push(args);
      return args.includes('--extra-repo')
        ? { status: 1, stderr: 'fatal: project-history generate: unknown argument --extra-repo' }
        : { status: 0, stderr: '' };
    };
    try {
      const status = generateBuildHistorySnapshot([], { HOME: '/home/someone' }, run, () => true);
      expect(status).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[1]).not.toContain('--extra-repo');
      // The primary repo must survive the retry — dropping it would emit an empty history.
      expect(calls[1]).toContain('--repo');
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT retry when the failure is unrelated to the flag', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const calls = [];
    const run = (_command, args) => {
      calls.push(args);
      return { status: 3, stderr: 'fatal: work_items:export resolved 0 work items' };
    };
    try {
      generateBuildHistorySnapshot([], { HOME: '/home/someone' }, run, () => true);
      // A real generation failure must stay loud, not be masked by a second attempt.
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
      process.exitCode = 0;
    }
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
