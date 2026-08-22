import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), '..');

export function pinDefaultTypescriptCli(repositoryRoot = defaultRepositoryRoot) {
  if (process.platform === 'win32') {
    return { skipped: true, reason: 'npm owns the Windows .cmd/.ps1 shims' };
  }

  const defaultCompiler = resolve(repositoryRoot, 'node_modules/typescript/bin/tsc');
  const binDirectory = resolve(repositoryRoot, 'node_modules/.bin');
  const compilerLink = resolve(binDirectory, 'tsc');

  if (!existsSync(defaultCompiler)) {
    throw new Error(`Default TypeScript compiler is missing: ${defaultCompiler}`);
  }

  mkdirSync(binDirectory, { recursive: true });
  rmSync(compilerLink, { force: true });
  symlinkSync(relative(binDirectory, defaultCompiler), compilerLink);

  return {
    skipped: false,
    compilerLink,
    target: readlinkSync(compilerLink),
  };
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  pinDefaultTypescriptCli();
}
