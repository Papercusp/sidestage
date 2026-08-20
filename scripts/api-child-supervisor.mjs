#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const API_ENTRYPOINT_PATTERN = /(?:^|[\s\\/])src[\\/]main\.ts(?:\s|$)/;

export const DEFAULT_API_WATCH_ARGS = [
  'watch',
  '--exclude', '../../node_modules/**',
  '--exclude', '../../libs/**/dist/**',
  'src/main.ts',
];

// The API can spend more than 15 seconds in tsx/Nest bootstrap on a busy
// development host. Keep the startup failure bounded, but leave enough room
// for a legitimate slow start instead of turning transient load into a
// systemd restart loop.
export const DEFAULT_API_STARTUP_GRACE_MS = 60_000;

/**
 * Read the direct children of a process on Linux without shelling out to ps.
 * SideStage's local dev service runs under Linux systemd, and /proc gives us
 * the process-tree edge we need even when the watched entrypoint is gone.
 */
export function readProcessChildren(pid) {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    return children ? children.split(/\s+/).map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

export function readProcessCommandLine(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Return the unified cgroup-v2 path for a process. systemd user services on
 * the supported Linux development host use this path as their ownership
 * boundary; unlike a parent/child walk, it survives a child being reparented.
 */
export function readProcessCgroupPath(pid) {
  try {
    const entry = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('0::'));
    if (!entry) return null;
    const path = entry.slice(3).trim();
    return path || '/';
  } catch {
    return null;
  }
}

/**
 * Read process ids directly belonging to a unified cgroup. The path comes
 * from /proc, but reject traversal explicitly so a malformed proc fixture or
 * future caller can never turn this into an arbitrary filesystem read.
 */
export function readCgroupPids(cgroupPath) {
  if (typeof cgroupPath !== 'string' || !cgroupPath.startsWith('/')) return [];
  const segments = cgroupPath.split('/');
  if (segments.includes('..') || cgroupPath.includes('\0')) return [];

  try {
    const procPath = resolve('/sys/fs/cgroup', `.${cgroupPath}`, 'cgroup.procs');
    const contents = readFileSync(procPath, 'utf8').trim();
    return contents
      ? contents.split(/\s+/).map(Number).filter(Number.isInteger)
      : [];
  } catch {
    return [];
  }
}

function matchesEntrypoint(commandLine, pattern) {
  if (!commandLine) return false;
  if (typeof pattern === 'function') return pattern(commandLine);
  if (pattern instanceof RegExp) return pattern.test(commandLine);
  return commandLine.includes(pattern);
}

/**
 * Find a matching process below rootPid. The tsx watch process itself also
 * contains `src/main.ts` in its command line, so deliberately search only its
 * descendants; the actual API child is the process whose disappearance leaves
 * tsx watch alive forever.
 */
export function findDescendantPid(
  rootPid,
  pattern = API_ENTRYPOINT_PATTERN,
  readChildren = readProcessChildren,
  readCommandLine = readProcessCommandLine,
) {
  const queue = readChildren(rootPid);
  const visited = new Set([rootPid]);

  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid || visited.has(pid)) continue;
    visited.add(pid);

    if (matchesEntrypoint(readCommandLine(pid), pattern)) return pid;
    queue.push(...readChildren(pid));
  }

  return null;
}

/**
 * Find the entrypoint inside rootPid's cgroup, preferring descendants but
 * falling back to the cgroup membership list when the process was reparented.
 * The root process is excluded because tsx watch itself carries src/main.ts
 * in its command line. No process outside the owning cgroup is ever examined.
 */
export function findCgroupPid(
  rootPid,
  pattern = API_ENTRYPOINT_PATTERN,
  readCgroupPath = readProcessCgroupPath,
  readCgroupProcesses = readCgroupPids,
  readChildren = readProcessChildren,
  readCommandLine = readProcessCommandLine,
) {
  const cgroupPath = readCgroupPath(rootPid);
  if (!cgroupPath) return null;

  const cgroupPids = new Set(
    readCgroupProcesses(cgroupPath).filter((pid) => Number.isInteger(pid) && pid !== rootPid),
  );
  if (cgroupPids.size === 0) return null;

  const queue = readChildren(rootPid).filter((pid) => cgroupPids.has(pid));
  const visited = new Set([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid || visited.has(pid) || !cgroupPids.has(pid)) continue;
    visited.add(pid);

    if (matchesEntrypoint(readCommandLine(pid), pattern)) return pid;
    queue.push(...readChildren(pid).filter((childPid) => cgroupPids.has(childPid)));
  }

  // A child can leave the process tree while remaining in the service cgroup.
  // This is the recovery case the old descendant-only implementation missed.
  for (const pid of cgroupPids) {
    if (matchesEntrypoint(readCommandLine(pid), pattern)) return pid;
  }
  return null;
}

function findEntrypointPid(
  rootPid,
  pattern,
  readCgroupPath,
  readCgroupProcesses,
  readChildren,
  readCommandLine,
) {
  const cgroupPid = findCgroupPid(
    rootPid,
    pattern,
    readCgroupPath,
    readCgroupProcesses,
    readChildren,
    readCommandLine,
  );
  if (cgroupPid) return cgroupPid;

  // Keep non-Linux/test environments usable. This fallback is still scoped to
  // the watcher's descendants and is never a global command-line search.
  if (!readCgroupPath(rootPid)) {
    return findDescendantPid(rootPid, pattern, readChildren, readCommandLine);
  }
  return null;
}

/**
 * Run the API's tsx watcher while supervising the real API entrypoint below
 * it. tsx watch is a file watcher, not a crash supervisor: if its child is
 * killed externally, tsx remains alive and never starts the child again. Once
 * the entrypoint has been observed, a missing replacement beyond the short
 * reload grace window is therefore a fatal launcher failure. Exiting nonzero
 * lets concurrently -k stop Vite and systemd restart the complete dev pair.
 */
export function superviseApiChild({
  command = process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  args = DEFAULT_API_WATCH_ARGS,
  cwd = process.cwd(),
  entrypointPattern = API_ENTRYPOINT_PATTERN,
  pollMs = 100,
  missingGraceMs = 750,
  startupGraceMs = DEFAULT_API_STARTUP_GRACE_MS,
  spawnProcess = spawnChild,
  spawnOptions = { stdio: 'inherit' },
  readCgroupPath = readProcessCgroupPath,
  readCgroupProcesses = readCgroupPids,
  readChildren = readProcessChildren,
  readCommandLine = readProcessCommandLine,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  return new Promise((resolveResult) => {
    let worker;
    let settled = false;
    let shuttingDown = false;
    let guardReason = null;
    let pollTimer;
    let forceKillTimer;
    let trackedEntrypointPid = null;
    let missingSince = null;
    const startedAt = Date.now();

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveResult(result);
    };

    const terminateWorker = (signal = 'SIGTERM') => {
      if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
      try {
        worker.kill(signal);
      } catch {
        // The worker can exit between the liveness check and kill(). Its exit
        // event remains the authoritative completion signal.
      }
    };

    const failForMissingEntrypoint = () => {
      guardReason = `API entrypoint disappeared below ${command} without a replacement`;
      log(`[sidestage-api-supervisor] ${guardReason}; restarting the dev service`);
      terminateWorker('SIGTERM');
      forceKillTimer = setTimeout(() => terminateWorker('SIGKILL'), 1_000);
    };

    const pollEntrypoint = () => {
      if (settled || !worker?.pid || guardReason) return;

      const currentPid = findEntrypointPid(
        worker.pid,
        entrypointPattern,
        readCgroupPath,
        readCgroupProcesses,
        readChildren,
        readCommandLine,
      );

      if (currentPid) {
        trackedEntrypointPid = currentPid;
        missingSince = null;
        return;
      }

      const elapsed = Date.now() - startedAt;
      if (!trackedEntrypointPid) {
        if (elapsed >= startupGraceMs) {
          guardReason = `API entrypoint did not start within ${startupGraceMs}ms`;
          log(`[sidestage-api-supervisor] ${guardReason}`);
          terminateWorker('SIGTERM');
          forceKillTimer = setTimeout(() => terminateWorker('SIGKILL'), 1_000);
        }
        return;
      }

      missingSince ??= Date.now();
      if (Date.now() - missingSince >= missingGraceMs) failForMissingEntrypoint();
    };

    try {
      worker = spawnProcess(command, args, { cwd, ...spawnOptions });
    } catch (error) {
      settle({ exitCode: 1, signal: null, reason: error instanceof Error ? error.message : String(error) });
      return;
    }

    pollTimer = setInterval(pollEntrypoint, pollMs);
    worker.once('exit', (code, signal) => {
      settle({
        exitCode: guardReason ? 1 : (code ?? (signal ? 1 : 0)),
        signal,
        reason: guardReason ?? (shuttingDown ? 'shutdown' : 'watcher exited'),
      });
    });
    worker.once('error', (error) => {
      if (!guardReason) guardReason = error instanceof Error ? error.message : String(error);
      settle({ exitCode: 1, signal: null, reason: guardReason });
    });

    const forwardSignal = (signal) => {
      if (settled) return;
      shuttingDown = true;
      if (pollTimer) clearInterval(pollTimer);
      terminateWorker(signal);
    };
    process.once('SIGTERM', () => forwardSignal('SIGTERM'));
    process.once('SIGINT', () => forwardSignal('SIGINT'));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await superviseApiChild();
  process.exitCode = result.exitCode;
}
