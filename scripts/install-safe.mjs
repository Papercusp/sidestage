#!/usr/bin/env node
/**
 * EI-20489608849476121 (writer half) — make `npm run install:safe` actually
 * serialize instead of dying on an unset environment variable.
 *
 * The script used to be, literally:
 *   node "$PAPERCUSP_REPO_ROOT/scripts/npm-install-safe.mjs" --repo-root . --
 * PAPERCUSP_REPO_ROOT is not set in the agent environment, so that expanded to
 * node "/scripts/npm-install-safe.mjs" and died MODULE_NOT_FOUND. The ONE
 * serialized install path this repo had therefore never ran even once, and
 * every install here raced the release gate — which is the writer half of the
 * incident this work item describes.
 *
 * This resolves the shared helper rather than reimplementing its mutex: the
 * installer's stale-owner reclaim and post-install verification are subtle and
 * must not be forked. When the helper genuinely cannot be found we FAIL LOUDLY
 * with the fix, because silently falling back to a bare `npm install` would
 * restore the exact race while looking like it worked.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELATIVE = join('scripts', 'npm-install-safe.mjs');

/** Ordered candidates; the env var stays the supported override. */
export function helperCandidates(env = process.env, home = homedir()) {
  return [
    env.PAPERCUSP_REPO_ROOT,
    join(home, 'papercupai-workspace', 'papercusp'),
    join(home, 'papercusp'),
  ]
    .filter((root) => typeof root === 'string' && root.trim().length > 0)
    .map((root) => resolve(root, RELATIVE));
}

export function resolveHelper(env = process.env, home = homedir(), exists = existsSync) {
  return helperCandidates(env, home).find((candidate) => exists(candidate)) ?? null;
}

export const NOT_FOUND_MESSAGE =
  'INSTALL_SAFE_HELPER_MISSING could not locate scripts/npm-install-safe.mjs in any known papercusp checkout. ' +
  'Set PAPERCUSP_REPO_ROOT to the papercusp repo root and retry. Refusing to fall back to a bare `npm install`: ' +
  'an unserialized install can empty node_modules under a running release gate (EI-20489608849476121).';

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('install-safe.mjs');
if (invokedDirectly) {
  const helper = resolveHelper();
  if (!helper) {
    console.error(NOT_FOUND_MESSAGE);
    process.exit(1);
  }
  // Hand off to the shared implementation, preserving forwarded npm args.
  process.argv = [process.argv[0], helper, '--repo-root', resolve('.'), '--', ...process.argv.slice(2)];
  await import(pathToFileURL(helper).href);
}
