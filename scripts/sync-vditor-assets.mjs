/**
 * Mirror the installed Vditor runtime into the web app's public directory.
 *
 * WHY THIS IS NOT `rm -rf && cp -r`
 * ---------------------------------
 * `apps/web/public/vditor` is served by a LONG-LIVED Vite dev server. Vite
 * keeps a `publicFiles` Set built once at startup and maintains it from
 * chokidar add/unlink events. When the watched DIRECTORY itself is deleted,
 * chokidar drops the subtree watch and never re-establishes it against the
 * replacement directory — so every asset under it becomes permanently
 * invisible to the running server and is answered with the SPA index.html
 * fallback instead. Vditor then cannot fetch `dist/js/lute/lute.min.js`, and
 * the plan viewer degrades to raw text with no error anywhere but the browser.
 *
 * The previous implementation did exactly that on every `predev`/`prebuild`,
 * so an unrelated `npm run build` in this checkout silently broke the History
 * tab's plan popup in an already-running dev server (WI-39341).
 *
 * The invariants that keep that from recurring:
 *   1. When the mirror is already current, mutate NOTHING and exit.
 *   2. When it is stale, copy over the existing tree in place and prune only
 *      entries that are absent from the source. Directories that exist in both
 *      are never recreated, so no live watch is ever dropped.
 *   3. `MIRROR_ROOT` (the directory Vite watches) is never removed.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The asset Vditor cannot start without; its absence means the mirror is unusable. */
export const SENTINEL_ASSET = join('dist', 'js', 'lute', 'lute.min.js');
export const STAMP_FILE = '.sync-stamp.json';

/**
 * Every path relative to `root`, files only, sorted for determinism.
 * Directories are represented by their contents, never as entries themselves,
 * because a directory that exists in both trees must never be touched.
 */
export function listFilesRecursively(root, current = root, found = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) listFilesRecursively(root, absolute, found);
    else found.push(relative(root, absolute));
  }
  return found.sort();
}

/** Directories under `root`, deepest first, so empties can be removed bottom-up. */
function listDirectoriesDeepestFirst(root, current = root, found = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const absolute = join(current, entry.name);
    listDirectoriesDeepestFirst(root, absolute, found);
    found.push(relative(root, absolute));
  }
  return found;
}

export function readInstalledVditorVersion(root = repositoryRoot) {
  const manifest = resolve(root, 'node_modules/vditor/package.json');
  return JSON.parse(readFileSync(manifest, 'utf8')).version;
}

export function readStamp(mirrorRoot) {
  try {
    return JSON.parse(readFileSync(join(mirrorRoot, STAMP_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * True only when the mirror can be left completely untouched: the stamp matches
 * the installed version AND the asset Vditor actually needs is present. The
 * second half matters because a half-copied mirror would otherwise be reported
 * current forever.
 */
export function mirrorIsCurrent(mirrorRoot, version) {
  const stamp = readStamp(mirrorRoot);
  if (!stamp || stamp.version !== version) return false;
  return existsSync(join(mirrorRoot, SENTINEL_ASSET));
}

/**
 * Bring `target` into line with `source` without ever removing `mirrorRoot`.
 * Returns the paths it pruned, for the caller to report and for tests to assert.
 */
export function mirrorInPlace(source, target) {
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });

  const sourceFiles = new Set(listFilesRecursively(source));
  const pruned = [];
  for (const file of listFilesRecursively(target)) {
    if (sourceFiles.has(file)) continue;
    rmSync(join(target, file), { force: true });
    pruned.push(file);
  }
  for (const directory of listDirectoriesDeepestFirst(target)) {
    const absolute = join(target, directory);
    if (existsSync(join(source, directory))) continue;
    if (readdirSync(absolute).length === 0) rmSync(absolute, { recursive: false, force: true });
  }
  return pruned;
}

export function syncVditorAssets({ root = repositoryRoot, log = () => {} } = {}) {
  const source = resolve(root, 'node_modules/vditor/dist');
  const mirrorRoot = resolve(root, 'apps/web/public/vditor');
  const target = join(mirrorRoot, 'dist');

  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`Vditor runtime assets were not found at ${source}; run npm install first.`);
  }

  const version = readInstalledVditorVersion(root);
  if (mirrorIsCurrent(mirrorRoot, version)) {
    log(`Vditor ${version} runtime assets already mirrored at ${target}; nothing to do.`);
    return { changed: false, version, pruned: [] };
  }

  const pruned = mirrorInPlace(source, target);
  writeFileSync(
    join(mirrorRoot, STAMP_FILE),
    `${JSON.stringify({ version, syncedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  log(
    `Mirrored Vditor ${version} runtime assets to ${target}`
    + (pruned.length ? ` (pruned ${pruned.length} stale file${pruned.length === 1 ? '' : 's'})` : ''),
  );
  return { changed: true, version, pruned };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  syncVditorAssets({ log: (line) => process.stdout.write(`${line}\n`) });
}
