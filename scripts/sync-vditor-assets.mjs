import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repositoryRoot, 'node_modules/vditor/dist');
const target = resolve(repositoryRoot, 'apps/web/public/vditor/dist');

if (!statSync(source).isDirectory()) {
  throw new Error(`Vditor runtime assets were not found at ${source}; run npm install first.`);
}

rmSync(dirname(target), { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
process.stdout.write(`Copied Vditor runtime assets to ${target}\n`);
