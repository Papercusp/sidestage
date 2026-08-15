import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const papercuspRepoRoot = process.env.PAPERCUSP_REPO_ROOT?.trim();

if (!papercuspRepoRoot) {
  throw new Error(
    'PAPERCUSP_REPO_ROOT is required to generate SideStage History with the shared Papercusp CLI.',
  );
}

const cli = join(papercuspRepoRoot, 'libs/papercusp/packages/cli/bin/papercusp');
if (!existsSync(cli)) {
  throw new Error(`Shared Papercusp project-history CLI not found at ${cli}`);
}

const output = join(repoRoot, 'apps/api/src/build-history/build-history.snapshot.ts');
const args = [
  'project-history',
  'generate',
  '--workspace', process.env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace',
  '--harness', 'sidestage',
  '--prefix=',
  '--project-id', 'sidestage',
  '--project-name', 'SideStage',
  '--repo', repoRoot,
  '--output', output,
  '--format', 'typescript',
  '--export-name', 'BUILD_HISTORY_SNAPSHOT',
  ...process.argv.slice(2),
];

const result = spawnSync(cli, args, {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
