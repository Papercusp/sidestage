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
  return [
    resolve(repoRoot, '..', 'sidestage-mobile'),
    join(home, 'papercupai-workspace', 'sidestage-mobile'),
    join(home, '.papercusp', 'hives', 'sidestage-mobile'),
  ];
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

export function generateBuildHistorySnapshot(argv = process.argv.slice(2), env = process.env) {
  const result = spawnSync(projectHistoryCommand(env), projectHistoryArgs(argv, env), {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  generateBuildHistorySnapshot();
}
