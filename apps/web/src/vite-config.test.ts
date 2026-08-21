import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDependencyTopologyGuard,
  findNearestDependencyRuntime,
  resolveDevServerEnvironment,
  stripDevApiPrefix,
} from '../vite.config';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveDevServerEnvironment', () => {
  it('uses the reviewer-facing default ports', () => {
    expect(resolveDevServerEnvironment({})).toEqual({
      apiOrigin: 'http://localhost:3110',
      webPort: 5173,
    });
  });

  it('keeps concurrent dev servers isolated through environment overrides', () => {
    expect(
      resolveDevServerEnvironment({
        API_PORT: '3217',
        WEB_PORT: '5284',
      }),
    ).toEqual({
      apiOrigin: 'http://localhost:3217',
      webPort: 5284,
    });
  });

  it('honors an explicit API origin and removes trailing slashes', () => {
    expect(
      resolveDevServerEnvironment({
        API_PORT: '3217',
        VITE_API_URL: 'https://api.example.test///',
      }),
    ).toEqual({
      apiOrigin: 'https://api.example.test',
      webPort: 5173,
    });
  });

  it.each([
    ['WEB_PORT', '0'],
    ['WEB_PORT', '65536'],
    ['API_PORT', 'not-a-port'],
  ])('rejects an invalid %s value', (name, value) => {
    expect(() => resolveDevServerEnvironment({ [name]: value })).toThrow(
      `${name} must be an integer between 1 and 65535`,
    );
  });
});

describe('stripDevApiPrefix', () => {
  it('maps same-origin production API paths onto the bare local Nest routes', () => {
    expect(stripDevApiPrefix('/api/scout/chat/stream')).toBe('/scout/chat/stream');
    expect(stripDevApiPrefix('/api')).toBe('/');
    expect(stripDevApiPrefix('/catalog')).toBe('/catalog');
  });
});

describe('dependency topology guard', () => {
  it('restarts Vite after the React refresh runtime is re-hoisted', async () => {
    vi.useFakeTimers();
    const repository = mkdtempSync(join(tmpdir(), 'sidestage-vite-topology-'));
    temporaryDirectories.push(repository);
    const webRoot = join(repository, 'apps', 'web');
    const runtimeRelativePath = join(
      '@vitejs',
      'plugin-react',
      'dist',
      'refresh-runtime.js',
    );
    const rootRuntime = join(repository, 'node_modules', runtimeRelativePath);
    const workspaceRuntime = join(webRoot, 'node_modules', runtimeRelativePath);
    mkdirSync(join(rootRuntime, '..'), { recursive: true });
    mkdirSync(webRoot, { recursive: true });
    writeFileSync(rootRuntime, 'root runtime');

    const findRuntime = () =>
      findNearestDependencyRuntime(webRoot, repository, runtimeRelativePath);
    const restart = vi.fn(async () => undefined);
    const warn = vi.fn();
    const error = vi.fn();
    const plugin = createDependencyTopologyGuard({ intervalMs: 25, findRuntime });
    const configureServer = plugin.configureServer;
    if (typeof configureServer !== 'function') {
      throw new Error('dependency topology guard must configure the Vite dev server');
    }
    const postConfigureHook = await configureServer.call(
      {} as never,
      { restart, httpServer: null, config: { logger: { warn, error } } } as never,
    );
    expect(postConfigureHook).toBeUndefined();

    rmSync(join(repository, 'node_modules', '@vitejs', 'plugin-react'), {
      recursive: true,
      force: true,
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(restart).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('waiting for the replacement'));

    mkdirSync(join(workspaceRuntime, '..'), { recursive: true });
    writeFileSync(workspaceRuntime, 'workspace runtime');
    await vi.advanceTimersByTimeAsync(25);

    expect(restart).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-hoisted'));
    expect(error).not.toHaveBeenCalled();
    if (typeof plugin.closeBundle === 'function') {
      await plugin.closeBundle.call({} as never);
    }
  });
});
