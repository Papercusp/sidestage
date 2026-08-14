import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Anchored to THIS FILE, not process.cwd(): vitest runs from the repo root and
// from apps/api here, and a cwd-relative resolve made this file go red purely
// because of where the runner was started (EI-20431188762724365).
const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshot-source.sh');
const temporaryRoots = [];

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'snapshot-test@example.com',
      GIT_AUTHOR_NAME: 'Snapshot Test',
      GIT_COMMITTER_EMAIL: 'snapshot-test@example.com',
      GIT_COMMITTER_NAME: 'Snapshot Test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function git(cwd, ...args) {
  return run('git', args, cwd);
}

function initializeRepository(directory) {
  mkdirSync(directory, { recursive: true });
  git(directory, 'init', '--quiet');
  git(directory, 'config', 'user.email', 'snapshot-test@example.com');
  git(directory, 'config', 'user.name', 'Snapshot Test');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('snapshot-source.sh', () => {
  it('exports one immutable working-tree snapshot without mutating real indexes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sidestage-snapshot-test-'));
    temporaryRoots.push(root);

    const repository = path.join(root, 'repository');
    const submoduleSource = path.join(root, 'submodule-source');
    const snapshot = path.join(root, 'snapshot');

    initializeRepository(submoduleSource);
    writeFileSync(path.join(submoduleSource, 'tracked.txt'), 'submodule committed\n');
    mkdirSync(path.join(submoduleSource, '.vitest-tmp'), { recursive: true });
    writeFileSync(path.join(submoduleSource, '.vitest-tmp/results.json'), '{"tracked":true}\n');
    git(submoduleSource, 'add', '.');
    git(submoduleSource, 'commit', '--quiet', '-m', 'initial submodule');

    initializeRepository(repository);
    mkdirSync(path.join(repository, 'src'), { recursive: true });
    writeFileSync(path.join(repository, '.gitignore'), 'ignored.env\n');
    writeFileSync(path.join(repository, 'src/importer.ts'), 'export const committed = true;\n');
    mkdirSync(path.join(repository, '.vitest-tmp'), { recursive: true });
    writeFileSync(path.join(repository, '.vitest-tmp/results.json'), '{"tracked":true}\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '--quiet', '-m', 'initial root');
    git(repository, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', submoduleSource, 'libs/example');
    git(repository, 'add', '.');
    git(repository, 'commit', '--quiet', '-m', 'add submodule');

    const importerAtSnapshot = "import './new-module.js';\nexport const snapshot = true;\n";
    writeFileSync(path.join(repository, 'src/importer.ts'), importerAtSnapshot);
    writeFileSync(path.join(repository, 'src/new-module.ts'), 'export const value = 1;\n');
    writeFileSync(path.join(repository, 'ignored.env'), 'must-not-ship\n');
    writeFileSync(path.join(repository, '.vitest-tmp/untracked.json'), '{"untracked":true}\n');
    writeFileSync(path.join(repository, 'libs/example/tracked.txt'), 'submodule snapshot\n');
    writeFileSync(path.join(repository, 'libs/example/new.txt'), 'submodule new\n');
    writeFileSync(path.join(repository, 'libs/example/.vitest-tmp/untracked.json'), '{"untracked":true}\n');

    const rootStatusBefore = git(repository, 'status', '--short');
    const submoduleStatusBefore = git(path.join(repository, 'libs/example'), 'status', '--short');
    run('bash', [helper, repository, snapshot], repository);

    expect(git(repository, 'status', '--short')).toBe(rootStatusBefore);
    expect(git(path.join(repository, 'libs/example'), 'status', '--short')).toBe(submoduleStatusBefore);
    expect(git(repository, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(path.join(repository, 'libs/example'), 'diff', '--cached', '--name-only')).toBe('');

    writeFileSync(path.join(repository, 'src/importer.ts'), 'export const mutatedAfterSnapshot = true;\n');
    writeFileSync(path.join(repository, 'src/new-module.ts'), 'export const value = 2;\n');
    writeFileSync(path.join(repository, 'libs/example/tracked.txt'), 'mutated after snapshot\n');

    expect(readFileSync(path.join(snapshot, 'src/importer.ts'), 'utf8')).toBe(importerAtSnapshot);
    expect(readFileSync(path.join(snapshot, 'src/new-module.ts'), 'utf8')).toBe('export const value = 1;\n');
    expect(readFileSync(path.join(snapshot, 'libs/example/tracked.txt'), 'utf8')).toBe('submodule snapshot\n');
    expect(readFileSync(path.join(snapshot, 'libs/example/new.txt'), 'utf8')).toBe('submodule new\n');
    expect(existsSync(path.join(snapshot, 'ignored.env'))).toBe(false);
    expect(existsSync(path.join(snapshot, '.vitest-tmp/results.json'))).toBe(false);
    expect(existsSync(path.join(snapshot, 'libs/example/.vitest-tmp/results.json'))).toBe(false);
    expect(existsSync(path.join(snapshot, '.git'))).toBe(false);
  });
});
