import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLIENT_TRANSPORT_SURFACES,
  CONTROLLER_SURFACES,
  DEVICE_LOCAL_SURFACES,
  EXTERNAL_COMMAND_SURFACES,
  POSTGRES_SURFACES,
  PROCESS_LOCAL_SURFACES,
  SYNC_MUTATOR_SURFACES,
  SYNC_QUERY_SURFACES,
  findUnclassified,
  type SurfaceContract,
} from './data-surface-census';

const REPO_ROOT = resolve(__dirname, '../../../..');
const API_ROOT = join(REPO_ROOT, 'apps/api/src');
const WEB_ROOT = join(REPO_ROOT, 'apps/web/src');

function sourceFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (/\.(?:ts|tsx)$/.test(name) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(name)) output.push(absolute);
    }
  };
  visit(root);
  return output;
}

const read = (path: string) => readFileSync(path, 'utf8');
const repoPath = (path: string) => relative(REPO_ROOT, path).replaceAll('\\', '/');
const sorted = (values: readonly string[]) => [...values].sort();

function captureAll(files: readonly string[], pattern: RegExp, value: (match: RegExpExecArray, file: string) => string): string[] {
  const found: string[] = [];
  for (const file of files) {
    const source = read(file);
    pattern.lastIndex = 0;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) found.push(value(match, file));
  }
  return sorted([...new Set(found)]);
}

function assertComplete(contract: SurfaceContract, label: string): void {
  expect(contract.domain, `${label}.domain`).not.toBe('');
  expect(contract.audiences.length, `${label}.audiences`).toBeGreaterThan(0);
  expect(contract.authority, `${label}.authority`).not.toBe('');
  expect(contract.zeroDisposition, `${label}.zeroDisposition`).not.toBe('');
  expect(contract.identityScope, `${label}.identityScope`).not.toBe('');
  expect(contract.fallback, `${label}.fallback`).not.toBe('');
  expect(contract.freshnessSlo, `${label}.freshnessSlo`).not.toBe('');
  expect(contract.migrationOwner, `${label}.migrationOwner`).toMatch(/^P-\d{3}/);
}

describe('Universal Zero data-surface census', () => {
  const apiFiles = sourceFiles(API_ROOT);
  const webFiles = sourceFiles(WEB_ROOT);

  it('classifies every Postgres table created by db/schema.sql', () => {
    const schema = read(join(REPO_ROOT, 'db/schema.sql'));
    const tables = [...schema.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi)]
      .map((match) => match[1].toLowerCase());
    expect(sorted(Object.keys(POSTGRES_SURFACES))).toEqual(sorted(tables));
  });

  it('classifies every named SyncQueryRegistry registration', () => {
    const moduleFiles = apiFiles.filter((file) => file.endsWith('.module.ts'));
    const registered = captureAll(moduleFiles, /queries\.register\('([^']+)'/g, (match) => match[1]);
    expect(sorted(SYNC_QUERY_SURFACES.map((surface) => surface.name))).toEqual(registered);
  });

  it('classifies every useSyncMutate path consumed by the web client', () => {
    const used = captureAll(
      webFiles,
      /useSyncMutate(?:<[\s\S]*?>)?\(\s*'([^']+)'/g,
      (match) => match[1],
    );
    expect(sorted(SYNC_MUTATOR_SURFACES.map((surface) => surface.name))).toEqual(used);
  });

  it('classifies every process-local class Map that can hide an authority or cache', () => {
    const maps = captureAll(
      apiFiles,
      /(?:private\s+)?readonly\s+#?([A-Za-z0-9_]+)\s*=\s*new\s+Map/g,
      (match, file) => `${repoPath(file)}#${match[1]}`,
    );
    const declared = PROCESS_LOCAL_SURFACES.map((surface) => `${surface.source}#${surface.name}`);
    expect(sorted(declared)).toEqual(maps);
  });

  it('classifies every Nest controller boundary', () => {
    const controllers = apiFiles.filter((file) => file.endsWith('.controller.ts')).map(repoPath);
    expect(sorted(CONTROLLER_SURFACES.map((surface) => surface.source))).toEqual(sorted(controllers));
  });

  it('classifies every browser module that owns a direct fetch or EventSource path', () => {
    const transports = webFiles
      .filter((file) => /fetch\(|createResilientEventSource\(|new\s+EventSource/.test(read(file)))
      .map(repoPath);
    expect(sorted(CLIENT_TRANSPORT_SURFACES.map((surface) => surface.source))).toEqual(sorted(transports));
  });

  it('classifies every browser module with device-local durable storage', () => {
    const deviceLocal = webFiles
      .filter((file) => /localStorage|sessionStorage|indexedDB/.test(read(file)))
      .map(repoPath);
    expect(sorted(DEVICE_LOCAL_SURFACES.map((surface) => surface.source))).toEqual(sorted(deviceLocal));
  });

  it('classifies every API module making a raw external fetch', () => {
    const rawFetches = apiFiles
      .filter((file) => !file.endsWith('.snapshot.ts') && /fetch\(/.test(read(file)))
      .map(repoPath);
    const declared = EXTERNAL_COMMAND_SURFACES.filter((surface) => surface.usesRawFetch).map((surface) => surface.source);
    expect(sorted(declared)).toEqual(sorted(rawFetches));
  });

  it('requires authority, Zero boundary, identity, fallback, SLO, and owner metadata everywhere', () => {
    const collections: readonly (readonly (SurfaceContract & { name?: string; source?: string })[])[] = [
      Object.entries(POSTGRES_SURFACES).map(([name, contract]) => ({ ...contract, name })),
      SYNC_QUERY_SURFACES,
      SYNC_MUTATOR_SURFACES,
      PROCESS_LOCAL_SURFACES,
      CONTROLLER_SURFACES,
      CLIENT_TRANSPORT_SURFACES,
      DEVICE_LOCAL_SURFACES,
      EXTERNAL_COMMAND_SURFACES,
    ];
    for (const collection of collections) {
      for (const [index, contract] of collection.entries()) {
        assertComplete(contract, contract.name ?? contract.source ?? `surface-${index}`);
      }
    }
  });

  it('fails closed when any discovered surface is not in the census', () => {
    expect(findUnclassified(['events.guide', 'new.private.query'], SYNC_QUERY_SURFACES.map((surface) => surface.name)))
      .toEqual(['new.private.query']);
    expect(findUnclassified(['cart', 'new_authority'], Object.keys(POSTGRES_SURFACES)))
      .toEqual(['new_authority']);
  });
});
