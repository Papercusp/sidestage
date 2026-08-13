import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadRepoEnv(
  cwd = process.cwd(),
  loadEnvFile: (path: string) => void = (path) => process.loadEnvFile(path),
): string | null {
  for (const candidate of [resolve(cwd, '.env'), resolve(cwd, '../../.env')]) {
    if (!existsSync(candidate)) continue;
    try {
      loadEnvFile(candidate);
      return candidate;
    } catch {
      // An unreadable .env should not stop the API; env vars simply stay unset.
      return null;
    }
  }
  return null;
}

export async function loadAppModule(
  importer: () => Promise<typeof import('./app.module')> = () => import('./app.module'),
) {
  return (await importer()).AppModule;
}
