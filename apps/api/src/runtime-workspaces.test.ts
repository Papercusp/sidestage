import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  dependencies?: Record<string, string>;
  engines?: { node?: string };
  exports?: Record<
    string,
    string | { types?: string; import?: string; require?: string; default?: string }
  >;
  main?: string;
  scripts?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<
    string,
    {
      dependencies?: Record<string, string>;
      engines?: { node?: string };
      link?: boolean;
      resolved?: string;
    }
  >;
}

const repoRoot = resolve(__dirname, '../../..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as T;
}

describe('API runtime workspace packages', () => {
  it('builds, locks, copies, and loads every internal runtime dependency', () => {
    const apiPackage = readJson<PackageJson>('apps/api/package.json');
    const packageLock = readJson<PackageLock>('package-lock.json');
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const apiRequire = createRequire(resolve(repoRoot, 'apps/api/package.json'));
    const internalDependencies = Object.keys(apiPackage.dependencies ?? {})
      .filter((dependency) => dependency.startsWith('@papercusp/'))
      .sort();

    expect(internalDependencies.length).toBeGreaterThan(0);
    expect(
      apiPackage.scripts?.pretypecheck,
      'typecheck must build the same internal runtime dependencies as the test lifecycle',
    ).toBe(apiPackage.scripts?.pretest);
    expect(
      apiPackage.scripts?.prebuild,
      'a clean workspace build must compile internal runtime dependencies before the API',
    ).toBe(apiPackage.scripts?.pretest);

    for (const dependency of internalDependencies) {
      expect(
        packageLock.packages?.['apps/api']?.dependencies?.[dependency],
        `${dependency} must be recorded on the apps/api lockfile edge`,
      ).toBe(apiPackage.dependencies?.[dependency]);

      const workspaceLink = packageLock.packages?.[`node_modules/${dependency}`];
      expect(workspaceLink?.link, `${dependency} must resolve to a workspace link`).toBe(true);
      expect(workspaceLink?.resolved, `${dependency} must name its workspace path`).toMatch(
        /^libs\//,
      );

      const workspacePath = workspaceLink?.resolved as string;
      const workspacePackage = readJson<PackageJson>(`${workspacePath}/package.json`);
      const rootExport = workspacePackage.exports?.['.'];
      const runtimeEntry =
        (typeof rootExport === 'object' ? rootExport.require ?? rootExport.default : rootExport) ??
        workspacePackage.main;

      expect(runtimeEntry, `${dependency} must expose a compiled runtime entry`).toMatch(
        /^\.?\/?dist\/.*\.js$/,
      );
      expect(workspacePackage.scripts?.build, `${dependency} must provide a build script`).toBeTruthy();

      const absoluteRuntimeEntry = resolve(repoRoot, workspacePath, runtimeEntry as string);
      expect(existsSync(absoluteRuntimeEntry), `${dependency} compiled entry must exist`).toBe(true);
      expect(apiRequire.resolve(dependency)).toBe(absoluteRuntimeEntry);
      expect(() => apiRequire(dependency)).not.toThrow();

      expect(dockerfile).toContain(`npm run build --workspace ${dependency}`);
      expect(dockerfile).toContain(
        `COPY --from=build /app/${workspacePath}/dist ./${workspacePath}/dist`,
      );
      expect(dockerfile).toContain(
        `COPY --from=build /app/${workspacePath}/package.json ./${workspacePath}/package.json`,
      );
    }
  });

  it('keeps the production API image on the workspace dependency engine floor', () => {
    const rootPackage = readJson<PackageJson>('package.json');
    const packageLock = readJson<PackageLock>('package-lock.json');
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const nodeImages = [...dockerfile.matchAll(/^FROM node:(\d+)-alpine(?: AS build)?$/gm)].map(
      (match) => Number(match[1]),
    );

    expect(rootPackage.engines?.node).toBe('>=22.0.0');
    expect(packageLock.packages?.['']?.engines?.node).toBe(rootPackage.engines?.node);
    expect(nodeImages).toEqual([22, 22]);

    for (const dependency of ['@rocicorp/zero', '@rocicorp/zero-sqlite3']) {
      const dependencyEngine = packageLock.packages?.[`node_modules/${dependency}`]?.engines?.node;
      expect(dependencyEngine, `${dependency} must declare its Node engine`).toBeTruthy();
      expect(nodeImages.every((major) => major >= 22), `${dependency} must run on Node >=22`).toBe(
        true,
      );
    }
  });

  it('gives the production index enough file descriptors for bulk imports', () => {
    const compose = readFileSync(resolve(repoRoot, 'docker-compose.prod.yml'), 'utf8');
    const typesenseService = compose.match(/\n  typesense:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n)/)?.[1];

    expect(typesenseService).toMatch(/\n    ulimits:\n      nofile:\n        soft: 65536\n        hard: 65536\n/);
  });

  it('passes optional Copilot model configuration through the production API seam', () => {
    const compose = readFileSync(resolve(repoRoot, 'docker-compose.prod.yml'), 'utf8');
    const envExample = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');

    for (const variable of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'SIDESTAGE_COPILOT_MODEL']) {
      expect(compose).toContain(`${variable}: \${${variable}:-}`);
      expect(envExample).toMatch(new RegExp(`^${variable}=$`, 'm'));
    }
  });
});
