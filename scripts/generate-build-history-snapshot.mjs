import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
 * Resolved as a SIBLING of this checkout, overridable via SIDESTAGE_MOBILE_REPO. A
 * missing path yields no flag rather than a hard failure: a box without the mobile
 * checkout must still be able to regenerate the primary history.
 */
export function mobileRepoRoot(env = process.env, exists = existsSync) {
  const configured = env.SIDESTAGE_MOBILE_REPO?.trim();
  const candidate = configured
    ? resolve(configured)
    : resolve(repoRoot, '..', 'sidestage-mobile');
  return exists(join(candidate, '.git')) ? candidate : null;
}

export function projectHistoryArgs(argv = [], env = process.env, exists = existsSync) {
  const mobileRepo = mobileRepoRoot(env, exists);
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
