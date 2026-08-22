import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinDefaultTypescriptCli } from '../scripts/pin-default-typescript-cli.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const typescript = require('typescript');
const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), 'utf8'));
}

function readJsonWithComments(relativePath) {
  const source = readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
  const parsed = typescript.parseConfigFileTextToJson(relativePath, source);

  expect(parsed.error, `${relativePath} must contain valid JSONC`).toBeUndefined();
  return parsed.config;
}

function expandWorkspacePattern(pattern) {
  if (!pattern.endsWith('/*')) {
    return [pattern];
  }

  const parent = pattern.slice(0, -2);
  return readdirSync(resolve(repositoryRoot, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
}

describe('production clean-install lockfile', () => {
  it('records the exact dependency declarations from every workspace manifest', () => {
    const rootPackage = readJson('package.json');
    const packageLock = readJson('package-lock.json');
    const workspacePaths = rootPackage.workspaces.flatMap(expandWorkspacePattern);
    const packagePaths = ['', ...workspacePaths].filter((workspacePath) =>
      existsSync(resolve(repositoryRoot, workspacePath, 'package.json')),
    );

    expect(packagePaths.length).toBeGreaterThan(1);

    for (const packagePath of packagePaths) {
      const manifest = readJson(join(packagePath, 'package.json'));
      const lockEntry = packageLock.packages?.[packagePath];

      expect(lockEntry, `${packagePath || '<root>'} must have a package-lock entry`).toBeTruthy();

      for (const section of dependencySections) {
        expect(
          lockEntry?.[section] ?? {},
          `${packagePath || '<root>'} ${section} must match package.json exactly`,
        ).toEqual(manifest[section] ?? {});
      }
    }
  });

  it('builds the web image on the workspace Node engine floor', () => {
    const rootPackage = readJson('package.json');
    const dockerfile = readFileSync(resolve(repositoryRoot, 'apps/web/Dockerfile'), 'utf8');
    const requiredNodeMajor = Number(rootPackage.engines.node.match(/\d+/)?.[0]);
    const webBuildNodeMajor = Number(
      dockerfile.match(/^FROM node:(\d+)-alpine AS build$/m)?.[1],
    );

    expect(requiredNodeMajor).toBeGreaterThan(0);
    expect(webBuildNodeMajor).toBeGreaterThanOrEqual(requiredNodeMajor);
  });

  it('restores the declared default compiler after a workspace alias takes the tsc bin', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'sidestage-tsc-bin-'));

    try {
      const defaultCompiler = join(fixtureRoot, 'node_modules/typescript/bin/tsc');
      const nativeCompiler = join(fixtureRoot, 'node_modules/@typescript/native/bin/tsc');
      const binDirectory = join(fixtureRoot, 'node_modules/.bin');
      const compilerLink = join(binDirectory, 'tsc');

      mkdirSync(dirname(defaultCompiler), { recursive: true });
      mkdirSync(dirname(nativeCompiler), { recursive: true });
      mkdirSync(binDirectory, { recursive: true });
      writeFileSync(defaultCompiler, '#!/usr/bin/env node\n');
      writeFileSync(nativeCompiler, '#!/usr/bin/env node\n');
      symlinkSync(relative(binDirectory, nativeCompiler), compilerLink);

      const result = pinDefaultTypescriptCli(fixtureRoot);

      expect(result.skipped).toBe(false);
      expect(resolve(binDirectory, readlinkSync(compilerLink))).toBe(defaultCompiler);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('makes native-compiler workspaces resolve their compiler explicitly', () => {
    for (const packagePath of ['libs/sse/package.json', 'libs/dock-workbench/package.json']) {
      const manifest = readJson(packagePath);
      const compilerScripts = Object.entries(manifest.scripts ?? {})
        .filter(([name]) => /^(?:build|typecheck)$/.test(name))
        .map(([, script]) => script);

      expect(manifest.devDependencies?.['@typescript/native'], packagePath).toBeTruthy();
      expect(compilerScripts.length, packagePath).toBeGreaterThan(0);
      for (const script of compilerScripts) {
        expect(script, packagePath).toContain("require.resolve('@typescript/native/package.json')");
      }
    }
  });

  it('declares and enrolls the Node types used by the Typesense workspace', () => {
    const typesensePackage = readJson('libs/typesense/package.json');
    const typesenseConfig = readJsonWithComments('libs/typesense/tsconfig.json');

    expect(typesensePackage.devDependencies?.['@types/node']).toBeTruthy();
    expect(typesenseConfig.compilerOptions?.types).toContain('node');
  });
});
