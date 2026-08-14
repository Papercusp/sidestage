import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

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
  const apiPort = parsePort(env.API_PORT, 3100, 'API_PORT');
  const apiOrigin = (env.VITE_API_URL?.trim() || `http://localhost:${apiPort}`).replace(/\/+$/, '');

  return { apiOrigin, webPort };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repositoryRoot, '');
  const { apiOrigin, webPort } = resolveDevServerEnvironment(env);

  return {
    envDir: repositoryRoot,
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': apiOrigin,
      },
    },
  };
});
