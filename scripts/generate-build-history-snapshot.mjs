import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const output = join(repoRoot, 'apps/api/src/build-history/build-history.snapshot.ts');

export function projectHistoryCommand(env = process.env) {
  return env.PAPERCUSP_CLI?.trim() || 'papercusp';
}

export function projectHistoryArgs(argv = [], env = process.env) {
  return [
    'project-history',
    'generate',
    '--workspace', env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace',
    '--harness', 'sidestage',
    '--prefix=',
    '--project-id', 'sidestage',
    '--project-name', 'SideStage',
    '--repo', repoRoot,
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
