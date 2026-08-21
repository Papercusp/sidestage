import react from '@vitejs/plugin-react';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const webRoot = fileURLToPath(new URL('.', import.meta.url));
const reactRefreshRuntime = join('@vitejs', 'plugin-react', 'dist', 'refresh-runtime.js');

type RuntimeLookupOptions = {
  fileExists?: (path: string) => boolean;
  realpath?: (path: string) => string;
};

/** Resolve a workspace dependency exactly as Node would: nearest node_modules first. */
export function findNearestDependencyRuntime(
  startDirectory: string,
  repositoryBoundary: string,
  runtimeRelativePath: string,
  { fileExists = existsSync, realpath = realpathSync }: RuntimeLookupOptions = {},
): string | null {
  const start = resolve(startDirectory);
  const boundary = resolve(repositoryBoundary);
  const relativeStart = relative(boundary, start);
  if (relativeStart === '..' || relativeStart.startsWith(`..${sep}`) || isAbsolute(relativeStart)) {
    throw new Error(`Dependency lookup start must be inside ${boundary}; received ${start}`);
  }

  let directory = start;
  while (true) {
    const candidate = join(directory, 'node_modules', runtimeRelativePath);
    if (fileExists(candidate)) return realpath(candidate);
    if (directory === boundary) return null;
    directory = dirname(directory);
  }
}

type DependencyTopologyGuardOptions = {
  intervalMs?: number;
  findRuntime?: () => string | null;
  fileExists?: (path: string) => boolean;
};

/**
 * A running @vitejs/plugin-react instance retains an absolute path to its
 * refresh runtime. npm workspace re-hoisting can invalidate that path while
 * leaving Vite alive and the HTML shell healthy. Restart Vite only after the
 * old path is gone and a replacement runtime is fully present.
 */
export function createDependencyTopologyGuard({
  intervalMs = 1_000,
  findRuntime = () =>
    findNearestDependencyRuntime(webRoot, repositoryRoot, reactRefreshRuntime),
  fileExists = existsSync,
}: DependencyTopologyGuardOptions = {}): Plugin {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return {
    name: 'sidestage-dependency-topology-guard',
    apply: 'serve',
    configureServer(server) {
      const startupRuntime = findRuntime();
      if (!startupRuntime) {
        server.config.logger.warn(
          '[sidestage] React refresh runtime is missing; dependency topology guard is inactive.',
        );
        return;
      }

      let restartInFlight = false;
      let reportedInstallWindow = false;
      timer = setInterval(() => {
        if (restartInFlight || fileExists(startupRuntime)) return;

        const currentRuntime = findRuntime();
        if (!currentRuntime || !fileExists(currentRuntime)) {
          if (!reportedInstallWindow) {
            reportedInstallWindow = true;
            server.config.logger.warn(
              '[sidestage] React refresh runtime moved during an install; waiting for the replacement before restarting Vite.',
            );
          }
          return;
        }

        restartInFlight = true;
        server.config.logger.warn(
          `[sidestage] React refresh runtime re-hoisted from ${startupRuntime} to ${currentRuntime}; restarting Vite.`,
        );
        void server
          .restart(true)
          .catch((error: unknown) => {
            server.config.logger.error(
              `[sidestage] Vite restart after dependency re-hoist failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            restartInFlight = false;
          });
      }, intervalMs);
      timer.unref?.();
      server.httpServer?.once('close', stop);
    },
    closeBundle: stop,
  };
}

export const PUBLIC_ENTRY_BUDGET_BYTES = 500_000;

export interface PublicEntryArtifact {
  fileName: string;
  code: string;
}

export function publicEntryBudgetViolations(
  entries: readonly PublicEntryArtifact[],
  maxBytes = PUBLIC_ENTRY_BUDGET_BYTES,
): string[] {
  return entries.flatMap(({ fileName, code }) => {
    const violations: string[] = [];
    const bytes = Buffer.byteLength(code);
    if (bytes > maxBytes) {
      violations.push(`${fileName} is ${bytes} bytes; public entry budget is ${maxBytes} bytes`);
    }
    if (code.includes('js.stripe.com')) {
      violations.push(`${fileName} contains Stripe's remote loader; payment must stay lazy`);
    }
    return violations;
  });
}

export function createPublicEntryBudgetGuard(): Plugin {
  return {
    name: 'sidestage-public-entry-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle).flatMap((output) => (
        output.type === 'chunk' && output.isEntry
          ? [{ fileName: output.fileName, code: output.code }]
          : []
      ));
      const violations = publicEntryBudgetViolations(entries);
      if (violations.length > 0) {
        throw new Error(`SideStage public entry performance budget failed:\n${violations.join('\n')}`);
      }
    },
  };
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const candidate = value?.trim();
  if (!candidate) return fallback;

  const port = Number(candidate);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535; received ${candidate}`);
  }

  return port;
}

export function resolveDevServerEnvironment(env: Record<string, string | undefined>) {
  const webPort = parsePort(env.WEB_PORT, 5173, 'WEB_PORT');
  const apiPort = parsePort(env.API_PORT, 3110, 'API_PORT');
  const apiOrigin = (env.VITE_API_URL?.trim() || `http://localhost:${apiPort}`).replace(/\/+$/, '');

  return { apiOrigin, webPort };
}

/** Production keeps Nest under `/api`; local Nest is bare on :3110. */
export function stripDevApiPrefix(path: string): string {
  return path.replace(/^\/api(?=\/|$)/, '') || '/';
}

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
const environment = isTest
  ? {}
  : loadEnv(process.env.NODE_ENV ?? 'development', repositoryRoot, '');
const { apiOrigin, webPort } = resolveDevServerEnvironment(environment);

export default defineConfig({
  envDir: isTest ? false : repositoryRoot,
  plugins: [react(), createDependencyTopologyGuard(), createPublicEntryBudgetGuard()],
  server: {
    host: '0.0.0.0',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        rewrite: stripDevApiPrefix,
      },
    },
  },
});
