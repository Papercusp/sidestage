import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_API_STARTUP_GRACE_MS,
  findCgroupPid,
  readProcessCommandLine,
  superviseApiChild,
} from './api-child-supervisor.mjs';

const supervisorPath = resolve(new URL('./api-child-supervisor.mjs', import.meta.url).pathname);
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function waitForFile(path, timeoutMs = 3_000) {
  const startedAt = Date.now();
  return new Promise((resolveWait, reject) => {
    const poll = () => {
      if (existsSync(path)) return resolveWait(Number(readFileSync(path, 'utf8')));
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`Timed out waiting for ${path}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

describe('SideStage API child supervisor', () => {
  it('keeps a reparented API child in scope and ignores an unrelated cgroup match', () => {
    const commandLines = new Map([
      [101, 'node /srv/sidestage/src/main.ts'],
      [202, 'node /srv/Restart/apps/scout-service/src/main.ts'],
    ]);
    const cgroupProcesses = new Map([
      ['/user.slice/sidestage-dev.service', [101]],
      ['/user.slice/restart-scout.service', [202]],
    ]);

    const result = findCgroupPid(
      100,
      /(?:^|[\\s\\/])src[\\/]main\.ts(?:\\s|$)/,
      () => '/user.slice/sidestage-dev.service',
      (path) => cgroupProcesses.get(path) ?? [],
      () => [],
      (pid) => commandLines.get(pid) ?? '',
    );

    expect(result).toBe(101);
    expect(commandLines.has(202)).toBe(true);
  });

  it('recognizes the relative src/main.ts command used by tsx watch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sidestage-api-supervisor-relative-entrypoint-'));
    tempRoots.push(root);
    const sourceRoot = join(root, 'src');
    const childScript = join(sourceRoot, 'main.ts');
    const parentScript = join(root, 'relative-watcher.mjs');
    const pidFile = join(root, 'api-child.pid');

    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(childScript, 'setInterval(() => {}, 1_000);\n');
    writeFileSync(parentScript, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['src/main.ts'], {
        cwd: ${JSON.stringify(root)},
        stdio: 'ignore',
      });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1_000);
    `);

    const supervisorPromise = superviseApiChild({
      command: process.execPath,
      args: [parentScript],
      cwd: root,
      pollMs: 20,
      missingGraceMs: 100,
      startupGraceMs: 1_000,
      spawnOptions: { stdio: 'ignore' },
    });

    const childPid = await waitForFile(pidFile);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    process.kill(childPid, 'SIGTERM');
    const result = await supervisorPromise;

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('entrypoint disappeared');
  }, 10_000);

  it('keeps enough bounded startup grace for slow API bootstrap', async () => {
    expect(DEFAULT_API_STARTUP_GRACE_MS).toBeGreaterThan(15_000);

    const root = mkdtempSync(join(tmpdir(), 'sidestage-api-supervisor-slow-start-'));
    tempRoots.push(root);
    const childScript = join(root, 'api-child.mjs');
    const parentScript = join(root, 'slow-watcher.mjs');
    const pidFile = join(root, 'api-child.pid');
    let markEntrypointObserved;
    const entrypointObserved = new Promise((resolveObserved) => {
      markEntrypointObserved = resolveObserved;
    });

    writeFileSync(childScript, 'setInterval(() => {}, 1_000);\n');
    writeFileSync(parentScript, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      setTimeout(() => {
        const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' });
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      }, 250);
      setInterval(() => {}, 1_000);
    `);

    const supervisorPromise = superviseApiChild({
      command: process.execPath,
      args: [parentScript],
      cwd: root,
      entrypointPattern: 'api-child.mjs',
      pollMs: 20,
      missingGraceMs: 100,
      startupGraceMs: DEFAULT_API_STARTUP_GRACE_MS,
      spawnOptions: { stdio: 'ignore' },
      readCommandLine: (pid) => {
        const commandLine = readProcessCommandLine(pid);
        if (commandLine.includes(childScript)) markEntrypointObserved();
        return commandLine;
      },
    });

    const childPid = await waitForFile(pidFile);
    // The PID file proves the watcher spawned its child; it does NOT prove the
    // supervisor's polling loop observed it. Killing on that weaker signal
    // raced the first poll, leaving the supervisor correctly waiting through
    // its 60s startup grace while this test had a 10s ceiling.
    await entrypointObserved;
    process.kill(childPid, 'SIGTERM');
    const result = await supervisorPromise;

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('entrypoint disappeared');
  }, 10_000);

  it('terminates a persistent watcher when its API child disappears', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sidestage-api-supervisor-'));
    tempRoots.push(root);
    const childScript = join(root, 'api-child.mjs');
    const parentScript = join(root, 'persistent-watcher.mjs');
    const pidFile = join(root, 'api-child.pid');

    writeFileSync(childScript, 'setInterval(() => {}, 1_000);\n');
    writeFileSync(parentScript, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1_000);
    `);

    const supervisorPromise = superviseApiChild({
      command: process.execPath,
      args: [parentScript],
      cwd: root,
      entrypointPattern: 'api-child.mjs',
      pollMs: 20,
      missingGraceMs: 100,
      startupGraceMs: 2_000,
      spawnOptions: { stdio: 'ignore' },
    });

    const parentPid = await waitForFile(pidFile);
    process.kill(parentPid, 'SIGTERM');
    const result = await supervisorPromise;

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('entrypoint disappeared');
  }, 10_000);
});
