import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const output = join(repoRoot, 'apps/api/src/build-history/build-history.snapshot.ts');

export function projectHistoryCommand(env = process.env) {
  return env.PAPERCUSP_CLI?.trim() || 'papercusp';
}

/**
 * SideStage's iOS/Android work lives in a SEPARATE repo (Papercusp/sidestage-mobile),
 * so a mobile work item resolved zero commits and its plan rendered with no GitHub
 * links at all — which read as the links having been removed (WI-39898). Include that
 * repo's commits too; the CLI resolves its own origin, so they link to the right project.
 *
 * ⚠ A plain `<repoRoot>/../sidestage-mobile` sibling guess DOES NOT WORK here and was
 * measured returning null: `papercupai-workspace/sidestage` is a SYMLINK into
 * `~/.papercusp/hives/sidestage`, and Node resolves module paths through symlinks, so
 * repoRoot is the hives path while the mobile checkout sits beside the WORKSPACE path.
 * Both layouts are therefore probed. Order matters: an explicit override wins, then the
 * true sibling, then each known workspace root.
 */
export function mobileRepoCandidates(env = process.env) {
  const configured = env.SIDESTAGE_MOBILE_REPO?.trim();
  if (configured) return [resolve(configured)];
  const home = env.HOME ?? homedir();
  // Deduped: on a box where the checkout already sits under one of the known roots the
  // sibling guess repeats it, and a probe list that reports the same path twice reads as
  // broader coverage than it is.
  return [...new Set([
    resolve(repoRoot, '..', 'sidestage-mobile'),
    join(home, 'papercupai-workspace', 'sidestage-mobile'),
    join(home, '.papercusp', 'hives', 'sidestage-mobile'),
  ])];
}

export function mobileRepoRoot(env = process.env, exists = existsSync) {
  return mobileRepoCandidates(env).find((candidate) => exists(join(candidate, '.git'))) ?? null;
}

export function projectHistoryArgs(argv = [], env = process.env, exists = existsSync) {
  const mobileRepo = mobileRepoRoot(env, exists);
  // Never let this go missing SILENTLY. A dropped repo shows up only as work items with
  // no commits — indistinguishable from work that genuinely had none, which is the very
  // confusion this flag exists to end.
  if (!mobileRepo) {
    process.stderr.write(
      'generate-build-history-snapshot: sidestage-mobile checkout not found; its commits '
      + 'will be ABSENT from the snapshot. Looked in:\n'
      + mobileRepoCandidates(env).map((candidate) => `  - ${candidate}\n`).join('')
      + 'Set SIDESTAGE_MOBILE_REPO to point at it.\n',
    );
  }
  return [
    'project-history',
    'generate',
    '--workspace', env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace',
    '--harness', 'sidestage',
    '--prefix=',
    '--project-id', 'sidestage',
    '--project-name', 'SideStage',
    '--repo', repoRoot,
    ...(mobileRepo ? ['--extra-repo', mobileRepo] : []),
    '--output', output,
    '--format', 'typescript',
    '--export-name', 'BUILD_HISTORY_SNAPSHOT',
    ...argv,
  ];
}

/** Args with the `--extra-repo <path>` pair removed, for the compatibility retry below. */
export function withoutExtraRepo(args) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--extra-repo') { index += 1; continue; }
    if (String(args[index]).startsWith('--extra-repo=')) continue;
    output.push(args[index]);
  }
  return output;
}

/** The released CLI's exact refusal when it predates --extra-repo support. */
export function rejectedExtraRepo(stderr) {
  return /unknown argument --extra-repo/.test(stderr ?? '');
}

/**
 * ⚠ VERSION SKEW IS THE NORMAL CASE HERE, NOT AN EDGE CASE. `papercusp project-history`
 * dispatches into papercup-RELEASE, so this repo's generator is upgraded the moment
 * git-sync commits it, while the CLI that implements --extra-repo only arrives after the
 * platform change clears green-checkpoint and deploys. In that window the released CLI
 * fails HARD ("unknown argument --extra-repo"), which would take the whole periodic
 * snapshot refresh down — trading a cosmetic gap for a broken History page.
 *
 * So the flag is best-effort: on that specific refusal, retry without it and say plainly
 * that mobile commits are missing. Self-healing — it simply starts working once the
 * release carries the flag, with no second change needed here.
 */
export function generateBuildHistorySnapshot(argv = process.argv.slice(2), env = process.env, run = spawnSync) {
  const command = projectHistoryCommand(env);
  const args = projectHistoryArgs(argv, env);
  // stdout stays inherited so progress still streams; stderr is piped ONLY so the
  // skew above can be detected, then forwarded verbatim so nothing is swallowed.
  const spawnOptions = { cwd: repoRoot, env, encoding: 'utf8', stdio: ['inherit', 'inherit', 'pipe'] };

  let result = run(command, args, spawnOptions);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0 && rejectedExtraRepo(result.stderr) && args.includes('--extra-repo')) {
    process.stderr.write(
      'generate-build-history-snapshot: the installed papercusp CLI predates --extra-repo; '
      + 'regenerating WITHOUT sidestage-mobile. Its commits are ABSENT from this snapshot '
      + 'until the platform release carries the flag (WI-39898).\n',
    );
    result = run(command, withoutExtraRepo(args), spawnOptions);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  generateBuildHistorySnapshot();
}
