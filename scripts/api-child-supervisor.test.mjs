import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { superviseApiChild } from './api-child-supervisor.mjs';

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
