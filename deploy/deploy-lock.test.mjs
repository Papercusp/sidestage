import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, 'deploy-lock.sh');
const deployScript = path.join(here, 'deploy.sh');
const rollbackScript = path.join(here, 'rollback.sh');
const temporaryDirectories = [];
const children = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function lockEnvironment(lockFile) {
  return { ...process.env, SIDESTAGE_DEPLOY_LOCK_FILE: lockFile };
}

function acquireScript(extra = '') {
  return `
    set -euo pipefail
    source ${JSON.stringify(helper)}
    sidestage_acquire_release_lock
    trap sidestage_release_release_lock EXIT
    ${extra}
  `;
}

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve(output);
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`process ended before emitting ${expected}: ${output}`));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}

describe('SideStage production release single-flight', () => {
  it('refuses a concurrent release process and releases the lock on exit', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sidestage-deploy-lock-test.'));
    temporaryDirectories.push(directory);
    const lockFile = path.join(directory, 'release.lock');

    const holder = spawn('bash', ['-c', acquireScript('echo LOCKED; while :; do sleep 1; done')], {
      env: lockEnvironment(lockFile),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(holder);
    await waitForLine(holder.stdout, 'LOCKED');

    const contender = spawnSync('bash', ['-c', acquireScript()], {
      env: lockEnvironment(lockFile),
      encoding: 'utf8',
    });
    expect(contender.status).toBe(75);
    expect(contender.stderr).toMatch(/another SideStage deploy or rollback is already running/);

    holder.kill('SIGTERM');
    await once(holder, 'exit');

    const successor = spawnSync('bash', ['-c', acquireScript()], {
      env: lockEnvironment(lockFile),
      encoding: 'utf8',
    });
    expect(successor.status).toBe(0);
  });

  it('is shared by deploy and rollback before their first production mutation', async () => {
    const { readFile } = await import('node:fs/promises');
    const deploy = await readFile(deployScript, 'utf8');
    const rollback = await readFile(rollbackScript, 'utf8');

    expect(deploy).toMatch(/source "\$SCRIPT_DIR\/deploy-lock\.sh"/);
    expect(rollback).toMatch(/source "\$SCRIPT_DIR\/deploy-lock\.sh"/);
    expect(deploy.indexOf('sidestage_acquire_release_lock')).toBeLessThan(
      deploy.indexOf('rsync -az --delete'),
    );
    expect(rollback.indexOf('sidestage_acquire_release_lock')).toBeLessThan(
      rollback.indexOf(
        '"${SSH[@]}" "cd $PROD_DIR && SIDESTAGE_SHA=$TARGET $COMPOSE up -d --no-build api web"',
      ),
    );
  });

  it('keeps the parent deploy lock held across its automatic rollback', async () => {
    const { readFile } = await import('node:fs/promises');
    const deploy = await readFile(deployScript, 'utf8');
    expect(deploy).toMatch(
      /SIDESTAGE_DEPLOY_LOCK_HELD=1 bash "\$SCRIPT_DIR\/rollback\.sh" --to "\$PREV_SHA"/,
    );
  });
});
